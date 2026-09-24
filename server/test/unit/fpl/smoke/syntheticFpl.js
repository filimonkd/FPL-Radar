// Synthetic FPL "world" for smoke-test unit tests. Entirely made up; these
// payloads are never written to server/fpl-contract/.
import {
  syntheticEvent, syntheticChips, syntheticFixture, syntheticHistoryRow, syntheticEntryHistory,
  syntheticPick, syntheticLiveElement, syntheticTransfer, syntheticStandingsRow,
} from '../helpers.js';

export const LEAGUE = 4242;
export const ENTRY = 777777;
export const GW = 3;

const events = Array.from({ length: 38 }, (_, i) => syntheticEvent(i + 1, {
  deadline_time: new Date(Date.UTC(2026, 7, 15 + i * 7)).toISOString(),
  finished: i + 1 <= GW,
  data_checked: i + 1 <= GW,
  is_previous: i + 1 === GW - 1,
  is_current: i + 1 === GW,
  is_next: i + 1 === GW + 1,
}));

export function world({ now = new Date(Date.UTC(2026, 7, 31)) } = {}) {
  // Deadline of GW4 must be after "now" for the next-GW picks probe.
  events[GW].deadline_time = new Date(now.getTime() + 86_400_000).toISOString();
  const picks = Array.from({ length: 15 }, (_, i) => syntheticPick(i));
  const liveElements = Array.from({ length: 30 }, (_, i) => syntheticLiveElement(i + 1, i < 15 ? 5 : 1));
  // Captain 5×2 + 10 others ×5 = 60 gross.
  const history = {
    current: [
      syntheticHistoryRow(1, 50, 50),
      syntheticHistoryRow(2, 70, 116, 4), // gross before hits
      syntheticHistoryRow(3, 60, 176),
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
      chips: syntheticChips(),
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
    [`/entry/${ENTRY}/event/${GW}/picks/`]: { active_chip: null, automatic_subs: [], entry_history: syntheticEntryHistory(GW, 60, 176), picks },
    [`/entry/${ENTRY}/event/${GW + 1}/picks/`]: { __status: 404, detail: 'Not found.' },
    [`/entry/${ENTRY}/transfers/`]: [
      syntheticTransfer(ENTRY, 2, { time: '2026-08-22T10:00:00Z' }),
    ],
    [`/event/${GW}/live/`]: { elements: liveElements },
    '/entry/999999999/': { __status: 404, detail: 'Not found.' },
  };
}

const fixture = (id, event) => syntheticFixture(id, event);

function standings(page, hasNext, entries) {
  return {
    league: { id: LEAGUE, name: 'Real League' },
    standings: {
      has_next: hasNext,
      page,
      results: entries.map((entry, i) => syntheticStandingsRow(entry, i + 1, { id: page * 10 + i, entry_name: `Real Team ${entry}`, player_name: `Real Person ${entry}` })),
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
