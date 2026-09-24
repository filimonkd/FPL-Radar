// Synthetic builders for engine tests (architecture v0.2 §16). Plain objects
// with sensible defaults; override only what a test cares about.

export const SEASON = '2026-27';

export function makeGwRow(entryId, over = {}) {
  const net = over.netGwPoints ?? 60;
  const cost = over.transferCost ?? 0;
  return {
    entryId,
    season: SEASON,
    event: 5,
    reportedGwPoints: net + cost,
    transferCost: cost,
    netGwPoints: net,
    grossGwPoints: net + cost,
    totalPoints: 300,
    previousTotalPoints: 300 - net,
    pointsSemantics: 'GROSS_BEFORE_HITS',
    reconciliationStatus: cost > 0 ? 'RECONCILED' : 'RECONCILED_NO_COST',
    reconciliationDetail: { delta: net, hypothesis: cost > 0 ? 'GROSS' : 'BOTH', picksPoints: null },
    pointsOnBench: 5,
    activeChip: null,
    overallRank: 100000,
    ...over,
  };
}

export const makeMember = (entryId, over = {}) => ({ entryId, isExcluded: false, joinedEvent: null, synced: true, ...over });

export function makeGroup(over = {}) {
  return { winnerRule: 'NET_POINTS', tieBreakRules: ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED'], myEntryId: null, ...over };
}

// 15 picks: elements 1..15 at positions 1..15; captain 1, vice 2 unless overridden.
export function makePicks({ captain = 1, vice = 2, fplMultipliers = {} } = {}) {
  return Array.from({ length: 15 }, (_, i) => {
    const elementId = i + 1;
    return {
      elementId,
      squadPosition: i + 1,
      isCaptain: elementId === captain,
      isViceCaptain: elementId === vice,
      fplMultiplier: fplMultipliers[elementId] ?? (elementId === captain ? 2 : i < 11 ? 1 : 0),
    };
  });
}

// live Map for elements 1..15; every player played 90' and scored `points` unless overridden.
export function makeLive(overrides = {}, { points = 2 } = {}) {
  const live = new Map();
  for (let id = 1; id <= 15; id++) live.set(id, { minutes: 90, totalPoints: points, fixturesSettled: true, ...(overrides[id] ?? {}) });
  return live;
}

export const managersMap = (ids) => new Map(ids.map((id) => [id, { entryId: id, playerName: `Manager ${id}`, teamName: `Team ${id}` }]));
