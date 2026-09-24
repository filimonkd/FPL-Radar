// Shared test doubles for the FPL client. Payloads are synthetic, not real FPL data.

export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// fetch double that replays a script of responses (functions, Responses or Errors).
export function scriptedFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script.length > 1 ? script.shift() : script[0];
    const out = typeof step === 'function' ? await step(url, init) : step;
    if (out instanceof Error) throw out;
    return out instanceof Response ? out.clone() : out;
  };
  fn.calls = calls;
  return fn;
}

// Synthetic payload builders matching the locked schemas (test-only).
export const syntheticEvent = (id, over = {}) => ({
  id, name: `Gameweek ${id}`, deadline_time: '2000-01-01T00:00:00Z',
  finished: false, data_checked: false, is_previous: false, is_current: false, is_next: false, ...over,
});
export const syntheticChips = () => [
  { id: 1, name: 'wildcard', number: 1, start_event: 2, stop_event: 19, chip_type: 'transfer' },
  { id: 2, name: 'wildcard', number: 1, start_event: 20, stop_event: 38, chip_type: 'transfer' },
];
export const syntheticFixture = (id, event, over = {}) => ({
  id, event, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 2,
  kickoff_time: '2000-01-01T00:00:00Z', started: true, finished: true, finished_provisional: true,
  team_h_score: 1, team_a_score: 0, ...over,
});
export const syntheticEntry = (id) => ({ id, name: 'Synthetic XI', player_first_name: 'Synthetic', player_last_name: 'Manager' });
export const syntheticHistoryRow = (event, points, totalPoints, cost = 0) => ({
  event, points, total_points: totalPoints, event_transfers: cost ? 2 : 1, event_transfers_cost: cost,
  points_on_bench: 0, bank: 5, value: 1000, overall_rank: 100000,
});
export const syntheticEntryHistory = (event, points, totalPoints, cost = 0) => ({
  event, points, total_points: totalPoints, event_transfers: 1, event_transfers_cost: cost, points_on_bench: 0,
});
export const syntheticPick = (i) => ({
  element: i + 1, position: i + 1, multiplier: i === 0 ? 2 : i < 11 ? 1 : 0,
  is_captain: i === 0, is_vice_captain: i === 1, element_type: i === 0 || i === 11 ? 1 : 3,
});
export const syntheticLiveElement = (id, totalPoints, minutes = 90) => ({
  id, stats: { minutes, total_points: totalPoints },
  explain: [{ fixture: 1, stats: [{ identifier: 'minutes', points: 2, value: minutes }] }],
});
export const syntheticTransfer = (entry, event, over = {}) => ({
  element_in: 3, element_in_cost: 55, element_out: 16, element_out_cost: 60, entry, event,
  time: '2000-01-01T00:00:00Z', ...over,
});
export const syntheticStandingsRow = (entry, rank, over = {}) => ({
  entry, entry_name: `Team ${entry}`, player_name: `Manager ${entry}`, rank, last_rank: rank, event_total: 50, total: 100, ...over,
});

export const minimalBootstrap = () => ({
  events: [syntheticEvent(1, { finished: false, is_current: true })],
  teams: [{ id: 1, name: 'Team A', short_name: 'TMA' }],
  elements: [{ id: 1, web_name: 'Player', team: 1, element_type: 3, now_cost: 50 }],
  element_types: [{ id: 3, singular_name_short: 'MID' }],
  chips: syntheticChips(),
});

// Client options that make tests deterministic: fake time, no jitter, no throttling.
export function testOptions(clock, overrides = {}) {
  return {
    baseUrl: 'https://fpl.test/api',
    now: clock.now,
    sleep: clock.sleep,
    random: () => 1,
    rateLimit: { capacity: 1000, refillPerSecond: 10 },
    ...overrides,
  };
}
