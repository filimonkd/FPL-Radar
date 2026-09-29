import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import * as map from '../../../src/repositories/mappers/index.js';
import { snapshotHash, actionHash, nextAction } from '../../../src/audit/hashChain.js';
import { reconcileSeason } from '../../../src/analytics/reconcile.js';
import { docs, provenance, GROUP_ID, RUN_ID, HASH } from '../../helpers/docs.js';

// Mapper round trips (architecture v0.3 §10 rule 1): Mongo document → domain →
// document is lossless, ObjectIds become hex strings, Dates stay Dates, tenths
// stay integers, provenance is dropped unless requested.

const withId = (doc, _id) => ({ _id, ...doc });

const ROUND_TRIPS = [
  ['group', () => withId(docs.group({ tieBreakRules: ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED'], shareToken: null, isActive: true, archivedAt: null,
    members: [{ entryId: 100001, isExcluded: false, joinedEvent: null, leftLeague: false, addedManually: false, addedAt: new Date('2026-09-22T19:04:11Z') }] }), GROUP_ID),
    map.groupToDomain, map.groupToDocument],
  ['manager', () => withId(docs.manager(), 100001), map.managerToDomain, map.managerToDocument],
  ['event', () => withId(docs.event(), '2026-27:5'), map.eventToDomain, map.eventToDocument],
  ['player', () => withId(docs.player({ status: 'a', epNextTenths: 45 }), '2026-27:351'), map.playerToDomain, map.playerToDocument],
  ['managerGameweek', () => withId(docs.managerGameweek(), '2026-27:100001:5'), map.managerGameweekToDomain, map.managerGameweekToDocument],
  ['managerSeason', () => withId(docs.managerSeason(), '2026-27:100001'), map.managerSeasonToDomain, map.managerSeasonToDocument],
  ['liveGameweek', () => withId(docs.liveGameweek(), '2026-27:5'), map.liveToDomain, map.liveToDocument],
];

for (const [name, make, toDomain, toDocument] of ROUND_TRIPS) {
  test(`${name}: document → domain → document is lossless (provenance aside)`, () => {
    const doc = make();
    const { provenance: _p, ...data } = doc;
    const domain = toDomain(doc);
    assert.equal(domain.provenance, undefined, 'provenance is dropped unless requested');
    const back = toDocument(domain);
    assert.deepEqual({ ...back, _id: String(back._id) }, { ...data, _id: String(data._id) });
    assert.deepEqual(toDomain(back), domain, 'domain → document → domain is stable');
  });
}

test('withProvenance maps run ids to strings and keeps Dates and hashes', () => {
  const d = map.managerToDomain(withId(docs.manager(), 100001), { withProvenance: true });
  assert.equal(d.provenance.lastConfirmedByRunId, String(RUN_ID));
  assert.ok(d.provenance.lastConfirmedAt instanceof Date);
  assert.equal(d.provenance.contentHash, HASH);
  assert.deepEqual(d.provenance.sourceRequests, { history: HASH });
});

test('group ids become 24-char hex strings and back to ObjectIds', () => {
  const g = map.groupToDomain(withId(docs.group({ tieBreakRules: ['SHARED'] }), GROUP_ID));
  assert.equal(g.id, String(GROUP_ID));
  const back = map.groupToDocument(g);
  assert.ok(back._id instanceof Types.ObjectId);
  assert.throws(() => map.toObjectId('not-an-id'), /24-char hex/);
});

test('season: chip-rule provenance only on request, semantics kept verbatim (UNVERIFIED / CONFLICTED)', () => {
  for (const value of ['UNVERIFIED', 'CONFLICTED']) {
    const doc = withId(docs.season({ pointsSemantics: { value, evidenceRows: 0, conflictRows: value === 'CONFLICTED' ? 2 : 0, firstVerifiedRunId: null } }), '2026-27');
    const s = map.seasonToDomain(doc);
    assert.equal(s.pointsSemantics.value, value);
    assert.equal(s.chipRules.provenance, undefined);
    assert.equal(map.seasonToDomain(doc, { withProvenance: true }).chipRules.provenance.contentHash, HASH);
  }
  const s = map.seasonToDomain(withId(docs.season(), '2026-27'));
  assert.deepEqual(map.chipRulesToEngine(s.chipRules), [{ chipName: 'bboost', startEvent: 1, stopEvent: 19, number: 1, chipType: 'team', source: 'FPL_BOOTSTRAP' }]);
});

test('managerGameweek → engine row is flat NormalizedGwPoints; unreconciled net/gross stay null', () => {
  const doc = withId(docs.managerGameweek({
    points: {
      reportedGwPoints: 70, transferCost: 4, netGwPoints: null, grossGwPoints: null, totalPoints: 331, previousTotalPoints: 265,
      picksReportedPoints: null, pointsSemantics: 'CONFLICTED', reconciliationStatus: 'SEMANTICS_CONFLICT',
      reconciliationDetail: { delta: 66, hypothesis: 'GROSS', picksPoints: null },
    },
  }), '2026-27:100001:5');
  const row = map.toEngineGwRow(map.managerGameweekToDomain(doc));
  assert.equal(row.netGwPoints, null);
  assert.equal(row.grossGwPoints, null);
  assert.equal(row.pointsSemantics, 'CONFLICTED');
  assert.equal(row.reconciliationStatus, 'SEMANTICS_CONFLICT');
  assert.equal(row.picks, undefined, 'engine rows carry no picks');
  assert.deepEqual(Object.keys(row).sort(), [
    'activeChip', 'entryId', 'event', 'grossGwPoints', 'netGwPoints', 'overallRank', 'picksReportedPoints', 'pointsOnBench', 'pointsSemantics',
    'previousTotalPoints', 'reconciliationDetail', 'reconciliationStatus', 'reportedGwPoints', 'season', 'totalPoints', 'transferCost',
  ]);
});

test('pointsFromNormalized copies reconcileSeason output without choosing gross or net', () => {
  const { rows } = reconcileSeason({
    season: '2026-27', entryId: 1, seasonSemantics: 'UNVERIFIED',
    historyRows: [{ event: 1, points: 60, eventTransfersCost: 0, totalPoints: 60 }, { event: 2, points: 70, eventTransfersCost: 4, totalPoints: 126 }],
  });
  const p = map.pointsFromNormalized(rows[1]);
  assert.equal(p.reportedGwPoints, 70);
  assert.equal(p.netGwPoints, rows[1].netGwPoints);
  assert.equal(p.grossGwPoints, rows[1].grossGwPoints);
  assert.equal(p.pointsSemantics, rows[1].pointsSemantics);
  assert.equal(p.reconciliationStatus, rows[1].reconciliationStatus);
});

test('managerSeason de-duplicates transfers on time + in + out and keeps the first', () => {
  const T = new Date('2026-09-01T10:00:00Z');
  const t1 = { elementIn: 3, elementInCostTenths: 55, elementOut: 16, elementOutCostTenths: 60, event: 2, time: T };
  const doc = map.managerSeasonToDocument({ season: '2026-27', entryId: 1, chips: [], transfers: [t1, { ...t1 }, { ...t1, elementOut: 17 }] });
  assert.equal(doc.transfers.length, 2);
});

test('live → engine map uses fixturesSettled as deriveEffectiveSquad expects', () => {
  const m = map.liveToEngineMap({ elements: [{ elementId: 7, totalPoints: 6, minutes: 90, settled: true }] });
  assert.deepEqual(m.get(7), { minutes: 90, totalPoints: 6, fixturesSettled: true });
  assert.equal(map.liveToEngineMap(null).size, 0);
});

test('syncRun and rawResponse round trip with string ids', () => {
  const runDoc = withId({ ...docs.syncRun(), requests: [{ path: '/x/', httpStatus: 200, bodySha256: HASH, bytes: 10, durationMs: 5, schemaOk: true, fromCache: false, rawResponseId: RUN_ID }], failures: [], warnings: [{ code: 'W' }], finishedAt: null, lockId: null, lockFencingToken: null }, RUN_ID);
  const run = map.syncRunToDomain(runDoc);
  assert.equal(run.id, String(RUN_ID));
  assert.equal(run.requests[0].rawResponseId, String(RUN_ID));
  assert.deepEqual(map.syncRunToDomain({ ...map.syncRunToDocument(run), _id: RUN_ID }), run);
  const raw = map.rawResponseToDomain(withId({ ...docs.rawResponse(), retainedBySnapshotIds: [RUN_ID] }, RUN_ID));
  assert.equal(raw.syncRunId, String(RUN_ID));
  assert.deepEqual(raw.retainedBySnapshotIds, [String(RUN_ID)]);
  assert.equal(raw.bodyGzip, undefined, 'metadata only');
});

// ── result snapshots / actions: hashes survive the store round trip ──────

const snapshotInput = () => ({
  groupId: String(GROUP_ID), season: '2026-27', event: 5, kind: 'RULE_BASED', winnerRule: 'NET_POINTS',
  tieBreakRules: ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED'], computedWinnerEntryIds: [1], declaredWinnerEntryIds: [1],
  winningScore: 66, tieBreakApplied: undefined, tieBreakTrace: [],
  standings: [{ entryId: 1, score: 66, note: undefined, at: new Date('2026-09-22T19:00:00Z') }],
  inputs: { group: { winnerRule: 'NET_POINTS' }, members: [{ entryId: 1, joinedEvent: null }] }, inputsHash: HASH,
  eventState: 'DATA_CHECKED', engineVersion: '0.1.0',
  sources: [{ syncRunId: String(RUN_ID), startedAt: new Date('2026-09-22T18:00:00Z'), status: 'SUCCESS', requestHashes: [HASH] }],
  computedAt: new Date('2026-09-22T19:05:00Z'),
});

test('snapshot: Mixed payloads are stored canonical, so the content hash recomputes after a round trip', () => {
  const normalized = map.normalizeSnapshot(snapshotInput());
  assert.equal(normalized.tieBreakApplied, null, 'defaults are explicit before hashing');
  assert.equal(normalized.standings[0].note, undefined, 'undefined members are dropped');
  assert.equal(normalized.standings[0].at, '2026-09-22T19:00:00.000Z', 'Dates inside Mixed become ISO strings');
  const hash = map.snapshotContentHashOf(normalized);
  const doc = { _id: new Types.ObjectId(), ...map.snapshotToDocument(normalized, hash) };
  assert.ok(doc.groupId instanceof Types.ObjectId);
  assert.ok(doc.sources[0].syncRunId instanceof Types.ObjectId);
  const back = map.snapshotToDomain(doc);
  assert.equal(back.id, String(doc._id));
  assert.equal(map.snapshotContentHashOf(back), hash);
  assert.equal(snapshotHash({ _id: doc._id, ...map.omitKeys(back, ['id']) }), hash, 'same hash as audit/hashChain.snapshotHash');
});

test('action: the chain hash computed on insert recomputes from the mapped document', () => {
  const fields = map.normalizeActionFields({
    groupId: GROUP_ID, season: '2026-27', event: 5, action: 'FINALIZE', prevStatus: 'PROVISIONAL', newStatus: 'FINAL',
    prevWinnerEntryIds: [], newWinnerEntryIds: [1], prevSnapshotId: null, newSnapshotId: RUN_ID, newSnapshotHash: HASH,
    syncRunId: RUN_ID, createdAt: new Date('2026-09-22T19:05:00Z'),
  });
  assert.equal(fields.actor, 'admin');
  assert.equal(fields.note, null);
  const action = nextAction(null, fields);
  const doc = { _id: new Types.ObjectId(), ...map.actionToDocument(action) };
  const back = map.actionToDomain(doc);
  assert.equal(back.seq, 1);
  assert.equal(back.prevHash, 'GENESIS');
  assert.equal(map.actionHashOf(back), action.hash);
  assert.equal(actionHash(map.omitKeys(back, ['id'])), back.hash);
});

test('provenance helper tolerates Maps (hydrated docs) and plain objects (lean)', () => {
  const p = map.provenanceToDomain(provenance({ sourceRequests: new Map([['picks', HASH]]) }));
  assert.deepEqual(p.sourceRequests, { picks: HASH });
});
