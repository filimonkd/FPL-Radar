// Synthetic FPL "world" for smoke-test unit tests. Entirely made up; these
// payloads are never written to server/fpl-contract/.

export const LEAGUE = 4242;
export const ENTRY = 777777;
export const GW = 3;

const events = Array.from({ length: 38 }, (_, i) => ({
  id: i + 1,
  name: `Gameweek ${i + 1}`,
  deadline_time: new Date(Date.UTC(2026, 7, 15 + i * 7)).toISOString(),
  finished: i + 1 <= GW,
  data_checked: i + 1 <= GW,
  is_current: i + 1 === GW,
  is_next: i + 1 === GW + 1,
}));

export function world({ now = new Date(Date.UTC(2026, 7, 31)) } = {}) {
  // Deadline of GW4 must be after "now" for the next-GW picks probe.
  events[GW].deadline_time = new Date(now.getTime() + 86_400_000).toISOString();
  const picks = Array.from({ length: 15 }, (_, i) => ({
    element: i + 1,
    position: i + 1,
    multiplier: i === 0 ? 2 : i < 11 ? 1 : 0,
    is_captain: i === 0,
    is_vice_captain: i === 1,
  }));
  const liveElements = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    stats: { minutes: 90, total_points: i < 15 ? 5 : 1 },
    explain: [{ fixture: 1, stats: [{ identifier: 'minutes', points: 2, value: 90 }] }],
  }));
  // Captain 5×2 + 10 others ×5 = 60 gross.
  const history = {
    current: [
      { event: 1, points: 50, total_points: 50, event_transfers_cost: 0 },
      { event: 2, points: 70, total_points: 116, event_transfers_cost: 4 }, // gross before hits
      { event: 3, points: 60, total_points: 176, event_transfers_cost: 0 },
    ],
    past: [],
    chips: [{ name: 'wildcard', event: 2, time: '2026-08-22T10:00:00Z' }],
  };
  return {
    '/bootstrap-static/': {
      events,
      teams: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Club ${i + 1}`, short_name: `C${i + 1}` })),
      elements: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, web_name: `P${i + 1}`, team: (i % 20) + 1, element_type: (i % 4) + 1, now_cost: 50 })),
      element_types: [1, 2, 3, 4].map((id) => ({ id, singular_name_short: ['GKP', 'DEF', 'MID', 'FWD'][id - 1] })),
      chips: [
        { name: 'wildcard', number: 1, start_event: 2, stop_event: 19 },
        { name: 'wildcard', number: 1, start_event: 20, stop_event: 38 },
      ],
    },
    '/fixtures/': [
      fixture(1, GW), fixture(2, GW), { ...fixture(3, null), kickoff_time: null },
    ],
    [`/fixtures/?event=${GW}`]: [fixture(1, GW), fixture(2, GW)],
    '/event-status/': { status: [{ event: GW, date: '2026-08-30', bonus_added: true, points: 'r' }], leagues: 'Updated' },
    [`/leagues-classic/${LEAGUE}/standings/?page_standings=1`]: standings(1, true, [ENTRY, 111111]),
    [`/leagues-classic/${LEAGUE}/standings/?page_standings=2`]: standings(2, false, [222222]),
    [`/entry/${ENTRY}/`]: { id: ENTRY, name: 'Real Team Name', player_first_name: 'Realfirst', player_last_name: 'Reallast', leagues: { classic: [{ id: LEAGUE, name: 'Real League' }], h2h: [] } },
    [`/entry/${ENTRY}/history/`]: history,
    [`/entry/${ENTRY}/event/${GW}/picks/`]: { active_chip: null, automatic_subs: [], entry_history: { event: GW, points: 60 }, picks },
    [`/entry/${ENTRY}/event/${GW + 1}/picks/`]: { __status: 404, detail: 'Not found.' },
    [`/entry/${ENTRY}/transfers/`]: [
      { element_in: 3, element_in_cost: 55, element_out: 16, element_out_cost: 60, entry: ENTRY, event: 2, time: '2026-08-22T10:00:00Z' },
    ],
    [`/event/${GW}/live/`]: { elements: liveElements },
    '/entry/999999999/': { __status: 404, detail: 'Not found.' },
  };
}

function fixture(id, event) {
  return {
    id, event, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 2,
    kickoff_time: '2026-08-29T14:00:00Z', started: true, finished: true, finished_provisional: true,
    team_h_score: 1, team_a_score: 0,
  };
}

function standings(page, hasNext, entries) {
  return {
    league: { id: LEAGUE, name: 'Real League' },
    standings: {
      has_next: hasNext,
      page,
      results: entries.map((entry, i) => ({ id: page * 10 + i, entry, entry_name: `Real Team ${entry}`, player_name: `Real Person ${entry}`, rank: i + 1, total: 100 })),
    },
  };
}

// fetch double serving the world; unknown paths 404. `overrides` replaces responses per path.
export function worldFetch(data, overrides = {}) {
  const calls = [];
  const fn = async (url) => {
    const path = url.replace('https://fpl.test/api', '');
    calls.push(path);
    const o = overrides[path];
    if (o instanceof Error) throw o;
    if (o instanceof Response) return o.clone();
    const body = o ?? data[path];
    if (body === undefined) return new Response('{"detail":"Not found."}', { status: 404, headers: { 'content-type': 'application/json' } });
    const status = body.__status ?? 200;
    const { __status, ...rest } = Array.isArray(body) ? { __status: undefined } : body;
    return new Response(JSON.stringify(Array.isArray(body) ? body : rest), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' },
    });
  };
  fn.calls = calls;
  return fn;
}
