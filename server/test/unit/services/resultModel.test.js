import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFinalizeGate, computeResult, explainDecision, buildSnapshotInput, verifySnapshotReproduces, recomputeFromSnapshot, diffResults } from '../../../src/services/resultModel.js';
import { normalizeSnapshot } from '../../../src/repositories/mappers/result.js';
import { ENGINE_VERSION } from '../../../src/analytics/index.js';

// Result model (Step 9): the finalize gate around the unchanged canFinalize,
// decision traces, snapshot content and reproduction. Synthetic data only.

const T0 = new Date('2026-09-22T18:00:00Z'); // DATA_CHECKED observed
const AFTER = new Date('2026-09-22T19:00:00Z');
const BEFORE = new Date('2026-09-22T17:00:00Z');
const RUN = 'a'.repeat(24);
const OLD = 'b'.repeat(24);

function row(entryId, { R = 60, C = 0, net = R - C, gross = R, status = C ? 'RECONCILED' : 'RECONCILED_NO_COST', semantics = C ? 'GROSS_BEFORE_HITS' : 'UNVERIFIED', total = 300, chip = null, bench = 3 } = {}) {
  const ok = status === 'RECONCILED' || status === 'RECONCILED_NO_COST';
  return {
    entryId, season: '2026-27', event: 5, reportedGwPoints: R, transferCost: C,
    netGwPoints: ok ? net : null, grossGwPoints: ok ? gross : null, totalPoints: total, previousTotalPoints: total - (ok ? net : R),
    picksReportedPoints: R, pointsSemantics: semantics, reconciliationStatus: status,
    reconciliationDetail: { delta: ok ? net : null, hypothesis: C ? 'GROSS' : 'NET', picksPoints: R },
    pointsOnBench: bench, activeChip: chip, overallRank: null,
  };
}

function inputs({ rows, members = rows.map((r) => ({ entryId: r.entryId, isExcluded: false, joinedEvent: null, synced: true })), freshness, eventState = 'DATA_CHECKED', group = {}, captain = {}, groupActive = true } = {}) {
  return {
    group: { winnerRule: 'NET_POINTS', tieBreakRules: ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED'], myEntryId: null, ...group },
    event: 5,
    eventState,
    members,
    gwRows: rows,
    effectiveSquads: new Map(Object.entries(captain).map(([id, cp]) => [Number(id), { captainPoints: cp }])),
    managers: new Map(members.map((m) => [m.entryId, { entryId: m.entryId, playerName: `Manager ${m.entryId}`, teamName: `Team ${m.entryId}` }])),
    freshness: freshness ?? members.map((m) => ({ entryId: m.entryId, syncRunId: RUN, syncRunStartedAt: AFTER, syncRunStatus: 'SUCCESS' })),
    sources: [{ syncRunId: RUN, startedAt: AFTER, status: 'SUCCESS', requestHashes: [`sha256:${'c'.repeat(64)}`] }],
    gate: { groupActive, dataCheckedObservedAt: T0, resultStatus: null },
  };
}

const gate = (i, over = {}) => evaluateFinalizeGate(i, { resultStatus: null, finalizeRunId: RUN, seasonSemantics: 'GROSS_BEFORE_HITS', ...over });

// ── finalize gate ────────────────────────────────────────────────────────

test('gate passes when every eligible member is reconciled and confirmed by the finalize run', () => {
  assert.deepEqual(gate(inputs({ rows: [row(1), row(2)] })).reasons, []);
});

test('FINALIZE-run only: an older SUCCESS confirmation does not count as fresh', () => {
  const i = inputs({ rows: [row(1), row(2)], freshness: [
    { entryId: 1, syncRunId: RUN, syncRunStartedAt: AFTER, syncRunStatus: 'SUCCESS' },
    { entryId: 2, syncRunId: OLD, syncRunStartedAt: AFTER, syncRunStatus: 'SUCCESS' }, // failed in the finalize sync
  ] });
  const g = gate(i);
  assert.deepEqual(g.reasons, ['STALE_SYNC']);
  assert.deepEqual(g.details.notConfirmedByFinalizeRun, [2]);
  assert.deepEqual(evaluateFinalizeGate(i, { resultStatus: null, seasonSemantics: 'GROSS_BEFORE_HITS' }).reasons, [], 'a read-only preview judges the latest confirmations');
});

test('a PARTIAL finalize run is stale for everyone it confirmed', () => {
  const i = inputs({ rows: [row(1)], freshness: [{ entryId: 1, syncRunId: RUN, syncRunStartedAt: AFTER, syncRunStatus: 'PARTIAL' }] });
  assert.deepEqual(gate(i).reasons, ['STALE_SYNC']);
});

test('DATA_CHECKED and freshness after its first observation are required', () => {
  assert.deepEqual(gate(inputs({ rows: [row(1)], eventState: 'FPL_PROCESSING' })).reasons, ['NOT_DATA_CHECKED']);
  assert.deepEqual(gate(inputs({ rows: [row(1)], eventState: 'MATCHES_FINISHED' })).reasons, ['NOT_DATA_CHECKED']);
  const early = inputs({ rows: [row(1)], freshness: [{ entryId: 1, syncRunId: RUN, syncRunStartedAt: BEFORE, syncRunStatus: 'SUCCESS' }] });
  assert.deepEqual(gate(early).reasons, ['STALE_SYNC']);
});

test('eligibility gates: archived, already final, nobody eligible, unsynced and unreconciled members', () => {
  assert.deepEqual(gate(inputs({ rows: [row(1)], groupActive: false })).reasons, ['GROUP_ARCHIVED']);
  assert.deepEqual(gate(inputs({ rows: [row(1)] }), { resultStatus: 'FINAL' }).reasons, ['ALREADY_FINAL']);
  const excluded = inputs({ rows: [row(1)], members: [{ entryId: 1, isExcluded: true, joinedEvent: null, synced: true }] });
  assert.deepEqual(gate(excluded).reasons, ['NO_ELIGIBLE_MANAGERS']);
  const unsynced = inputs({ rows: [row(1)], members: [{ entryId: 1, isExcluded: false, joinedEvent: null, synced: true }, { entryId: 9, isExcluded: false, joinedEvent: null, synced: false }],
    freshness: [{ entryId: 1, syncRunId: RUN, syncRunStartedAt: AFTER, syncRunStatus: 'SUCCESS' }, { entryId: 9, syncRunId: null, syncRunStartedAt: null, syncRunStatus: null }] });
  assert.deepEqual(gate(unsynced).reasons, ['STALE_SYNC', 'RECONCILIATION_FAILED']);
  const mismatch = gate(inputs({ rows: [row(1), row(2, { status: 'MISMATCH' })] }));
  assert.deepEqual(mismatch.reasons, ['RECONCILIATION_FAILED']);
  assert.deepEqual(mismatch.details.unreconciled, [{ entryId: 2, reconciliationStatus: 'MISMATCH' }]);
});

test('UNVERIFIED blocks where it leaves semantics undecided; C = 0 rows are semantics-independent', () => {
  // A hit row that proves nothing under an UNVERIFIED season is unreconciled.
  const unproven = inputs({ rows: [row(1), row(2, { C: 4, status: 'MISMATCH', semantics: 'UNVERIFIED' })] });
  assert.deepEqual(gate(unproven, { seasonSemantics: 'UNVERIFIED' }).reasons, ['RECONCILIATION_FAILED']);
  // A reconciled hit row while the season is still UNVERIFIED is inconsistent (the season flips on the first one).
  assert.deepEqual(gate(inputs({ rows: [row(1), row(2, { C: 4 })] }), { seasonSemantics: 'UNVERIFIED' }).reasons, ['SEMANTICS_UNVERIFIED']);
  // No hits: an UNVERIFIED season does not block (v0.2 §2 "C = 0 … semantics irrelevant").
  assert.deepEqual(gate(inputs({ rows: [row(1), row(2)] }), { seasonSemantics: 'UNVERIFIED' }).reasons, []);
});

test('CONFLICTED blocks every reconciled hit row, including rows reconciled before the conflict', () => {
  assert.deepEqual(gate(inputs({ rows: [row(1), row(2, { C: 4 })] }), { seasonSemantics: 'CONFLICTED' }).reasons, ['SEMANTICS_CONFLICTED']);
  assert.deepEqual(gate(inputs({ rows: [row(1), row(2, { C: 4, status: 'SEMANTICS_CONFLICT', semantics: 'CONFLICTED' })] }), { seasonSemantics: 'CONFLICTED' }).reasons, ['RECONCILIATION_FAILED']);
  assert.deepEqual(gate(inputs({ rows: [row(1), row(2)] }), { seasonSemantics: 'CONFLICTED' }).reasons, [], 'C = 0 rows stay valid');
  assert.deepEqual(gate(inputs({ rows: [row(1), row(2, { C: 4, semantics: 'GROSS_BEFORE_HITS' })] }), { seasonSemantics: 'NET_AFTER_HITS' }).reasons, ['SEMANTICS_MISMATCH']);
});

// ── ranking and tie-breaks (engine decides; the trace records) ───────────

const decide = (i) => { const r = computeResult(i); return { r, t: explainDecision(r) }; };

test('FEWER_TRANSFER_COST resolves a net tie', () => {
  const { r, t } = decide(inputs({ rows: [row(1, { R: 70 }), row(2, { R: 74, C: 4, net: 70 })] }));
  assert.deepEqual(r.winners, [1]);
  assert.deepEqual([t.topScoreTied, t.decidedBy, t.outcome, t.winningScore], [[1, 2], 'FEWER_TRANSFER_COST', 'SINGLE', 70]);
  assert.deepEqual(t.steps, [{ rule: 'FEWER_TRANSFER_COST', remaining: [1] }]);
});

test('HIGHER_SEASON_TOTAL resolves an equal-cost tie', () => {
  const { r, t } = decide(inputs({ rows: [row(1, { R: 70, total: 400 }), row(2, { R: 70, total: 410 })] }));
  assert.deepEqual(r.winners, [2]);
  assert.deepEqual(t.steps.map((s) => [s.rule, s.remaining]), [['FEWER_TRANSFER_COST', [1, 2]], ['HIGHER_SEASON_TOTAL', [2]]]);
  assert.equal(t.decidedBy, 'HIGHER_SEASON_TOTAL');
});

test('HIGHER_CAPTAIN_POINTS uses the effective captain points', () => {
  const { r, t } = decide(inputs({ rows: [row(1, { R: 70 }), row(2, { R: 70 })], group: { tieBreakRules: ['HIGHER_CAPTAIN_POINTS', 'SHARED'] }, captain: { 1: 6, 2: 10 } }));
  assert.deepEqual([r.winners, t.decidedBy], [[2], 'HIGHER_CAPTAIN_POINTS']);
});

test('NO_CHIP_PLAYED prefers the manager without a chip', () => {
  const { r, t } = decide(inputs({ rows: [row(1, { R: 70, chip: 'bboost' }), row(2, { R: 70 })], group: { tieBreakRules: ['NO_CHIP_PLAYED', 'SHARED'] } }));
  assert.deepEqual([r.winners, t.decidedBy], [[2], 'NO_CHIP_PLAYED']);
});

test('an unresolved tie is SHARED, and entry ids never pick a winner', () => {
  const rows = [row(7, { R: 70, total: 400 }), row(3, { R: 70, total: 400 })];
  const { r, t } = decide(inputs({ rows }));
  assert.deepEqual(r.winners, [3, 7]);
  assert.deepEqual([t.outcome, t.decidedBy], ['SHARED', 'SHARED']);
  assert.deepEqual(t.steps.at(-1), { rule: 'SHARED', remaining: [3, 7] });
  const swapped = decide(inputs({ rows: [...rows].reverse() }));
  assert.deepEqual(swapped.r.winners, [3, 7], 'input order changes nothing');
  assert.equal(swapped.r.inputsHash, r.inputsHash, 'deterministic inputs');
  assert.deepEqual(r.rows.filter((x) => x.isWinner).map((x) => x.entryId).sort(), [3, 7]);
  assert.ok(r.rows.every((x) => x.competitionRank === 1), 'both rank 1; resolvedPosition only orders the table');
});

test('winnerRule picks gross or net only from reconciled values', () => {
  const rows = [row(1, { R: 72 }), row(2, { R: 76, C: 4, net: 72, gross: 76 })];
  assert.deepEqual(decide(inputs({ rows, group: { winnerRule: 'NET_POINTS' } })).r.winners, [1], 'net tie → fewer transfer cost');
  const gross = decide(inputs({ rows, group: { winnerRule: 'GROSS_POINTS' } }));
  assert.deepEqual([gross.r.winners, gross.t.winningScore, gross.t.decidedBy], [[2], 76, null]);
});

test('a blocked result names who blocks it and declares nobody', () => {
  const { r, t } = decide(inputs({ rows: [row(1), row(2, { status: 'INCOMPLETE' })] }));
  assert.equal(r.status, 'BLOCKED');
  assert.deepEqual([t.outcome, t.blockedBy], ['NONE', [{ entryId: 2, reconciliationStatus: 'INCOMPLETE' }]]);
  assert.deepEqual(t.eligible, [1, 2]);
});

test('the trace lists ineligible members with their reason', () => {
  const members = [{ entryId: 1, isExcluded: false, joinedEvent: null, synced: true }, { entryId: 2, isExcluded: true, joinedEvent: null, synced: true }, { entryId: 3, isExcluded: false, joinedEvent: 9, synced: true }];
  const { t } = decide(inputs({ rows: [row(1), row(2), row(3)], members }));
  assert.deepEqual(t.eligible, [1]);
  assert.deepEqual(t.ineligible, [{ entryId: 2, reason: 'EXCLUDED' }, { entryId: 3, reason: 'JOINED_LATER' }]);
});

// ── snapshot content and reproduction ─────────────────────────────────────

const stored = (i) => {
  const result = computeResult(i);
  // What resultRepo stores and reads back: the canonical, normalized snapshot.
  return { result, snap: normalizeSnapshot(buildSnapshotInput({ groupId: 'd'.repeat(24), season: '2026-27', inputs: i, result, computedAt: AFTER })) };
};

test('a snapshot carries standings, engine inputs, reconciliation, trace, warnings and sources', () => {
  const { result, snap } = stored(inputs({ rows: [row(1, { R: 70 }), row(2, { R: 74, C: 4, net: 70 })] }));
  assert.equal(snap.inputsHash, result.inputsHash);
  assert.equal(snap.engineVersion, ENGINE_VERSION);
  assert.deepEqual(snap.computedWinnerEntryIds, [1]);
  assert.deepEqual(snap.declaredWinnerEntryIds, [1]);
  assert.equal(snap.inputs.gwRows[1].reconciliationStatus, 'RECONCILED');
  assert.equal(snap.inputs.gwRows[1].pointsSemantics, 'GROSS_BEFORE_HITS');
  assert.deepEqual(snap.inputs.managers.map((m) => m.entryId), [1, 2]);
  assert.equal(snap.tieBreakTrace.decidedBy, 'FEWER_TRANSFER_COST');
  assert.equal(snap.standings.length, 2);
  assert.equal(snap.sources[0].syncRunId, RUN);
});

test('a stored snapshot reproduces its result exactly; tampering is detected', () => {
  const { snap } = stored(inputs({ rows: [row(1, { R: 70, total: 400 }), row(2, { R: 70, total: 410 }), row(3, { status: 'MISMATCH' })], members: [1, 2].map((entryId) => ({ entryId, isExcluded: false, joinedEvent: null, synced: true })) }));
  assert.deepEqual(verifySnapshotReproduces(snap, { engineVersion: ENGINE_VERSION }), {
    reproducible: true, mismatches: [], storedEngineVersion: ENGINE_VERSION, currentEngineVersion: ENGINE_VERSION, engineChanged: false,
  });
  assert.deepEqual(recomputeFromSnapshot(snap).winners, [2]);
  const edited = structuredClone(snap);
  edited.inputs.gwRows[0].netGwPoints = 99;
  assert.ok(verifySnapshotReproduces(edited, { engineVersion: ENGINE_VERSION }).mismatches.includes('INPUTS_HASH'));
  const standings = structuredClone(snap);
  standings.standings[0].score = 1;
  assert.deepEqual(verifySnapshotReproduces(standings, { engineVersion: ENGINE_VERSION }).mismatches, ['STANDINGS']);
  assert.equal(verifySnapshotReproduces(snap, { engineVersion: '9.9.9' }).engineChanged, true);
});

test('diffResults reports changed winners and rows for a recompute preview', () => {
  const before = stored(inputs({ rows: [row(1, { R: 70 }), row(2, { R: 60 })] })).snap;
  const after = computeResult(inputs({ rows: [row(1, { R: 70 }), row(2, { R: 80 })] }));
  assert.deepEqual(diffResults(before, after), { oldWinners: [1], newWinners: [2], winnersChanged: true, changedEntryIds: [1, 2] });
  const same = computeResult(inputs({ rows: [row(1, { R: 70 }), row(2, { R: 60 })] }));
  assert.deepEqual(diffResults(before, same), { oldWinners: [1], newWinners: [1], winnersChanged: false, changedEntryIds: [] });
});
