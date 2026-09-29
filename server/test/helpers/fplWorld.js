import { createFplClient } from '../../src/fpl/client.js';
import { syntheticEvent, syntheticChips, syntheticFixture, syntheticPick, syntheticLiveElement, syntheticTransfer, syntheticStandingsRow } from '../unit/fpl/helpers.js';

// A mutable, entirely synthetic FPL API for sync tests (no real FPL data; the
// IDs are made up). Served through the real client (retry, breaker, cache,
// validation) by injecting `fetch`.

export const BASE_URL = 'https://fpl.test/api';
export const LEAGUE = 900001;
export const ENTRIES = [101, 102, 103];
export const GW = 5;

const DAY = 86_400_000;

/**
 * History rows → FPL `current[]`. `net: true` rows follow H_net (Δ = R); others
 * H_gross (Δ = R − C); `delta` forces Δ (e.g. one that proves neither).
 */
export function historyCurrent(rows) {
  let total = 0;
  return rows.map((r) => {
    total += r.delta ?? (r.points - (r.net ? 0 : r.cost ?? 0));
    return {
      event: r.event, points: r.points, total_points: total, event_transfers: r.cost ? 2 : 1, event_transfers_cost: r.cost ?? 0,
      points_on_bench: r.bench ?? 0, bank: 5, value: 1000, overall_rank: 100000,
    };
  });
}

function defaultEntry(entryId, i) {
  const rows = [1, 2, 3, 4, 5].map((event) => ({ event, points: 50 + event + i * 3, cost: 0 }));
  if (entryId === 102) rows[2] = { event: 3, points: 70, cost: 4 }; // a hit, gross before hits
  return {
    profile: { id: entryId, name: `Team ${entryId}`, player_first_name: 'Manager', player_last_name: String(entryId) },
    rows,
    chips: entryId === 103 ? [{ name: 'bboost', event: 2, time: '2026-08-23T10:00:00Z' }] : [],
    picks: Array.from({ length: 15 }, (_, k) => syntheticPick(k)),
    activeChip: null,
    transfers: [syntheticTransfer(entryId, 2, { time: '2026-08-22T10:00:00Z' })],
  };
}

/**
 * @param {{ seasonStartYear?: number, entries?: number[] }} [opts]
 */
export function createWorld({ seasonStartYear = 2026, entries = ENTRIES } = {}) {
  const gw1 = Date.UTC(seasonStartYear, 7, 15, 10);
  const state = {
    events: Array.from({ length: 38 }, (_, i) => syntheticEvent(i + 1, {
      deadline_time: new Date(gw1 + i * 7 * DAY).toISOString(),
      finished: i + 1 <= GW, data_checked: i + 1 <= GW, is_previous: i + 1 === GW - 1, is_current: i + 1 === GW, is_next: i + 1 === GW + 1,
    })),
    fixtures: Array.from({ length: 12 }, (_, i) => syntheticFixture(i + 1, Math.floor(i / 2) + 1, {
      team_h: (i % 2) * 2 + 1, team_a: (i % 2) * 2 + 2,
      kickoff_time: new Date(gw1 + Math.floor(i / 2) * 7 * DAY + DAY).toISOString(),
      ...(Math.floor(i / 2) + 1 > GW ? { started: false, finished: false, finished_provisional: false, team_h_score: null, team_a_score: null } : {}),
    })),
    chips: syntheticChips(),
    standings: [...entries],
    entries: Object.fromEntries(entries.map((id, i) => [id, defaultEntry(id, i)])),
    live: Array.from({ length: 30 }, (_, i) => ({ ...syntheticLiveElement(i + 1, i < 15 ? 5 : 1), explain: [{ fixture: GW * 2 - 1 + (i % 2), stats: [] }] })),
  };
  state.fixtures.push(syntheticFixture(99, null, { kickoff_time: null, started: false, finished: false, finished_provisional: false, team_h_score: null, team_a_score: null }));

  const overrides = new Map(); // path → Response | Error | (path) => Response|Error|object
  const calls = [];

  function body(path) {
    if (path === '/bootstrap-static/') {
      return {
        events: state.events,
        teams: [1, 2, 3, 4].map((id) => ({ id, name: `Club ${id}`, short_name: `C${id}` })),
        elements: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, web_name: `P${i + 1}`, team: (i % 4) + 1, element_type: (i % 4) + 1, now_cost: 45 + i, ep_next: ((i % 5) + 1).toFixed(1) })),
        element_types: [1, 2, 3, 4].map((id) => ({ id, singular_name_short: ['GKP', 'DEF', 'MID', 'FWD'][id - 1] })),
        chips: state.chips,
      };
    }
    if (path === '/fixtures/') return state.fixtures;
    if (path === `/event/${GW}/live/`) return { elements: state.live };
    let m = /^\/leagues-classic\/(\d+)\/standings\/\?page_standings=(\d+)$/.exec(path);
    if (m && Number(m[1]) === LEAGUE) {
      const page = Number(m[2]);
      const slice = state.standings.slice((page - 1) * 2, page * 2);
      return {
        league: { id: LEAGUE, name: 'League' },
        standings: { has_next: page * 2 < state.standings.length, page, results: slice.map((entry, i) => syntheticStandingsRow(entry, (page - 1) * 2 + i + 1)) },
      };
    }
    m = /^\/entry\/(\d+)\/(?:(history|transfers)\/|event\/(\d+)\/picks\/)?$/.exec(path);
    const e = m && state.entries[m[1]];
    if (!e) return undefined;
    if (m[2] === 'history') return { current: historyCurrent(e.rows), past: [], chips: e.chips };
    if (m[2] === 'transfers') return e.transfers;
    if (m[3]) {
      const event = Number(m[3]);
      const row = historyCurrent(e.rows).find((r) => r.event === event);
      if (!row || event !== GW || e.noPicks) return undefined;
      return {
        active_chip: e.activeChip, automatic_subs: e.autoSubs ?? [],
        entry_history: { event, points: row.points, total_points: row.total_points, event_transfers: row.event_transfers, event_transfers_cost: row.event_transfers_cost, points_on_bench: row.points_on_bench },
        picks: e.picks,
      };
    }
    return e.profile;
  }

  async function fetch(url) {
    const path = url.slice(BASE_URL.length);
    calls.push(path);
    let o = overrides.get(path);
    if (typeof o === 'function') o = await o(path);
    if (o instanceof Error) throw o;
    if (o instanceof Response) return o.clone();
    const b = o ?? body(path);
    if (b === undefined) return new Response('{"detail":"Not found."}', { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  return { state, overrides, calls, fetch };
}

/** A real FPL client on the world: no caching, no retry sleeps, no throttling. */
export function worldClient(world, overrides = {}) {
  const noCache = Object.fromEntries(['bootstrapStatic', 'fixtures', 'eventLive', 'eventStatus', 'entry', 'entryHistory', 'entryPicks', 'entryTransfers', 'classicLeagueStandings'].map((k) => [k, 0]));
  return createFplClient({
    baseUrl: BASE_URL,
    fetch: world.fetch,
    ttls: noCache,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    breaker: { failureThreshold: 1000, resetTimeoutMs: 1 },
    ...overrides,
  });
}

/** Deterministic clock: starts at `start` and advances 1 s per read. */
export function tickingClock(start = new Date('2026-09-22T19:00:00Z')) {
  let t = start.getTime();
  const clock = () => new Date((t += 1000));
  clock.set = (d) => { t = d.getTime(); };
  clock.peek = () => new Date(t);
  return clock;
}
