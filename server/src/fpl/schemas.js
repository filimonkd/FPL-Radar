import { t } from './validate.js';

// Expected shapes for the public (unauthenticated) FPL endpoints the client exposes.
// FPL publishes no official API documentation or schema. These shapes list only
// the fields this app depends on, taken from widely used community references.
// They have NOT been verified against a live response in this repository; see README.

const event = t.object({
  id: t.int(),
  name: t.string(),
  deadline_time: t.nullable(t.string()),
  finished: t.bool(),
  is_current: t.bool(),
  is_next: t.bool(),
});

const team = t.object({
  id: t.int(),
  name: t.string(),
  short_name: t.string(),
});

const element = t.object({
  id: t.int(),
  web_name: t.string(),
  team: t.int(),
  element_type: t.int(),
  now_cost: t.int(),
});

const elementType = t.object({
  id: t.int(),
  singular_name_short: t.string(),
});

export const bootstrapStatic = t.object({
  events: t.array(event),
  teams: t.array(team),
  elements: t.array(element),
  element_types: t.array(elementType),
});

export const fixtures = t.array(
  t.object({
    id: t.int(),
    event: t.nullable(t.int()),
    team_h: t.int(),
    team_a: t.int(),
    kickoff_time: t.nullable(t.string()),
    finished: t.bool(),
    team_h_score: t.nullable(t.int()),
    team_a_score: t.nullable(t.int()),
  }),
);

export const eventLive = t.object({
  elements: t.array(
    t.object({
      id: t.int(),
      stats: t.object({
        minutes: t.int(),
        total_points: t.int(),
      }),
    }),
  ),
});

export const elementSummary = t.object({
  fixtures: t.array(t.object({ id: t.int() })),
  history: t.array(t.object({ element: t.int(), round: t.int() })),
});

export const entry = t.object({
  id: t.int(),
  name: t.string(),
});

export const entryHistory = t.object({
  current: t.array(
    t.object({
      event: t.int(),
      points: t.int(),
      total_points: t.int(),
    }),
  ),
  past: t.array(t.object({ season_name: t.string(), total_points: t.int() })),
});

export const entryPicks = t.object({
  picks: t.array(
    t.object({
      element: t.int(),
      position: t.int(),
      multiplier: t.int(),
      is_captain: t.bool(),
      is_vice_captain: t.bool(),
    }),
  ),
  entry_history: t.object({ event: t.int(), points: t.int() }),
});

// Full transfer list for an entry. The mapper de-duplicates on time + in + out
// (architecture v0.3 §4), so those are the fields validated here.
export const entryTransfers = t.array(
  t.object({
    element_in: t.int(),
    element_out: t.int(),
    event: t.int(),
    time: t.string(),
  }),
);

export const classicLeagueStandings = t.object({
  league: t.object({ id: t.int(), name: t.string() }),
  standings: t.object({
    has_next: t.bool(),
    page: t.int(),
    results: t.array(
      t.object({
        entry: t.int(),
        entry_name: t.string(),
        rank: t.int(),
        total: t.int(),
      }),
    ),
  }),
});
