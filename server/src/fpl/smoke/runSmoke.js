import * as schemas from '../schemas.js';
import { validate } from '../validate.js';
import { classifyResponse, classifyLeagueAccess, isUnreachable } from './classify.js';
import { evaluateHistory, combineSemantics } from './reconcileProbe.js';

// FPL API smoke test (architecture v0.2 §11, inherited by v0.3).
// Makes real requests, records HTTP metadata, validates against the current
// zod schemas and classifies every assumption as PASS / FAIL / UNVERIFIED.
// Pure orchestration: fetch, clock and sleep are injected; nothing is written here.

export const ENDPOINT_SCHEMA = Object.freeze({
  'bootstrap-static': 'bootstrapStatic',
  fixtures: 'fixtures',
  'event-status': 'eventStatus',
  'leagues-classic-standings': 'classicLeagueStandings',
  entry: 'entry',
  'entry-history': 'entryHistory',
  'entry-picks': 'entryPicks',
  'entry-transfers': 'entryTransfers',
  'event-live': 'eventLive',
});

export const EXIT = Object.freeze({ PASS: 0, SCHEMA_BREAK: 1, ASSUMPTION_FAILED: 2, NETWORK_OR_BLOCKED: 3 });

const PASS = 'PASS';
const FAIL = 'FAIL';
const UNVERIFIED = 'UNVERIFIED';

const NONEXISTENT_ENTRY_ID = 999_999_999;

export async function runSmoke({
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = 'https://fantasy.premierleague.com/api',
  leagues = [],
  entries = [],
  gw: requestedGw = null,
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  delayMs = 1000,
  timeoutMs = 15_000,
  maxStandingsPages = 5,
  userAgent = 'fpl-radar-smoke',
  ids, // createIdMap() instance, for report-safe aliases
}) {
  const run = {
    startedAt: now().toISOString(),
    inputs: { leagues: leagues.map(ids.leagueAlias), entries: entries.map(ids.entryAlias), requestedGw },
    requests: [],
    checks: [],
    schema: {}, // endpoint -> [{ path, issues }]
    bodies: {}, // endpoint -> [raw bodies] (for shapes/samples; never written unanonymized)
    notAttempted: [],
    season: null,
    gw: null,
    gwSource: null,
  };
  const check = (id, endpoint, title, status, detail) => run.checks.push({ id, endpoint, title, status, detail });
  let first = true;

  async function request(endpoint, path, alias, { mayRequireAuth = false } = {}) {
    if (!first) await sleep(delayMs);
    first = false;
    const url = `${baseUrl}${path}`;
    const started = performance.now();
    const meta = { endpoint, path: alias ?? path };
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': userAgent },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      Object.assign(meta, {
        classification: 'NETWORK',
        error: `${err.name}: ${err.cause?.code ?? err.message}`,
        durationMs: Math.round(performance.now() - started),
      });
      run.requests.push(meta);
      return { ...meta };
    }
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    Object.assign(meta, {
      status: res.status,
      contentType,
      cacheControl: res.headers.get('cache-control'),
      cloudflare: res.headers.has('cf-ray'),
      location: res.headers.get('location'),
      bytes: Buffer.byteLength(text),
      durationMs: Math.round(performance.now() - started),
    });
    meta.denyReason = res.headers.get('x-deny-reason') ?? undefined;
    meta.classification = classifyResponse({ status: res.status, contentType, text, json, denyReason: meta.denyReason, mayRequireAuth });
    meta.gameUpdating = meta.classification === 'UPDATING';

    if (meta.classification === 'OK') {
      const schemaName = ENDPOINT_SCHEMA[endpoint];
      const { ok, issues } = validate(schemas[schemaName], json);
      meta.schemaOk = ok;
      if (!ok) (run.schema[endpoint] ??= []).push({ path: meta.path, issues });
      (run.bodies[endpoint] ??= []).push(json);
    }
    run.requests.push(meta);
    return { ...meta, text, json };
  }

  const skip = (endpoint, reason) => run.notAttempted.push({ endpoint, reason });

  // ── bootstrap-static ──────────────────────────────────────────────
  const boot = await request('bootstrap-static', '/bootstrap-static/');
  const bootstrap = boot.classification === 'OK' ? boot.json : null;
  if (bootstrap) {
    const events = Array.isArray(bootstrap.events) ? bootstrap.events : [];
    const reqEventKeys = ['id', 'deadline_time', 'finished', 'data_checked', 'is_current', 'is_next'];
    const missing = events.filter((e) => reqEventKeys.some((k) => !(k in e))).map((e) => e.id);
    check('B1', 'bootstrap-static', '38 events with id, deadline_time, finished, data_checked, is_current, is_next',
      events.length === 38 && missing.length === 0 ? PASS : FAIL,
      `events=${events.length}; missing keys on events: ${missing.length ? missing.join(',') : 'none'}`);
    const current = events.filter((e) => e.is_current === true);
    check('B2', 'bootstrap-static', 'Exactly one is_current (or none pre-season)',
      current.length <= 1 ? PASS : FAIL, `is_current count=${current.length}`);
    const teams = Array.isArray(bootstrap.teams) ? bootstrap.teams.length : 0;
    check('B3', 'bootstrap-static', '20 teams', teams === 20 ? PASS : FAIL, `teams=${teams}`);
    const elements = Array.isArray(bootstrap.elements) ? bootstrap.elements : [];
    const badType = elements.filter((e) => !(Number.isInteger(e.element_type) && e.element_type >= 1 && e.element_type <= 4));
    const reqElKeys = ['id', 'web_name', 'team', 'element_type', 'now_cost'];
    const missingEl = elements.filter((e) => reqElKeys.some((k) => !(k in e)));
    check('B4', 'bootstrap-static', 'elements[] required fields; element_type in 1..4',
      elements.length > 0 && badType.length === 0 && missingEl.length === 0 ? PASS : FAIL,
      `elements=${elements.length}; bad element_type=${badType.length}; missing required keys=${missingEl.length}`);
    check('B5', 'bootstrap-static', 'chips[] present with valid windows (v0.2 §8)', ...chipRulesVerdict(bootstrap.chips));
    const firstDeadline = events[0]?.deadline_time ? new Date(events[0].deadline_time) : null;
    if (firstDeadline && !Number.isNaN(firstDeadline.getTime())) {
      const y = firstDeadline.getUTCFullYear();
      run.season = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
      check('B6', 'bootstrap-static', 'Derived season string', PASS, run.season);
    } else {
      check('B6', 'bootstrap-static', 'Derived season string', FAIL, 'events[0].deadline_time missing or unparseable');
    }

    if (requestedGw) {
      run.gw = requestedGw;
      run.gwSource = '--gw';
    } else {
      const checked = events.filter((e) => e.data_checked === true).map((e) => e.id);
      run.gw = checked.length ? Math.max(...checked) : (current[0]?.id ?? null);
      run.gwSource = checked.length ? 'latest data_checked event' : 'is_current event';
    }
    const ev = events.find((e) => e.id === run.gw);
    if (ev) {
      const coherent = !(ev.data_checked === true && ev.finished !== true);
      check('B7', 'bootstrap-static', 'Selected GW event flags (finished / data_checked)',
        coherent ? (ev.finished && ev.data_checked ? PASS : UNVERIFIED) : FAIL,
        `GW${ev.id}: finished=${ev.finished}, data_checked=${ev.data_checked}, is_current=${ev.is_current}` +
          (coherent ? '' : ' — data_checked true while finished false'));
    } else {
      check('B7', 'bootstrap-static', 'Selected GW event flags (finished / data_checked)', UNVERIFIED, 'no gameweek selected');
    }
  } else {
    run.gw = requestedGw;
    run.gwSource = requestedGw ? '--gw' : null;
    for (const id of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']) {
      check(id, 'bootstrap-static', 'bootstrap-static checks', UNVERIFIED, `request ${describeFailure(boot)}`);
    }
  }
  const gw = run.gw;

  // ── fixtures ──────────────────────────────────────────────────────
  const fx = await request('fixtures', '/fixtures/');
  if (fx.classification === 'OK' && Array.isArray(fx.json)) {
    const keys = ['event', 'team_h', 'team_a', 'team_h_difficulty', 'team_a_difficulty', 'kickoff_time', 'started', 'finished', 'finished_provisional'];
    const missing = keys.filter((k) => fx.json.some((f) => !(k in f)));
    check('F1', 'fixtures', `Fields ${keys.join(', ')}`, missing.length ? FAIL : PASS,
      `fixtures=${fx.json.length}; missing on some rows: ${missing.join(', ') || 'none'}`);
    const nullEvents = fx.json.filter((f) => f.event === null).length;
    check('F2', 'fixtures', 'event is nullable (unscheduled fixtures)', nullEvents > 0 ? PASS : UNVERIFIED,
      nullEvents > 0 ? `${nullEvents} fixtures with event=null` : 'no event=null fixture observed (none unscheduled right now)');
  } else {
    check('F1', 'fixtures', 'fixtures fields', UNVERIFIED, `request ${describeFailure(fx)}`);
    check('F2', 'fixtures', 'event is nullable', UNVERIFIED, `request ${describeFailure(fx)}`);
  }
  if (gw) {
    const fxGw = await request('fixtures', `/fixtures/?event=${gw}`);
    if (fxGw.classification === 'OK' && Array.isArray(fxGw.json)) {
      const others = fxGw.json.filter((f) => f.event !== gw).length;
      check('F3', 'fixtures', '?event=gw returns only that GW', fxGw.json.length > 0 && others === 0 ? PASS : FAIL,
        `GW${gw}: ${fxGw.json.length} fixtures, ${others} from other GWs`);
    } else {
      check('F3', 'fixtures', '?event=gw filter', UNVERIFIED, `request ${describeFailure(fxGw)}`);
    }
  } else {
    skip('fixtures?event', 'no gameweek known (bootstrap unavailable and no --gw)');
    check('F3', 'fixtures', '?event=gw filter', UNVERIFIED, 'no gameweek known');
  }

  // ── event-status ──────────────────────────────────────────────────
  const es = await request('event-status', '/event-status/');
  if (es.classification === 'OK') {
    const status = Array.isArray(es.json?.status) ? es.json.status : null;
    const missing = status ? ['event', 'bonus_added', 'points'].filter((k) => status.some((s) => !(k in s))) : ['status[]'];
    check('S1', 'event-status', 'status[] with event, bonus_added, points', status && missing.length === 0 ? PASS : FAIL,
      status ? `rows=${status.length}; missing: ${missing.join(', ') || 'none'}; points values seen: ${[...new Set(status.map((s) => JSON.stringify(s.points)))].join(', ')}` : 'status is not an array');
    check('S2', 'event-status', 'leagues value recorded verbatim', 'leagues' in (es.json ?? {}) ? PASS : FAIL,
      `leagues=${JSON.stringify(es.json?.leagues)}`);
  } else {
    check('S1', 'event-status', 'status[] fields', UNVERIFIED, `request ${describeFailure(es)}`);
    check('S2', 'event-status', 'leagues value', UNVERIFIED, `request ${describeFailure(es)}`);
  }

  // ── leagues-classic standings ─────────────────────────────────────
  if (leagues.length === 0) {
    skip('leagues-classic-standings', 'no --league given');
    for (const id of ['L1', 'L2', 'L3']) check(id, 'leagues-classic-standings', 'standings checks', UNVERIFIED, 'no --league given');
  }
  for (const leagueId of leagues) {
    const alias = ids.leagueAlias(leagueId);
    const pages = [];
    let page = 1;
    let res = await request('leagues-classic-standings', `/leagues-classic/${leagueId}/standings/?page_standings=1`,
      `/leagues-classic/{${alias}}/standings/?page_standings=1`, { mayRequireAuth: true });
    const access = classifyLeagueAccess(res);
    check('L1', 'leagues-classic-standings', `${alias}: anonymous access classification`,
      access === 'OK' ? PASS : isUnreachable(access) ? UNVERIFIED : FAIL,
      access === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED → group must use MANUAL member source (v0.2 §10); no FPL login' : access);
    if (access !== 'OK') continue;
    pages.push(res.json);
    const s = res.json.standings ?? {};
    const results = s.results ?? [];
    const fieldMissing = ['entry', 'entry_name', 'player_name'].filter((k) => results.some((r) => !(k in r)));
    check('L2', 'leagues-classic-standings', `${alias}: league.id/name, results[].entry/entry_name/player_name, has_next`,
      res.json.league?.id !== undefined && typeof res.json.league?.name === 'string' && 'has_next' in s && fieldMissing.length === 0 ? PASS : FAIL,
      `missing: ${fieldMissing.join(', ') || 'none'}; has_next=${s.has_next}`);
    while (res.json?.standings?.has_next === true && page < maxStandingsPages) {
      page += 1;
      res = await request('leagues-classic-standings', `/leagues-classic/${leagueId}/standings/?page_standings=${page}`,
        `/leagues-classic/{${alias}}/standings/?page_standings=${page}`);
      if (res.classification !== 'OK') break;
      pages.push(res.json);
    }
    const pageSize = pages[0].standings.results.length;
    const all = pages.flatMap((p) => p.standings?.results ?? []).map((r) => r.entry);
    const dupes = all.length - new Set(all).size;
    const pageNumbersOk = pages.every((p, i) => p.standings?.page === i + 1);
    const lastHasNext = pages.at(-1).standings?.has_next;
    if (pages.length > 1) {
      check('L3', 'leagues-classic-standings', `${alias}: pagination`, dupes === 0 && pageNumbersOk ? PASS : FAIL,
        `pages fetched=${pages.length}, page size=${pageSize}, members seen=${all.length}, duplicates=${dupes}, page numbers ok=${pageNumbersOk}, last has_next=${lastHasNext}`);
    } else {
      check('L3', 'leagues-classic-standings', `${alias}: pagination`, UNVERIFIED,
        `single page (${pageSize} members, has_next=false); multi-page behaviour not exercised by this league`);
    }
  }

  // ── entries ───────────────────────────────────────────────────────
  if (entries.length === 0) {
    for (const ep of ['entry', 'entry-history', 'entry-picks', 'entry-transfers']) skip(ep, 'no --entry given');
    for (const id of ['E1', 'E2', 'H1', 'H2', 'H3', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'T1', 'T2', 'T3']) {
      check(id, id[0] === 'E' ? 'entry' : id[0] === 'H' ? 'entry-history' : id[0] === 'P' ? 'entry-picks' : 'entry-transfers',
        'entry checks', UNVERIFIED, 'no --entry given');
    }
  }
  const histories = [];
  const picksByEntry = new Map();
  const liveNeeded = new Set();
  for (const entryId of entries) {
    const alias = ids.entryAlias(entryId);
    const e = await request('entry', `/entry/${entryId}/`, `/entry/{${alias}}/`);
    if (e.classification === 'OK') {
      const missing = ['player_first_name', 'player_last_name', 'name'].filter((k) => !(k in e.json));
      check('E1', 'entry', `${alias}: player_first_name, player_last_name, name`, missing.length ? FAIL : PASS, `missing: ${missing.join(', ') || 'none'}`);
    } else {
      check('E1', 'entry', `${alias}: profile fields`, UNVERIFIED, `request ${describeFailure(e)}`);
    }

    const h = await request('entry-history', `/entry/${entryId}/history/`, `/entry/{${alias}}/history/`);
    let historyRow = null;
    if (h.classification === 'OK' && Array.isArray(h.json?.current)) {
      const missing = ['event', 'points', 'total_points', 'event_transfers_cost'].filter((k) => h.json.current.some((r) => !(k in r)));
      check('H1', 'entry-history', `${alias}: current[] points, total_points, event_transfers_cost`, missing.length ? FAIL : PASS,
        `rows=${h.json.current.length}; missing: ${missing.join(', ') || 'none'}`);
      const chipNames = Array.isArray(h.json.chips) ? [...new Set(h.json.chips.map((c) => c.name))] : null;
      check('H2', 'entry-history', `${alias}: chips[] names seen`, chipNames ? PASS : FAIL,
        chipNames ? (chipNames.length ? chipNames.join(', ') : 'no chips played yet') : 'chips[] missing');
      const probe = evaluateHistory(h.json.current);
      histories.push({ alias, probe, chips: h.json.chips ?? [] });
      historyRow = h.json.current.find((r) => r.event === gw) ?? null;
    } else {
      check('H1', 'entry-history', `${alias}: history fields`, UNVERIFIED, `request ${describeFailure(h)}`);
    }

    if (gw) {
      const p = await request('entry-picks', `/entry/${entryId}/event/${gw}/picks/`, `/entry/{${alias}}/event/${gw}/picks/`);
      if (p.classification === 'OK' && Array.isArray(p.json?.picks)) {
        picksByEntry.set(entryId, { alias, body: p.json, historyRow });
        for (const pk of p.json.picks) liveNeeded.add(pk.element);
        check('P1', 'entry-picks', `${alias}: 15 picks, positions 1–15 unique, one captain + one vice`, ...picksStructureVerdict(p.json.picks));
        check('P2', 'entry-picks', `${alias}: active_chip value`, 'active_chip' in p.json ? PASS : FAIL, `active_chip=${JSON.stringify(p.json.active_chip)}`);
        const subs = p.json.automatic_subs;
        check('P3', 'entry-picks', `${alias}: automatic_subs[] shape`,
          Array.isArray(subs) && subs.every((s) => 'element_in' in s && 'element_out' in s) ? PASS : FAIL,
          Array.isArray(subs) ? `${subs.length} auto-subs; keys: ${[...new Set(subs.flatMap((s) => Object.keys(s)))].join(', ') || '(none observed)'}` : 'automatic_subs missing');
        if (historyRow) {
          const same = p.json.entry_history?.points === historyRow.points;
          check('P4', 'entry-picks', `${alias}: entry_history.points equals history points (GW${gw})`, same ? PASS : FAIL,
            `picks=${p.json.entry_history?.points}, history=${historyRow.points}`);
        } else {
          check('P4', 'entry-picks', `${alias}: entry_history.points equals history points`, UNVERIFIED, `no history row for GW${gw}`);
        }
      } else {
        check('P1', 'entry-picks', `${alias}: picks`, UNVERIFIED, `request ${describeFailure(p)}`);
      }
    }

    const t = await request('entry-transfers', `/entry/${entryId}/transfers/`, `/entry/{${alias}}/transfers/`);
    if (t.classification === 'OK' && Array.isArray(t.json)) {
      const keys = ['element_in', 'element_out', 'element_in_cost', 'element_out_cost', 'event', 'time'];
      const missing = keys.filter((k) => t.json.some((r) => !(k in r)));
      check('T1', 'entry-transfers', `${alias}: ${keys.join(', ')}`,
        t.json.length === 0 ? UNVERIFIED : missing.length ? FAIL : PASS,
        t.json.length === 0 ? 'no transfers made yet' : `transfers=${t.json.length}; missing: ${missing.join(', ') || 'none'}`);
      const costs = t.json.flatMap((r) => [r.element_in_cost, r.element_out_cost]);
      const tenths = costs.every((c) => Number.isInteger(c) && c >= 30 && c <= 200);
      check('T2', 'entry-transfers', `${alias}: costs are integer tenths`, t.json.length === 0 ? UNVERIFIED : tenths ? PASS : FAIL,
        t.json.length ? `range ${Math.min(...costs)}–${Math.max(...costs)}` : 'no transfers');
      const hist = histories.find((x) => x.alias === alias);
      const wcfh = (hist?.chips ?? []).filter((c) => c.name === 'wildcard' || c.name === 'freehit');
      if (wcfh.length) {
        const seen = wcfh.map((c) => `${c.name}@GW${c.event}: ${t.json.filter((r) => r.event === c.event).length} transfers listed`);
        check('T3', 'entry-transfers', `${alias}: whether wildcard/free-hit GWs appear`, PASS, seen.join('; '));
      } else {
        check('T3', 'entry-transfers', `${alias}: whether wildcard/free-hit GWs appear`, UNVERIFIED, 'entry has not played wildcard/freehit');
      }
    } else {
      check('T1', 'entry-transfers', `${alias}: transfers`, UNVERIFIED, `request ${describeFailure(t)}`);
    }
  }

  // Reconciliation semantics across all sampled entries.
  if (histories.length) {
    const combined = combineSemantics(histories.map((h) => h.probe));
    const perEntry = histories.map((h) => `${h.alias}: ${h.probe.semantics} (gross=${h.probe.evidence.gross}, net=${h.probe.evidence.net}, mismatch=${h.probe.evidence.mismatch}, incomplete=${h.probe.evidence.incomplete})`);
    const status = combined.semantics === 'CONFLICTED' || combined.evidence.mismatch > 0 ? FAIL
      : combined.semantics === 'UNVERIFIED' ? UNVERIFIED : PASS;
    check('H3', 'entry-history', 'Points reconciliation semantics (v0.2 §2)', status,
      `season semantics=${combined.semantics}; ${perEntry.join('; ')}` +
        (combined.semantics === 'UNVERIFIED' ? ' — no row with event_transfers_cost > 0: pass an --entry that took a hit' : ''));
    run.reconciliation = { combined, perEntry: histories.map((h) => ({ alias: h.alias, ...h.probe })) };
  }

  // Next-GW picks before its deadline.
  const nextEvent = bootstrap?.events?.find((e) => e.is_next === true);
  if (entries.length && nextEvent && new Date(nextEvent.deadline_time) > now()) {
    const alias = ids.entryAlias(entries[0]);
    const n = await request('entry-picks', `/entry/${entries[0]}/event/${nextEvent.id}/picks/`, `/entry/{${alias}}/event/${nextEvent.id}/picks/ (before deadline)`, { mayRequireAuth: true });
    check('P6', 'entry-picks', `Next GW picks before deadline (GW${nextEvent.id})`, isUnreachable(n.classification) ? UNVERIFIED : PASS,
      `status=${n.status ?? n.classification}; body=${n.json ? `keys: ${Object.keys(n.json).join(', ')}` : (n.text ?? '').slice(0, 120)}`);
  } else if (entries.length) {
    check('P6', 'entry-picks', 'Next GW picks before deadline', UNVERIFIED, 'no upcoming deadline known');
  }

  // ── event live ────────────────────────────────────────────────────
  if (gw) {
    const live = await request('event-live', `/event/${gw}/live/`);
    if (live.classification === 'OK' && Array.isArray(live.json?.elements)) {
      const els = live.json.elements;
      const missing = els.some((e) => !('id' in e) || !('total_points' in (e.stats ?? {})) || !('minutes' in (e.stats ?? {})));
      check('V1', 'event-live', 'elements[].id, stats.total_points, stats.minutes', missing ? FAIL : PASS, `elements=${els.length}`);
      const explainKeys = [...new Set(els.flatMap((e) => (Array.isArray(e.explain) ? e.explain.flatMap((x) => Object.keys(x)) : [])))];
      check('V2', 'event-live', 'explain[] shape per fixture', els.every((e) => Array.isArray(e.explain)) ? PASS : FAIL,
        `explain item keys: ${explainKeys.join(', ') || '(none)'}`);
      const byId = new Map(els.map((e) => [e.id, e.stats?.total_points]));
      for (const [, { alias, body }] of picksByEntry) {
        const sum = body.picks.reduce((acc, pk) => acc + pk.multiplier * (byId.get(pk.element) ?? 0), 0);
        const reported = body.entry_history?.points;
        check('P5', 'entry-picks', `${alias}: Σ FPL multiplier × live total_points = picks points`,
          sum === reported ? PASS : FAIL,
          `Σ=${sum}, entry_history.points=${reported}; active_chip=${JSON.stringify(body.active_chip)}, auto-subs=${body.automatic_subs?.length ?? 0}; ` +
            `captain multiplier=${body.picks.find((pk) => pk.is_captain)?.multiplier}, bench multipliers=${body.picks.filter((pk) => pk.position > 11).map((pk) => pk.multiplier).join('/')}`);
      }
      check('V3', 'event-live', 'Σ engine effective multiplier × total_points = gross', UNVERIFIED,
        'needs deriveEffectiveSquad (Step 3); P5 records the same identity using FPL multipliers');
      run.liveKeepIds = liveNeeded;
    } else {
      check('V1', 'event-live', 'live fields', UNVERIFIED, `request ${describeFailure(live)}`);
    }
  } else {
    skip('event-live', 'no gameweek known (bootstrap unavailable and no --gw)');
    check('V1', 'event-live', 'live fields', UNVERIFIED, 'no gameweek known');
  }

  // Entry 404 behaviour.
  {
    const nf = await request('entry', `/entry/${NONEXISTENT_ENTRY_ID}/`, '/entry/{nonexistent}/');
    check('E2', 'entry', '404 for a nonexistent entry ID', nf.status === 404 ? PASS : isUnreachable(nf.classification) ? UNVERIFIED : FAIL,
      `status=${nf.status ?? nf.classification}`);
  }

  run.finishedAt = now().toISOString();
  Object.assign(run, verdict(run));
  return run;
}

function verdict(run) {
  const unreachable = run.requests.filter((r) => isUnreachable(r.classification));
  if (unreachable.length) {
    return {
      exitCode: EXIT.NETWORK_OR_BLOCKED,
      exitReason: `${unreachable.length} request(s) could not reach FPL: ${[...new Set(unreachable.map((r) => `${r.path} (${r.classification}${r.error ? `: ${r.error}` : ''})`))].join('; ')}`,
    };
  }
  const breaks = Object.keys(run.schema);
  if (breaks.length) return { exitCode: EXIT.SCHEMA_BREAK, exitReason: `schema break on: ${breaks.join(', ')}` };
  const failed = run.checks.filter((c) => c.status === FAIL);
  const unverified = run.checks.filter((c) => c.status === UNVERIFIED);
  if (failed.length || unverified.length) {
    return {
      exitCode: EXIT.ASSUMPTION_FAILED,
      exitReason: `${failed.length} FAIL, ${unverified.length} UNVERIFIED (every assumption must be decided before M2)`,
    };
  }
  return { exitCode: EXIT.PASS, exitReason: 'all checks passed' };
}

function describeFailure(res) {
  if (!res) return 'not made';
  return `failed: ${res.classification}${res.status ? ` (HTTP ${res.status})` : ''}${res.error ? ` ${res.error}` : ''}`;
}

function picksStructureVerdict(picks) {
  const positions = picks.map((p) => p.position);
  const okCount = picks.length === 15;
  const okPositions = new Set(positions).size === 15 && positions.every((p) => p >= 1 && p <= 15);
  const captains = picks.filter((p) => p.is_captain).length;
  const vices = picks.filter((p) => p.is_vice_captain).length;
  const ok = okCount && okPositions && captains === 1 && vices === 1;
  return [ok ? PASS : FAIL, `picks=${picks.length}, unique positions 1–15=${okPositions}, captains=${captains}, vices=${vices}`];
}

// v0.2 §8 chip rule validation.
export function chipRulesVerdict(chips) {
  if (!Array.isArray(chips)) return [FAIL, 'chips[] absent → config fallback (CONFIG_FALLBACK) would be required'];
  if (chips.length === 0) return [FAIL, 'chips[] empty → config fallback would be required'];
  const problems = [];
  for (const c of chips) {
    if (typeof c.name !== 'string') problems.push('name not a string');
    if (!(Number.isInteger(c.number) && c.number >= 1)) problems.push(`${c.name}: number=${c.number}`);
    if (!(Number.isInteger(c.start_event) && Number.isInteger(c.stop_event) && c.start_event >= 1 && c.start_event <= c.stop_event && c.stop_event <= 38)) {
      problems.push(`${c.name}: window ${c.start_event}–${c.stop_event}`);
    }
  }
  const byName = new Map();
  for (const c of chips) (byName.get(c.name) ?? byName.set(c.name, []).get(c.name)).push(c);
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => a.start_event - b.start_event);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start_event <= sorted[i - 1].stop_event) problems.push(`${name}: overlapping windows`);
    }
  }
  const summary = chips.map((c) => `${c.name} ${c.start_event}–${c.stop_event} ×${c.number}`).join(', ');
  return problems.length ? [FAIL, `invalid: ${problems.join('; ')}`] : [PASS, summary];
}
