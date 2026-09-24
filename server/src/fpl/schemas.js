import { z } from 'zod';

// Expected shapes for the public (unauthenticated) FPL endpoints the client exposes.
// FPL publishes no official API documentation or schema. These shapes list only
// the fields this app depends on, taken from widely used community references.
// They have NOT been verified against a live response in this repository; see README.
//
// Objects are loose: unknown fields pass through untouched so additive upstream
// changes do not break the client.

const obj = (shape) => z.looseObject(shape);

const event = obj({
  id: z.int(),
  name: z.string(),
  deadline_time: z.string().nullable(),
  finished: z.boolean(),
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
  now_cost: z.int(),
});

const elementType = obj({
  id: z.int(),
  singular_name_short: z.string(),
});

export const bootstrapStatic = obj({
  events: z.array(event),
  teams: z.array(team),
  elements: z.array(element),
  element_types: z.array(elementType),
});

export const fixtures = z.array(
  obj({
    id: z.int(),
    event: z.int().nullable(),
    team_h: z.int(),
    team_a: z.int(),
    kickoff_time: z.string().nullable(),
    finished: z.boolean(),
    team_h_score: z.int().nullable(),
    team_a_score: z.int().nullable(),
  }),
);

export const eventLive = obj({
  elements: z.array(
    obj({
      id: z.int(),
      stats: obj({
        minutes: z.int(),
        total_points: z.int(),
      }),
    }),
  ),
});

export const elementSummary = obj({
  fixtures: z.array(obj({ id: z.int() })),
  history: z.array(obj({ element: z.int(), round: z.int() })),
});

export const entry = obj({
  id: z.int(),
  name: z.string(),
});

export const entryHistory = obj({
  current: z.array(
    obj({
      event: z.int(),
      points: z.int(),
      total_points: z.int(),
    }),
  ),
  past: z.array(obj({ season_name: z.string(), total_points: z.int() })),
});

export const entryPicks = obj({
  picks: z.array(
    obj({
      element: z.int(),
      position: z.int(),
      multiplier: z.int(),
      is_captain: z.boolean(),
      is_vice_captain: z.boolean(),
    }),
  ),
  entry_history: obj({ event: z.int(), points: z.int() }),
});

// Full transfer list for an entry. The mapper de-duplicates on time + in + out
// (architecture v0.3 §4), so those are the fields validated here.
export const entryTransfers = z.array(
  obj({
    element_in: z.int(),
    element_out: z.int(),
    event: z.int(),
    time: z.string(),
  }),
);

export const classicLeagueStandings = obj({
  league: obj({ id: z.int(), name: z.string() }),
  standings: obj({
    has_next: z.boolean(),
    page: z.int(),
    results: z.array(
      obj({
        entry: z.int(),
        entry_name: z.string(),
        rank: z.int(),
        total: z.int(),
      }),
    ),
  }),
});
