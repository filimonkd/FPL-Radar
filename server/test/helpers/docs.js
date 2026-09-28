import { Types } from 'mongoose';

// Valid synthetic documents for model/validator tests.
export const RUN_ID = new Types.ObjectId('66f1a1a1a1a1a1a1a1a1a1a1');
export const GROUP_ID = new Types.ObjectId('66f0c1a2b3c4d5e6f7a8b9c0');
export const HASH = `sha256:${'a'.repeat(64)}`;
export const HASH2 = `sha256:${'b'.repeat(64)}`;
const T = new Date('2026-09-22T19:04:11Z');

export const provenance = (over = {}) => ({
  lastConfirmedByRunId: RUN_ID, lastConfirmedAt: T, lastChangedByRunId: RUN_ID, lastChangedAt: T,
  contentHash: HASH, sourceRequests: { history: HASH }, settled: false, ...over,
});

export const picks15 = () => Array.from({ length: 15 }, (_, i) => ({
  elementId: i + 1, squadPosition: i + 1, fplMultiplier: i === 0 ? 2 : i < 11 ? 1 : 0, isCaptain: i === 0, isViceCaptain: i === 1,
}));

export const docs = {
  group: (over = {}) => ({
    name: 'Group B', slug: 'group-b', memberSource: 'LEAGUE_STANDINGS', fplLeagueId: 900001, myEntryId: 100001,
    winnerRule: 'NET_POINTS', members: [{ entryId: 100001, addedAt: T }, { entryId: 100002, addedAt: T }],
    createdAt: T, updatedAt: T, ...over,
  }),
  manager: (over = {}) => ({ entryId: 100001, playerName: 'Manager 1', teamName: 'Team 1', provenance: provenance(), ...over }),
  season: (over = {}) => ({
    season: '2026-27', teams: [{ id: 1, name: 'Club', shortName: 'CLB' }],
    chipRules: { source: 'FPL_BOOTSTRAP', rules: [{ chipName: 'bboost', startEvent: 1, stopEvent: 19, number: 1, chipType: 'team' }], provenance: provenance() },
    provenance: provenance(), ...over,
  }),
  event: (over = {}) => ({
    season: '2026-27', gw: 5, deadlineTime: T, isCurrent: true, isNext: false, finished: true, dataChecked: true, state: 'DATA_CHECKED',
    dataCheckedObservedAt: T,
    fixtures: [{ id: 41, teamH: 1, teamA: 2, teamHFdr: 3, teamAFdr: 2, kickoffTime: T, started: true, finished: true, finishedProvisional: true, teamHScore: 1, teamAScore: 0 }],
    provenance: provenance(), ...over,
  }),
  player: (over = {}) => ({ season: '2026-27', elementId: 351, webName: 'Player', teamId: 1, elementType: 3, priceTenths: 75, provenance: provenance(), ...over }),
  managerGameweek: (over = {}) => ({
    season: '2026-27', entryId: 100001, event: 5,
    points: {
      reportedGwPoints: 70, transferCost: 4, netGwPoints: 66, grossGwPoints: 70, totalPoints: 331, previousTotalPoints: 265,
      picksReportedPoints: 70, pointsSemantics: 'GROSS_BEFORE_HITS', reconciliationStatus: 'RECONCILED',
      reconciliationDetail: { delta: 66, hypothesis: 'GROSS', picksPoints: 70 },
    },
    eventTransfers: 2, pointsOnBench: 6, overallRank: 812345, bankTenths: 5, teamValueTenths: 1012, activeChip: null,
    hasPicks: true, picks: picks15(), autoSubs: [{ elementIn: 12, elementOut: 7, source: 'FPL' }], provenance: provenance(), ...over,
  }),
  managerSeason: (over = {}) => ({
    season: '2026-27', entryId: 100001, chips: [{ name: 'bboost', event: 3, time: T }],
    transfers: [{ elementIn: 3, elementInCostTenths: 55, elementOut: 16, elementOutCostTenths: 60, event: 2, time: T }],
    provenance: provenance(), ...over,
  }),
  liveGameweek: (over = {}) => ({ season: '2026-27', gw: 5, elements: [{ elementId: 1, totalPoints: 6, minutes: 90, settled: true }], provenance: provenance(), ...over }),
  syncRun: (over = {}) => ({ job: 'group-gw', target: String(GROUP_ID), season: '2026-27', event: 5, trigger: 'MANUAL', status: 'RUNNING', startedAt: T, ...over }),
  rawResponse: (over = {}) => ({ syncRunId: RUN_ID, path: '/entry/1/history/', httpStatus: 200, contentType: 'application/json', bodyGzip: Buffer.from([1, 2, 3]), bodySha256: HASH, bytesRaw: 1981, bytesStored: 3, reason: 'FINAL_EVIDENCE', capturedAt: T, ...over }),
  resultSnapshot: (over = {}) => ({
    groupId: GROUP_ID, season: '2026-27', event: 5, kind: 'RULE_BASED', winnerRule: 'NET_POINTS',
    tieBreakRules: ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED'], computedWinnerEntryIds: [100001], declaredWinnerEntryIds: [100001],
    winningScore: 66, tieBreakApplied: null, tieBreakTrace: [], standings: [{ entryId: 100001 }], inputs: { a: 1 }, inputsHash: HASH,
    eventState: 'DATA_CHECKED', engineVersion: '0.1.0', sources: [{ syncRunId: RUN_ID, startedAt: T, status: 'SUCCESS', requestHashes: [HASH] }],
    contentHash: HASH2, computedAt: T, ...over,
  }),
  gwResult: (over = {}) => ({ groupId: GROUP_ID, season: '2026-27', event: 5, status: 'FINAL', currentSnapshotId: RUN_ID, headSeq: 1, headHash: HASH, updatedAt: T, ...over }),
  gwResultAction: (over = {}) => ({
    groupId: GROUP_ID, season: '2026-27', event: 5, seq: 1, action: 'FINALIZE', prevStatus: 'PROVISIONAL', newStatus: 'FINAL',
    prevWinnerEntryIds: [], newWinnerEntryIds: [100001], prevSnapshotId: null, newSnapshotId: RUN_ID, newSnapshotHash: HASH,
    note: null, syncRunId: RUN_ID, prevHash: 'GENESIS', hash: HASH2, createdAt: T, ...over,
  }),
  lock: (over = {}) => ({ _id: `sync:group:${GROUP_ID}`, owner: null, fencingToken: 0, expiresAt: T, ...over }),
  migration: (over = {}) => ({ _id: '999_test', checksum: HASH, appliedAt: T, ...over }),
};
