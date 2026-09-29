import { deriveEventState, reconcileSeason, validateChipRules } from '../analytics/index.js';
import { pickViolations } from '../models/validation/picks.js';
import { pointsFromNormalized } from '../repositories/mappers/managerGameweek.js';
import { SyncStageError, FailureCode } from './classify.js';

// FPL responses → domain values for the repositories (architecture v0.2 §15,
// v0.3 §6). Pure: `now` is passed in; nothing here reads the clock or the DB.
// Anything that is not a function of the FPL responses (first-observed
// timestamps, picks of other GWs) is carried forward from what is stored, so a
// replay of identical responses produces identical documents.

const toDate = (s) => (s == null ? null : new Date(s));

/** '2026-27' from the year of GW1's deadline (FPL IDs are season-scoped, v0.3 A8). */
export function seasonOfBootstrap(bootstrap) {
  const gw1 = bootstrap.events.find((e) => e.id === 1);
  if (!gw1) throw new SyncStageError('SEASON_UNKNOWN', 'bootstrap has no GW1');
  const y = new Date(gw1.deadline_time).getUTCFullYear();
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export const fixtureOf = (f) => ({
  id: f.id,
  teamH: f.team_h,
  teamA: f.team_a,
  teamHFdr: f.team_h_difficulty ?? null,
  teamAFdr: f.team_a_difficulty ?? null,
  kickoffTime: toDate(f.kickoff_time),
  started: f.started,
  finished: f.finished,
  finishedProvisional: f.finished_provisional,
  teamHScore: f.team_h_score ?? null,
  teamAScore: f.team_a_score ?? null,
});

const byId = (a, b) => a.id - b.id;

/**
 * Events with derived state and fixtures (every event's fixtures rebuilt from
 * the full list, so a moved fixture leaves its old GW), plus unscheduled
 * fixtures. dataCheckedObservedAt is set the first time data_checked is seen
 * (to `observedAt`), kept while it stays true, and cleared if it reverts.
 * @param {Map<number, { dataCheckedObservedAt: Date|null }>} existing  stored events by gw
 */
export function buildEvents({ season, bootstrap, fixtures, now, observedAt = now, existing = new Map() }) {
  const byEvent = new Map();
  const unscheduled = [];
  for (const f of fixtures) {
    if (f.event == null) unscheduled.push(fixtureOf(f));
    else byEvent.set(f.event, [...(byEvent.get(f.event) ?? []), f]);
  }
  const events = [...bootstrap.events].sort(byId).map((e) => {
    const eventFixtures = (byEvent.get(e.id) ?? []).sort(byId);
    const state = deriveEventState(
      { id: e.id, deadlineTime: e.deadline_time, finished: e.finished, dataChecked: e.data_checked },
      eventFixtures.map((f) => ({ event: f.event, finished: f.finished, finishedProvisional: f.finished_provisional })),
      now,
    );
    const prev = existing.get(e.id)?.dataCheckedObservedAt ?? null;
    return {
      season,
      gw: e.id,
      deadlineTime: new Date(e.deadline_time),
      isCurrent: e.is_current,
      isNext: e.is_next,
      finished: e.finished,
      dataChecked: e.data_checked,
      state,
      dataCheckedObservedAt: e.data_checked ? (prev ?? observedAt) : null,
      fixtures: eventFixtures.map(fixtureOf),
    };
  });
  return { events, unscheduledFixtures: unscheduled.sort(byId) };
}

export const teamsOf = (bootstrap) => [...bootstrap.teams].sort(byId).map((t) => ({ id: t.id, name: t.name, shortName: t.short_name }));

export const playersOf = (bootstrap, season) => [...bootstrap.elements].sort(byId).map((p) => ({
  season,
  elementId: p.id,
  webName: p.web_name,
  teamId: p.team,
  elementType: p.element_type,
  priceTenths: p.now_cost,
  status: typeof p.status === 'string' ? p.status : null,
  epNextTenths: tenthsOf(p.ep_next),
}));

/** FPL decimal strings ("6.0") → integer tenths; anything unparsable → null. */
export function tenthsOf(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) : null;
}

/** bootstrap chips[] → { valid, chipRules?, problems } (v0.2 §8: whole set or nothing). */
export function chipRulesOf(bootstrap) {
  const v = validateChipRules(bootstrap.chips);
  if (!v.valid) return { valid: false, problems: v.problems };
  return { valid: true, chipRules: { source: 'FPL_BOOTSTRAP', rules: v.rules.map((r) => ({ ...r, chipType: r.chipType ?? null })) }, problems: [] };
}

export const profileFromEntry = (entry) => ({
  entryId: entry.id,
  playerName: `${entry.player_first_name} ${entry.player_last_name}`.trim(),
  teamName: entry.name,
});

export const profileFromStandings = (row) => ({ entryId: row.entry, playerName: row.player_name, teamName: row.entry_name });

/**
 * League members after a standings read (v0.2 §15 step 3): existing members
 * keep their settings; standings members are (re)marked present; league
 * members missing from standings are marked leftLeague (never removed);
 * manually added members are left alone. New members are appended in
 * standings order.
 */
export function mergeLeagueMembers(existing, standingsEntryIds) {
  const inLeague = new Set(standingsEntryIds);
  const members = existing.map((m) => {
    if (inLeague.has(m.entryId)) return { ...m, leftLeague: false };
    return m.addedManually ? m : { ...m, leftLeague: true };
  });
  const known = new Set(existing.map((m) => m.entryId));
  for (const entryId of standingsEntryIds) {
    if (known.has(entryId)) continue;
    known.add(entryId);
    members.push({ entryId, isExcluded: false, joinedEvent: null, leftLeague: false, addedManually: false });
  }
  return members;
}

const memberKey = (m) => JSON.stringify([m.entryId, m.isExcluded ?? false, m.joinedEvent ?? null, m.leftLeague ?? false, m.addedManually ?? false]);
export const sameMembers = (a, b) => a.length === b.length && a.every((m, i) => memberKey(m) === memberKey(b[i]));

/** Picks response → picks / auto-subs / chip / Rpicks; rejects invalid squads (SCHEMA_FAIL). */
export function picksOf(res) {
  const picks = [...res.picks].sort((a, b) => a.position - b.position).map((p) => ({
    elementId: p.element, squadPosition: p.position, fplMultiplier: p.multiplier, isCaptain: p.is_captain, isViceCaptain: p.is_vice_captain,
  }));
  const violations = pickViolations(picks);
  if (violations.length) throw new SyncStageError(FailureCode.SCHEMA_FAIL, `invalid picks: ${violations.join('; ')}`);
  return {
    picks,
    autoSubs: res.automatic_subs.map((a) => ({ elementIn: a.element_in, elementOut: a.element_out, source: 'FPL' })),
    activeChip: res.active_chip ?? null,
    picksPoints: res.entry_history.points,
  };
}

export const chipsOf = (history) => history.chips.map((c) => ({ name: c.name, event: c.event, time: toDate(c.time) }));

export const transfersOf = (list) => list.map((t) => ({
  elementIn: t.element_in,
  elementInCostTenths: t.element_in_cost,
  elementOut: t.element_out,
  elementOutCostTenths: t.element_out_cost,
  event: t.event,
  time: new Date(t.time),
}));

// The points inputs that can prove semantics (Δ = T − Tprev vs R, C).
const pointsKey = (p) => JSON.stringify([p.reportedGwPoints, p.transferCost, p.totalPoints, p.previousTotalPoints]);

/**
 * One entry's whole season of GW rows (v0.3 §6 rule 5), reconciled with the
 * unchanged analytics engine. Picks, auto-subs and Rpicks of GWs other than
 * `event` are carried forward from the stored rows.
 * @param {{ season, entryId, event, history, picks: ReturnType<typeof picksOf>|null,
 *   seasonSemantics: string, eventStates: Map<number,string>, existingRows: object[],
 *   hashes: { history: string, picks?: string|null } }} input
 * @returns {{ rows: object[], sourceRequests: Map<number, object>, evidenceCandidates: Map<number, 'GROSS'|'NET'> }}
 */
export function buildSeasonRows({ season, entryId, event, history, picks, seasonSemantics, eventStates, existingRows, hashes }) {
  const existing = new Map(existingRows.map((r) => [r.event, r]));
  const chipByEvent = new Map(history.chips.map((c) => [c.event, c.name]));
  const picksPoints = new Map();
  for (const r of existingRows) if (r.points.picksReportedPoints != null && r.event !== event) picksPoints.set(r.event, r.points.picksReportedPoints);
  if (picks) picksPoints.set(event, picks.picksPoints);

  const { rows: normalized } = reconcileSeason({
    season,
    entryId,
    historyRows: history.current.map((h) => ({ event: h.event, points: h.points, eventTransfersCost: h.event_transfers_cost, totalPoints: h.total_points })),
    picksPoints,
    seasonSemantics,
    eventStates,
  });
  const historyByEvent = new Map(history.current.map((h) => [h.event, h]));

  const rows = [];
  const sourceRequests = new Map();
  const evidenceCandidates = new Map();
  for (const n of normalized) {
    const h = historyByEvent.get(n.event);
    const prev = existing.get(n.event);
    const current = n.event === event;
    const squad = current
      ? { hasPicks: Boolean(picks), picks: picks?.picks ?? [], autoSubs: picks?.autoSubs ?? [] }
      : { hasPicks: prev?.hasPicks ?? false, picks: prev?.picks ?? [], autoSubs: prev?.autoSubs ?? [] };
    const activeChip = current && picks ? picks.activeChip : (chipByEvent.get(n.event) ?? null);
    const points = pointsFromNormalized(n);
    rows.push({
      season,
      entryId,
      event: n.event,
      points,
      eventTransfers: h.event_transfers,
      pointsOnBench: h.points_on_bench,
      overallRank: h.overall_rank ?? null,
      bankTenths: h.bank,
      teamValueTenths: h.value,
      activeChip,
      ...squad,
    });
    const picksHash = current ? (picks ? hashes.picks : null) : (prev?.provenance?.sourceRequests?.picks ?? null);
    sourceRequests.set(n.event, picksHash ? { history: hashes.history, picks: picksHash } : { history: hashes.history });
    // Semantics evidence (v0.2 §2): a hit row where exactly one hypothesis holds,
    // counted only when its points inputs are new to the database.
    const hypothesis = n.reconciliationDetail.hypothesis;
    if (n.transferCost > 0 && (hypothesis === 'GROSS' || hypothesis === 'NET') && (!prev || pointsKey(prev.points) !== pointsKey(points))) {
      evidenceCandidates.set(n.event, hypothesis);
    }
  }
  return { rows, sourceRequests, evidenceCandidates };
}

/**
 * live → liveGameweeks elements. settled = every fixture the element scored in
 * is finished; an element without explain rows is settled when every GW
 * fixture of its team is finished (v0.2 §15 step 5).
 */
export function liveElementsOf(live, gwFixtures, teamOf) {
  const finished = new Map(gwFixtures.map((f) => [f.id, f.finished === true]));
  const teamFixturesDone = (teamId) => gwFixtures.filter((f) => f.teamH === teamId || f.teamA === teamId).every((f) => f.finished === true);
  return [...live.elements].sort(byId).map((e) => {
    const fixtureIds = [...new Set(e.explain.map((x) => x.fixture))];
    const settled = fixtureIds.length
      ? fixtureIds.every((id) => finished.get(id) === true)
      : teamFixturesDone(teamOf.get(e.id));
    return { elementId: e.id, totalPoints: e.stats.total_points, minutes: e.stats.minutes, settled };
  });
}
