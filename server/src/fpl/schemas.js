import { z } from 'zod';

// Expected shapes for the public (unauthenticated) FPL endpoints the client exposes.
// Locked against the Step 2 smoke test (server/fpl-contract/2026-27/, GW5 of
// 2026-27, recorded 2026-09-24): every field below was observed in a real
// response unless its comment says otherwise. The smoke report and
// smoke-decisions.md next to the samples record what was observed.
//
// Only the fields this app depends on are listed. Objects are loose: unknown
// fields pass through untouched so additive upstream changes do not break the
// client. Anything nullable was observed as null, or is marked with the reason.

const obj = (shape) => z.looseObject(shape);

// ── bootstrap-static ────────────────────────────────────────────────
const event = obj({
  id: z.int(),
  name: z.string(),
  deadline_time: z.string(), // observed non-null on all 38 events
  finished: z.boolean(),
  data_checked: z.boolean(),
  is_previous: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
});

const team = obj({
  id: z.int(),
  name: z.string(),
  short_name: z.string(),
});

const element = obj({
  id: z.int(),
  web_name: z.string(),
  team: z.int(),
  element_type: z.int(),
  now_cost: z.int(), // tenths of £m
});

const elementType = obj({
  id: z.int(),
  singular_name_short: z.string(),
});

// Chip windows (v0.2 §8). Observed: 8 rules, e.g. { name: 'wildcard', number: 1,
// start_event: 2, stop_event: 19, chip_type: 'transfer' }.
const chipRule = obj({
  id: z.int(),
  name: z.string(),
  number: z.int(),
  start_event: z.int(),
  stop_event: z.int(),
  chip_type: z.string(),
});

export const bootstrapStatic = obj({
  events: z.array(event),
  teams: z.array(team),
  elements: z.array(element),
  element_types: z.array(elementType),
  chips: z.array(chipRule),
});

// ── fixtures ─────────────────────────────────────────────────────────
export const fixtures = z.array(
  obj({
    id: z.int(),
    // event and kickoff_time were never null in the 2026-27 run, but the
    // architecture requires handling unscheduled fixtures (v0.2 §3), for which
    // FPL is documented by the community to send null. Kept nullable (F2).
    event: z.int().nullable(),
    kickoff_time: z.string().nullable(),
    team_h: z.int(),
    team_a: z.int(),
    team_h_difficulty: z.int(),
    team_a_difficulty: z.int(),
    started: z.boolean(),
    finished: z.boolean(),
    finished_provisional: z.boolean(),
    team_h_score: z.int().nullable(), // observed null for unplayed fixtures
    team_a_score: z.int().nullable(),
  }),
);

// ── event-status ─────────────────────────────────────────────────────
// Observed: status rows per match day, e.g. { event: 5, date: '2026-09-18',
// bonus_added: true, points: 'r' }; leagues: 'Updated'. Values are recorded,
// not interpreted.
export const eventStatus = obj({
  status: z.array(
    obj({
      event: z.int(),
      date: z.string(),
      bonus_added: z.boolean(),
      points: z.string(),
    }),
  ),
  leagues: z.string(),
});

// ── event live ───────────────────────────────────────────────────────
export const eventLive = obj({
  elements: z.array(
    obj({
      id: z.int(),
      stats: obj({
        minutes: z.int(),
        total_points: z.int(),
      }),
      explain: z.array(
        obj({
          fixture: z.int(),
          stats: z.array(obj({ identifier: z.string(), points: z.int(), value: z.number() })),
        }),
      ),
    }),
  ),
});

// ── entry ────────────────────────────────────────────────────────────
export const entry = obj({
  id: z.int(),
  name: z.string(),
  player_first_name: z.string(),
  player_last_name: z.string(),
});

// ── entry history ────────────────────────────────────────────────────
export const entryHistory = obj({
  current: z.array(
    obj({
      event: z.int(),
      points: z.int(),
      total_points: z.int(),
      event_transfers: z.int(),
      event_transfers_cost: z.int(),
      points_on_bench: z.int(),
      bank: z.int(), // tenths of £m
      value: z.int(), // tenths of £m
      // Observed non-null; the domain model allows null (v0.2 §14 TieBreakRow.overallRank).
      overall_rank: z.int().nullable(),
    }),
  ),
  past: z.array(obj({ season_name: z.string(), total_points: z.int() })),
  // No chip had been played by the sampled entry, so the element shape is
  // unobserved; name/event are what v0.2 §8 matching needs.
  chips: z.array(obj({ name: z.string(), event: z.int() })),
});

// ── entry picks ──────────────────────────────────────────────────────
export const entryPicks = obj({
  // Observed null with no chip active; a string chip name otherwise (v0.2 §7).
  active_chip: z.string().nullable(),
  // Observed empty; element shape per v0.2 §7 (element_in/element_out).
  automatic_subs: z.array(obj({ element_in: z.int(), element_out: z.int() })),
  entry_history: obj({
    event: z.int(),
    points: z.int(),
    total_points: z.int(),
    event_transfers: z.int(),
    event_transfers_cost: z.int(),
    points_on_bench: z.int(),
  }),
  picks: z.array(
    obj({
      element: z.int(),
      position: z.int(),
      multiplier: z.int(),
      is_captain: z.boolean(),
      is_vice_captain: z.boolean(),
      element_type: z.int(),
    }),
  ),
});

// ── entry transfers ──────────────────────────────────────────────────
// The mapper de-duplicates on time + in + out (architecture v0.3 §4).
export const entryTransfers = z.array(
  obj({
    element_in: z.int(),
    element_in_cost: z.int(), // tenths of £m (observed 41–80)
    element_out: z.int(),
    element_out_cost: z.int(),
    entry: z.int(),
    event: z.int(),
    time: z.string(),
  }),
);

// ── classic league standings ─────────────────────────────────────────
export const classicLeagueStandings = obj({
  league: obj({ id: z.int(), name: z.string() }),
  standings: obj({
    has_next: z.boolean(),
    page: z.int(),
    results: z.array(
      obj({
        entry: z.int(),
        entry_name: z.string(),
        player_name: z.string(),
        rank: z.int(),
        last_rank: z.int(),
        event_total: z.int(),
        total: z.int(),
      }),
    ),
  }),
});
