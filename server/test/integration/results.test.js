import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { withTransaction } from '../../src/db/unitOfWork.js';
import { acquireLease } from '../../src/locks/leaseLock.js';
import { lockKeys } from '../../src/locks/lockKeys.js';
import { computeGwResult, canFinalize, deriveEffectiveSquad, computeOwnership, selectEligible } from '../../src/analytics/index.js';
import { ResultSnapshot, GwResultAction, ImmutableCollectionError } from '../../src/models/index.js';
import { groupRepo, resultRepo, syncRunRepo, rawResponseRepo, ownershipRepo, ConcurrentDecisionError } from '../../src/repositories/index.js';
import { SEASON, GW, newId, gwRow, startRun, syncAll, decide, snapshotFrom, fetchBody } from '../helpers/repoFixtures.js';

// T4 finalize / override / recompute through the repositories (architecture
// v0.3 §7, §8; Step 6 gate): expected documents, append-only enforcement,
// fork rejection, chain verification, tamper detection and the provenance
// chain gwResults → resultSnapshots → sources[] → syncRuns → requests[] →
// fplRawResponses.

let t;
let lease;
let group;
let runDoc;
let sync;
let finalized;
before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
});
after(async () => {
  await lease?.release();
  await t.stop();
});

const raw = (coll) => t.db.collection(coll);
const oid = (id) => new mongoose.Types.ObjectId(id);
const at = (m) => new Date(Date.UTC(2026, 8, 22, 20, m));

// Entry 1 and 3 tie on net 70; 1 has the smaller transfer cost.
const MEMBERS = [
  { entryId: 1, row: gwRow(1, { R: 70, T: 350 }) },
  { entryId: 2, row: gwRow(2, { R: 60, T: 330, captainOffset: 2 }) },
  { entryId: 3, row: gwRow(3, { R: 74, C: 4, net: 70, gross: 74, T: 340, status: 'RECONCILED', semantics: 'GROSS_BEFORE_HITS', hypothesis: 'GROSS' }) },
];

test('setup: a synced group under a group lease', async () => {
  group = await groupRepo.create({
    name: 'Group B', slug: 'group-b', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', myEntryId: 1,
    members: MEMBERS.map((m) => ({ entryId: m.entryId, addedAt: at(0) })),
  });
  lease = await acquireLease(lockKeys.group(group.id), { ttlMs: 120_000 });
  runDoc = await startRun({ lease, target: group.id });
  sync = await syncAll({ lease, members: MEMBERS, runDoc });
  assert.equal(await syncRunRepo.finish(runDoc.id, { status: 'SUCCESS', finishedAt: at(1) }), true);
});

test('loadResultInputs assembles exactly what computeGwResult and canFinalize take', async () => {
  const inputs = await resultRepo.loadResultInputs(group.id, SEASON, GW);
  assert.deepEqual(inputs.group, { winnerRule: 'NET_POINTS', tieBreakRules: ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED'], myEntryId: 1 });
  assert.equal(inputs.event, GW);
  assert.equal(inputs.eventState, 'DATA_CHECKED');
  assert.deepEqual(inputs.members, MEMBERS.map((m) => ({ entryId: m.entryId, isExcluded: false, joinedEvent: null, synced: true })));
  assert.deepEqual(inputs.gwRows.map((r) => [r.entryId, r.netGwPoints, r.transferCost, r.pointsSemantics]), [[1, 70, 0, 'UNVERIFIED'], [2, 60, 0, 'UNVERIFIED'], [3, 70, 4, 'GROSS_BEFORE_HITS']]);
  assert.equal(inputs.effectiveSquads.size, 3);
  assert.equal(inputs.managers.get(2).playerName, 'Manager 2');
  assert.deepEqual(inputs.freshness.map((f) => [f.entryId, f.syncRunId, f.syncRunStatus]), MEMBERS.map((m) => [m.entryId, runDoc.id, 'SUCCESS']));
  assert.deepEqual(inputs.gate, { groupActive: true, dataCheckedObservedAt: new Date('2026-09-22T18:00:00Z'), resultStatus: null });

  // sources[]: one entry per confirming run, with every request hash behind the inputs.
  assert.equal(inputs.sources.length, 1);
  const [src] = inputs.sources;
  assert.equal(src.syncRunId, runDoc.id);
  assert.equal(src.status, 'SUCCESS');
  for (const { entryId } of MEMBERS) {
    assert.ok(src.requestHashes.includes(sync.hashes[entryId].history));
    assert.ok(src.requestHashes.includes(sync.hashes[entryId].picks));
  }
  assert.ok(src.requestHashes.includes(sync.liveHash));
  assert.deepEqual(src.requestHashes, [...src.requestHashes].sort());
});

test('T4 finalize writes the snapshot, the GENESIS action and the pointer, and makes the evidence permanent', async () => {
  const inputs = await resultRepo.loadResultInputs(group.id, SEASON, GW);
  const result = computeGwResult(inputs);
  assert.equal(result.status, 'PROVISIONAL');
  assert.deepEqual(result.winners, [1]);
  assert.equal(result.tieBreakApplied, 'FEWER_TRANSFER_COST');
  const eligibleRows = inputs.gwRows.map((r) => ({ entryId: r.entryId, reconciliationStatus: r.reconciliationStatus, ...inputs.freshness.find((f) => f.entryId === r.entryId) }));
  assert.deepEqual(canFinalize({ ...inputs.gate, eventState: inputs.eventState, eligibleRows }), { allowed: true, reasons: [] });

  // Unrelated retention: a SCHEMA_FAIL capture and an unreferenced FINAL_EVIDENCE body keep their TTL.
  await rawResponseRepo.insert({ syncRunId: runDoc.id, path: '/schema-fail/', body: '{}', reason: 'SCHEMA_FAIL', capturedAt: at(0) });
  const otherRun = await startRun({ trigger: 'MANUAL' });
  await fetchBody(otherRun, '/entry/1/history/', '{"unreferenced":true}');

  const snapInput = snapshotFrom(group.id, result, inputs, { computedAt: at(2), group: inputs.group });
  finalized = await decide({ lease, groupId: group.id, action: 'FINALIZE', snapshot: snapInput, syncRunId: runDoc.id, at: at(2) });
  const { snapshot, action, pointer } = finalized;

  assert.equal(snapshot.kind, 'RULE_BASED');
  assert.deepEqual(snapshot.declaredWinnerEntryIds, [1]);
  assert.equal(snapshot.inputsHash, result.inputsHash);
  assert.match(snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual({ seq: action.seq, prevHash: action.prevHash, action: action.action, prevStatus: action.prevStatus, newStatus: action.newStatus, prevSnapshotId: action.prevSnapshotId },
    { seq: 1, prevHash: 'GENESIS', action: 'FINALIZE', prevStatus: 'PROVISIONAL', newStatus: 'FINAL', prevSnapshotId: null });
  assert.equal(action.newSnapshotHash, snapshot.contentHash);
  assert.deepEqual({ id: pointer.id, status: pointer.status, headSeq: pointer.headSeq, headHash: pointer.headHash, currentSnapshotId: pointer.currentSnapshotId },
    { id: `${group.id}:${SEASON}:${GW}`, status: 'FINAL', headSeq: 1, headHash: action.hash, currentSnapshotId: snapshot.id });

  // Retention (T4 step 5): the source run and its referenced evidence lose expireAt.
  assert.equal((await raw('syncRuns').findOne({ _id: oid(runDoc.id) })).expireAt, undefined);
  assert.ok((await raw('syncRuns').findOne({ _id: oid(otherRun.id) })).expireAt instanceof Date);
  const evidence = await raw('fplRawResponses').find({ syncRunId: oid(runDoc.id), reason: 'FINAL_EVIDENCE' }).toArray();
  assert.ok(evidence.length >= 7);
  for (const e of evidence) {
    assert.equal(e.expireAt, undefined, e.path);
    assert.deepEqual(e.retainedBySnapshotIds.map(String), [snapshot.id]);
  }
  assert.ok((await raw('fplRawResponses').findOne({ path: '/schema-fail/' })).expireAt instanceof Date);
  assert.ok((await raw('fplRawResponses').findOne({ syncRunId: oid(otherRun.id) })).expireAt instanceof Date);
  assert.ok((await raw('fplRawResponses').findOne({ syncRunId: oid(runDoc.id), reason: 'SMOKE' })).expireAt instanceof Date, 'SMOKE bodies are not evidence');

  const again = await resultRepo.loadResultInputs(group.id, SEASON, GW);
  assert.equal(again.gate.resultStatus, 'FINAL');
  assert.ok(canFinalize({ ...again.gate, eventState: again.eventState, eligibleRows }).reasons.includes('ALREADY_FINAL'));
});

test('provenance trace: pointer → snapshot → sources → run → requests → raw responses', async () => {
  const pointer = await resultRepo.getPointer(group.id, SEASON, GW);
  const trace = await resultRepo.loadTrace(pointer.currentSnapshotId);
  assert.equal(trace.snapshot.id, finalized.snapshot.id);
  assert.equal(trace.sources.length, 1);
  const [src] = trace.sources;
  assert.equal(src.run.id, runDoc.id);
  assert.equal(src.run.status, 'SUCCESS');
  assert.equal(src.run.expireAt, null, 'retained permanently');
  assert.equal(src.requests.length, src.requestHashes.length, 'every source hash appears in the run request log');
  for (const q of src.requests) assert.ok(src.requestHashes.includes(q.bodySha256));
  const history1 = src.requests.find((q) => q.path === '/entry/1/history/');
  assert.ok(history1.rawResponseId);
  const rawDoc = trace.rawResponses.find((r) => r.id === history1.rawResponseId);
  assert.equal(rawDoc.bodySha256, history1.bodySha256);
  const body = await rawResponseRepo.getBody(rawDoc.id);
  assert.equal(JSON.parse(body).entry, 1);
  assert.equal(trace.rawResponses.every((r) => r.syncRunId === runDoc.id), true);

  // Traceability (v0.3 §15): sources[] covers every input document's lastConfirmedByRunId.
  const confirmers = new Set();
  for (const coll of ['managerGameweeks', 'managerSeasons', 'managers']) {
    for (const d of await raw(coll).find({ entryId: { $in: MEMBERS.map((m) => m.entryId) }, ...(coll === 'managerGameweeks' ? { event: GW } : {}) }).toArray()) {
      confirmers.add(String(d.provenance.lastConfirmedByRunId));
    }
  }
  for (const id of [`${SEASON}:${GW}`]) {
    confirmers.add(String((await raw('events').findOne({ _id: id })).provenance.lastConfirmedByRunId));
    confirmers.add(String((await raw('liveGameweeks').findOne({ _id: id })).provenance.lastConfirmedByRunId));
  }
  assert.deepEqual([...confirmers], trace.snapshot.sources.map((s) => s.syncRunId));
});

test('override appends seq 2 without touching the finalized snapshot or action', async () => {
  const snap1Before = await raw('resultSnapshots').findOne({ _id: oid(finalized.snapshot.id) });
  const act1Before = await raw('gwResultActions').findOne({ _id: oid(finalized.action.id) });
  const inputs = await resultRepo.loadResultInputs(group.id, SEASON, GW);
  const result = computeGwResult(inputs);
  const input = snapshotFrom(group.id, result, inputs, { kind: 'OVERRIDE', declared: [3], computedAt: at(3), group: inputs.group });

  // An override without a note is rejected and the whole T4 rolls back.
  const counts = async () => [await raw('resultSnapshots').countDocuments(), await raw('gwResultActions').countDocuments()];
  const before = await counts();
  await assert.rejects(decide({ lease, groupId: group.id, action: 'OVERRIDE', snapshot: input, at: at(3) }), /override requires a note/);
  assert.deepEqual(await counts(), before);

  const o = await decide({ lease, groupId: group.id, action: 'OVERRIDE', snapshot: input, note: 'Ruled by the league chair', at: at(3) });
  assert.deepEqual({ seq: o.action.seq, prevHash: o.action.prevHash, prevStatus: o.action.prevStatus, newStatus: o.action.newStatus, prevSnapshotId: o.action.prevSnapshotId, prevWinnerEntryIds: o.action.prevWinnerEntryIds, newWinnerEntryIds: o.action.newWinnerEntryIds },
    { seq: 2, prevHash: finalized.action.hash, prevStatus: 'FINAL', newStatus: 'OVERRIDDEN', prevSnapshotId: finalized.snapshot.id, prevWinnerEntryIds: [1], newWinnerEntryIds: [3] });
  assert.deepEqual(o.snapshot.computedWinnerEntryIds, [1], 'what the rules said is kept');
  assert.equal(o.pointer.status, 'OVERRIDDEN');
  assert.equal(o.pointer.headSeq, 2);
  assert.deepEqual(await raw('resultSnapshots').findOne({ _id: oid(finalized.snapshot.id) }), snap1Before);
  assert.deepEqual(await raw('gwResultActions').findOne({ _id: oid(finalized.action.id) }), act1Before);
});

test('recompute appends seq 3; the chain verifies and history lists in seq order', async () => {
  const inputs = await resultRepo.loadResultInputs(group.id, SEASON, GW);
  const result = computeGwResult(inputs);
  const r = await decide({ lease, groupId: group.id, action: 'RECOMPUTE', snapshot: snapshotFrom(group.id, result, inputs, { computedAt: at(4), group: inputs.group }), syncRunId: runDoc.id, at: at(4) });
  assert.equal(r.action.seq, 3);
  assert.equal(r.pointer.status, 'FINAL');
  const actions = await resultRepo.listActions(group.id, SEASON, GW);
  assert.deepEqual(actions.map((a) => [a.seq, a.action]), [[1, 'FINALIZE'], [2, 'OVERRIDE'], [3, 'RECOMPUTE']]);
  assert.deepEqual(await resultRepo.verifyChain(group.id, SEASON, GW), { valid: true });
  assert.equal((await resultRepo.listSnapshots(group.id, SEASON, GW)).length, 3);
  assert.equal((await resultRepo.getCurrentSnapshot(group.id, SEASON, GW)).id, r.snapshot.id);
  assert.deepEqual((await resultRepo.listPointers(group.id, SEASON)).map((p) => p.event), [GW]);
  assert.deepEqual((await resultRepo.listRecentActions(group.id, { limit: 2 })).map((a) => a.seq), [3, 2]);
});

test('snapshots and actions are immutable through every Mongoose path', async () => {
  const s = finalized.snapshot.id;
  const a = finalized.action.id;
  await assert.rejects(ResultSnapshot.updateOne({ _id: s }, { $set: { winningScore: 1 } }), ImmutableCollectionError);
  await assert.rejects(ResultSnapshot.findOneAndUpdate({ _id: s }, { $set: { kind: 'OVERRIDE' } }), ImmutableCollectionError);
  await assert.rejects(ResultSnapshot.deleteOne({ _id: s }), ImmutableCollectionError);
  await assert.rejects(ResultSnapshot.replaceOne({ _id: s }, {}), ImmutableCollectionError);
  await assert.rejects(ResultSnapshot.bulkWrite([{ deleteOne: { filter: { _id: s } } }]), ImmutableCollectionError);
  await assert.rejects(GwResultAction.updateMany({}, { $set: { note: 'x' } }), ImmutableCollectionError);
  await assert.rejects(GwResultAction.deleteMany({}), ImmutableCollectionError);
  await assert.rejects(GwResultAction.findOneAndDelete({ _id: a }), ImmutableCollectionError);
  const doc = await GwResultAction.findById(a);
  doc.note = 'rewritten';
  await assert.rejects(doc.save(), ImmutableCollectionError);
  assert.equal((await resultRepo.listActions(group.id, SEASON, GW))[0].note, null);
});

test('a fork is rejected: a stale head cannot append or move the pointer', async () => {
  const stale = await resultRepo.getPointer(group.id, SEASON, GW); // seq 3
  const inputs = await resultRepo.loadResultInputs(group.id, SEASON, GW);
  const input = snapshotFrom(group.id, computeGwResult(inputs), inputs, { computedAt: at(5), group: inputs.group });
  await decide({ lease, groupId: group.id, action: 'RECOMPUTE', snapshot: input, at: at(5) }); // seq 4

  const counts = async () => [await raw('resultSnapshots').countDocuments(), await raw('gwResultActions').countDocuments()];
  const before = await counts();
  await assert.rejects(withTransaction(async (session) => {
    await lease.fence(session);
    const snap = await resultRepo.insertSnapshot({ ...input, computedAt: at(6) }, { session });
    await resultRepo.appendAction(stale, {
      groupId: group.id, season: SEASON, event: GW, action: 'RECOMPUTE', prevStatus: stale.status, newStatus: 'FINAL',
      prevWinnerEntryIds: [1], newWinnerEntryIds: [1], prevSnapshotId: stale.currentSnapshotId, newSnapshotId: snap.id,
      newSnapshotHash: snap.contentHash, createdAt: at(6),
    }, { session });
  }), (err) => err instanceof ConcurrentDecisionError && err.code === 'CONCURRENT_DECISION' && /seq 4 already exists/.test(err.message));
  assert.deepEqual(await counts(), before, 'the rejected decision left nothing behind');

  // movePointer with a stale head matches nothing; a second "first decision" collides.
  await assert.rejects(withTransaction(async (session) => {
    await resultRepo.movePointer(stale, { groupId: group.id, season: SEASON, event: GW, seq: 4, newStatus: 'FINAL', newSnapshotId: stale.currentSnapshotId, hash: stale.headHash, createdAt: at(6) }, { session });
  }), ConcurrentDecisionError);
  await assert.rejects(withTransaction(async (session) => {
    await resultRepo.movePointer(null, { groupId: group.id, season: SEASON, event: GW, seq: 1, newStatus: 'FINAL', newSnapshotId: stale.currentSnapshotId, hash: stale.headHash, createdAt: at(6) }, { session });
  }), ConcurrentDecisionError);
  assert.equal((await resultRepo.getPointer(group.id, SEASON, GW)).headSeq, 4);
  assert.deepEqual(await resultRepo.verifyChain(group.id, SEASON, GW), { valid: true });
});

test('appendAction refuses an action that does not continue the head', async () => {
  const head = await resultRepo.getPointer(group.id, SEASON, GW);
  await assert.rejects(withTransaction((session) => resultRepo.appendAction(head, {
    groupId: group.id, season: SEASON, event: GW, action: 'RECOMPUTE', prevStatus: 'FINAL', newStatus: 'FINAL',
    prevWinnerEntryIds: [], newWinnerEntryIds: [], prevSnapshotId: null, newSnapshotId: head.currentSnapshotId, newSnapshotHash: head.headHash, createdAt: at(7),
  }, { session })), /prevSnapshotId must be the head's currentSnapshotId/);
  await assert.rejects(resultRepo.insertSnapshot({}, {}), /must run inside/);
});

test('tampering is detected: edited snapshot, edited action, deleted snapshot, moved pointer', async () => {
  const actions = await resultRepo.listActions(group.id, SEASON, GW);
  const snapId = oid(actions[1].newSnapshotId);
  const actId = oid(actions[2].id);
  const verify = () => resultRepo.verifyChain(group.id, SEASON, GW);

  // Native driver bypasses layers 1–2 on purpose, as an attacker with DB access would.
  const snapBefore = await raw('resultSnapshots').findOne({ _id: snapId });
  await raw('resultSnapshots').updateOne({ _id: snapId }, { $set: { declaredWinnerEntryIds: [2] } });
  assert.deepEqual(await verify(), { valid: false, brokenAtSeq: 2, reason: 'SNAPSHOT_HASH_MISMATCH' });
  await raw('resultSnapshots').replaceOne({ _id: snapId }, snapBefore);

  await raw('gwResultActions').updateOne({ _id: actId }, { $set: { note: 'edited' } });
  assert.deepEqual(await verify(), { valid: false, brokenAtSeq: 3, reason: 'ACTION_HASH_MISMATCH' });
  await raw('gwResultActions').updateOne({ _id: actId }, { $set: { note: null } });

  await raw('resultSnapshots').deleteOne({ _id: snapId });
  assert.deepEqual(await verify(), { valid: false, brokenAtSeq: 2, reason: 'SNAPSHOT_MISSING' });
  await raw('resultSnapshots').insertOne(snapBefore);

  const pointerId = `${group.id}:${SEASON}:${GW}`;
  await raw('gwResults').updateOne({ _id: pointerId }, { $inc: { headSeq: -1 } });
  assert.equal((await verify()).reason, 'POINTER_HEAD_MISMATCH');
  await raw('gwResults').updateOne({ _id: pointerId }, { $inc: { headSeq: 1 } });

  assert.deepEqual(await verify(), { valid: true }, 'restored chain verifies again');
});

test('an unsynced member blocks the result and has no freshness', async () => {
  const g2 = await groupRepo.create({
    name: 'With a stranger', slug: 'with-stranger', memberSource: 'MANUAL', winnerRule: 'GROSS_POINTS',
    members: [{ entryId: 1, addedAt: at(0) }, { entryId: 404, addedAt: at(0) }],
  });
  const inputs = await resultRepo.loadResultInputs(g2.id, SEASON, GW);
  assert.deepEqual(inputs.members.map((m) => [m.entryId, m.synced]), [[1, true], [404, false]]);
  assert.deepEqual(inputs.freshness.find((f) => f.entryId === 404), { entryId: 404, syncRunId: null, syncRunStartedAt: null, syncRunStatus: null });
  const result = computeGwResult(inputs);
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockedBy, [{ entryId: 404, reconciliationStatus: 'NOT_SYNCED' }]);
  assert.equal(result.winners.length, 0);
});

test('ownershipRepo.loadSquads feeds deriveEffectiveSquad and computeOwnership', async () => {
  const data = await ownershipRepo.loadSquads(group.id, SEASON, GW);
  assert.equal(data.myEntryId, 1);
  assert.deepEqual(data.squads.map((s) => s.entryId), [1, 2, 3]);
  assert.equal(data.players.size, 15);
  assert.deepEqual(data.live.get(1), { minutes: 90, totalPoints: 5, fixturesSettled: true });
  const squads = new Map(data.squads.map((s) => [s.entryId, deriveEffectiveSquad({ ...s, live: data.live })]));
  const { eligible } = selectEligible(data.members, new Map(data.gwRows.map((r) => [r.entryId, r])), GW);
  const own = computeOwnership({ squads, eligible, myEntryId: data.myEntryId, players: data.players });
  assert.equal(own.denominators.all, 3);
  assert.deepEqual(own.missingEntryIds, []);
  const p1 = own.rows.find((r) => r.player.elementId === 1);
  assert.equal(p1.pickedSquad.all.count, 3);
});

test('no read path depends on TTL: runs and bodies are still readable, and expiry is only housekeeping', async () => {
  const runs = await syncRunRepo.getMany([runDoc.id]);
  assert.equal(runs[0].status, 'SUCCESS');
  assert.equal(await raw('syncRuns').countDocuments({ _id: oid(runDoc.id), expireAt: { $exists: false } }), 1);
  const idx = await raw('syncRuns').indexes();
  assert.ok(idx.some((i) => i.name === 'ttl_expireAt' && i.expireAfterSeconds === 0));
});
