import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createSyncService } from '../../src/sync/index.js';
import { createResultService } from '../../src/services/resultService.js';
import { groupRepo } from '../../src/repositories/index.js';
import { runDbCheck } from '../../src/ops/dbCheck.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 12: npm run db:check (v0.3 §10 I1–I8) on a realistic synced + finalized
// + overridden dataset: clean first, then one tampering per invariant (each
// undone afterwards), then the CLI's exit codes. Synthetic data only.

const SEASON = '2026-27';
const SCRIPT = fileURLToPath(new URL('../../scripts/dbCheck.js', import.meta.url));
// Asynchronous: spawnSync would block the event loop that drains the in-memory mongod's log pipe.
const runCli = (env) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT], { env, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout, stderr }));
});
let t;
let group;
let pointer;
let actions;
let snapshot;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  const world = createWorld();
  const sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  const results = createResultService({ sync });
  group = await groupRepo.create({ name: 'Check', slug: 'check', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [101, 102, 103].map((entryId) => ({ entryId })) });
  await results.finalize(group.id, SEASON, GW).catch(() => {}); // first ever: STALE_SYNC by design
  await results.finalize(group.id, SEASON, GW);
  await results.override(group.id, SEASON, GW, { winners: [101], note: 'admin decision' });
  pointer = await raw('gwResults').findOne({});
  actions = await raw('gwResultActions').find({}).sort({ seq: 1 }).toArray();
  snapshot = await raw('resultSnapshots').findOne({ _id: pointer.currentSnapshotId });
  assert.equal(actions.length, 2);
});
after(async () => t.stop());

const raw = (c) => t.db.collection(c);
const check = () => runDbCheck(t.db);
const invariants = (r) => [...new Set(r.violations.filter((v) => v.severity === 'ERROR').map((v) => v.invariant))].sort();

async function counts() {
  const out = {};
  for (const c of await t.db.listCollections().toArray()) out[c.name] = await raw(c.name).countDocuments();
  return out;
}

/** Applies `tamper`, runs the check, undoes it, and confirms the database is clean again. */
async function tampered(tamper, undo) {
  await tamper();
  try {
    return await check();
  } finally {
    await undo();
    const r = await check();
    assert.deepEqual([r.ok, r.counts.error], [true, 0], `undo left errors: ${JSON.stringify(r.violations)}`);
  }
}

test('a synced, finalized and overridden database is clean, and the scan is read-only', async () => {
  const before = await counts();
  const r = await check();
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.counts, { error: 0, info: 0 });
  assert.equal(r.dbName, t.dbName);
  assert.ok(!Number.isNaN(Date.parse(r.checkedAt)));
  assert.deepEqual(await counts(), before);
});

test('I1 duplicate member', async () => {
  const r = await tampered(
    () => raw('groups').updateOne({ _id: new mongoose.Types.ObjectId(group.id) }, { $push: { members: { entryId: 101, isExcluded: false, addedAt: new Date() } } }),
    () => raw('groups').updateOne({ _id: new mongoose.Types.ObjectId(group.id) }, { $pop: { members: 1 } }),
  );
  assert.deepEqual(invariants(r), ['I1']);
});

test('I2 id that does not rebuild from its fields', async () => {
  const doc = await raw('events').findOne({});
  const r = await tampered(
    () => raw('events').insertOne({ ...doc, _id: `${SEASON}:39` }),
    () => raw('events').deleteOne({ _id: `${SEASON}:39` }),
  );
  assert.deepEqual(invariants(r), ['I2']);
});

test('I3 orphan member and myEntryId outside the group', async () => {
  const id = new mongoose.Types.ObjectId(group.id);
  const r = await tampered(
    () => raw('groups').updateOne({ _id: id }, { $push: { members: { entryId: 424242, isExcluded: false, addedAt: new Date() } }, $set: { myEntryId: 424243 } }),
    () => raw('groups').updateOne({ _id: id }, { $pop: { members: 1 }, $set: { myEntryId: null } }),
  );
  assert.deepEqual(invariants(r), ['I3']);
  assert.equal(r.violations.length, 3);
});

test('I4 pointer to a missing snapshot', async () => {
  const r = await tampered(
    () => raw('gwResults').updateOne({ _id: pointer._id }, { $set: { currentSnapshotId: new mongoose.Types.ObjectId() } }),
    () => raw('gwResults').updateOne({ _id: pointer._id }, { $set: { currentSnapshotId: pointer.currentSnapshotId } }),
  );
  assert.ok(invariants(r).includes('I4'));
});

test('I4/I5 an edited snapshot or action breaks its hash', async () => {
  let r = await tampered(
    () => raw('resultSnapshots').updateOne({ _id: snapshot._id }, { $set: { declaredWinnerEntryIds: [102] } }),
    () => raw('resultSnapshots').updateOne({ _id: snapshot._id }, { $set: { declaredWinnerEntryIds: snapshot.declaredWinnerEntryIds } }),
  );
  assert.deepEqual(invariants(r), ['I4', 'I5']);
  r = await tampered(
    () => raw('gwResultActions').updateOne({ _id: actions[0]._id }, { $set: { note: 'rewritten history' } }),
    () => raw('gwResultActions').updateOne({ _id: actions[0]._id }, { $set: { note: actions[0].note } }),
  );
  assert.deepEqual(invariants(r), ['I5']);
  assert.match(r.violations[0].detail, /seq 1: ACTION_HASH_MISMATCH/);
});

test('I5 a missing action is a gap / head mismatch', async () => {
  const r = await tampered(
    () => raw('gwResultActions').deleteOne({ _id: actions[1]._id }),
    () => raw('gwResultActions').insertOne(actions[1]),
  );
  assert.ok(invariants(r).includes('I5'));
});

test('I6/I7 a missing or still-expiring source run', async () => {
  const runId = snapshot.sources[0].syncRunId;
  const run = await raw('syncRuns').findOne({ _id: runId });
  let r = await tampered(
    () => raw('syncRuns').deleteOne({ _id: runId }),
    () => raw('syncRuns').insertOne(run),
  );
  assert.deepEqual(invariants(r), ['I6', 'I7']);
  r = await tampered(
    () => raw('syncRuns').updateOne({ _id: runId }, { $set: { expireAt: new Date(Date.now() + 86_400_000) } }),
    () => raw('syncRuns').updateOne({ _id: runId }, { $unset: { expireAt: '' } }),
  );
  assert.deepEqual(invariants(r), ['I7']);
});

test('I6 INFO: provenance pointing at a TTL-expired run is not an error', async () => {
  const doc = await raw('managerGameweeks').findOne({});
  const r = await tampered(
    () => raw('managerGameweeks').updateOne({ _id: doc._id }, { $set: { 'provenance.lastConfirmedByRunId': new mongoose.Types.ObjectId() } }),
    () => raw('managerGameweeks').updateOne({ _id: doc._id }, { $set: { 'provenance.lastConfirmedByRunId': doc.provenance.lastConfirmedByRunId } }),
  );
  assert.deepEqual([r.ok, r.counts], [true, { error: 0, info: 1 }]);
  assert.deepEqual([r.violations[0].invariant, r.violations[0].severity], ['I6', 'INFO']);
});

test('I8 invalid stored picks', async () => {
  const doc = await raw('managerGameweeks').findOne({ hasPicks: true });
  const r = await tampered(
    () => raw('managerGameweeks').updateOne({ _id: doc._id }, { $set: { 'picks.1.isCaptain': true } }),
    () => raw('managerGameweeks').updateOne({ _id: doc._id }, { $set: { 'picks.1.isCaptain': doc.picks[1].isCaptain } }),
  );
  assert.deepEqual(invariants(r), ['I8']);
  assert.match(r.violations[0].detail, /expected 1 captain, got 2/);
});

test('npm run db:check: JSON report, exit 0 when clean and 1 on any ERROR', async () => {
  const env = { ...process.env, MONGODB_URI: t.uri, MONGODB_DB: t.dbName };
  let out = await runCli(env);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).ok, true);
  const doc = await raw('managerGameweeks').findOne({ hasPicks: true });
  await raw('managerGameweeks').updateOne({ _id: doc._id }, { $set: { 'picks.1.isCaptain': true } });
  try {
    out = await runCli(env);
    assert.equal(out.status, 1);
    assert.deepEqual(JSON.parse(out.stdout).counts, { error: 1, info: 0 });
  } finally {
    await raw('managerGameweeks').updateOne({ _id: doc._id }, { $set: { 'picks.1.isCaptain': doc.picks[1].isCaptain } });
  }
  out = await runCli({ ...process.env, MONGODB_URI: '', MONGODB_DB: '' });
  assert.equal(out.status, 1, 'refuses to run without a target');
});
