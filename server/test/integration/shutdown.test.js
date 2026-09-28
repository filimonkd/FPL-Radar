import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { lockKeys } from '../../src/locks/lockKeys.js';
import { groupRepo, syncRunRepo } from '../../src/repositories/index.js';
import { createSyncService, ShuttingDownError } from '../../src/sync/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// SIGTERM hardening (v0.3 §11): in-flight runs are marked ABANDONED and their
// leases released; nothing they do afterwards can commit or finish as SUCCESS;
// shutdown is idempotent and refuses new runs.

let t;
before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
});
after(async () => { await t.stop(); });

const raw = (coll) => t.db.collection(coll);
const oid = (id) => new mongoose.Types.ObjectId(id);

async function setup(slug) {
  const world = createWorld();
  const sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  const group = await groupRepo.create({ name: slug, slug, memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 101 }, { entryId: 102 }, { entryId: 103 }] });
  return { world, sync, group };
}

function gate(world, path) {
  let open;
  let reached;
  const arrived = new Promise((r) => { reached = r; });
  const released = new Promise((r) => { open = r; });
  world.overrides.set(path, async () => { reached(); await released; return undefined; });
  return { arrived, open };
}

test('a run in flight at shutdown ends ABANDONED, commits nothing more, and frees its lease', async () => {
  const { world, sync, group } = await setup('in-flight');
  const g = gate(world, '/entry/103/transfers/'); // after bootstrap, during the member fetches
  const running = sync.syncGroupGameweek({ groupId: group.id, season: '2026-27', event: GW });
  await g.arrived;
  assert.equal(sync.activeRuns.length, 1);
  const runId = sync.activeRuns[0];

  const first = sync.shutdown();
  assert.equal(sync.shutdown(), first, 'idempotent: the same shutdown');
  assert.deepEqual(await first, { abandoned: [runId] });
  const lock = await raw('locks').findOne({ _id: lockKeys.group(group.id) });
  assert.equal(lock.owner, null, 'lease released');
  assert.equal((await syncRunRepo.get(runId)).status, 'ABANDONED', 'marked before anything could finish it');

  g.open();
  const result = await running;
  assert.equal(result.status, 'ABANDONED', 'never a false success');
  const run = await syncRunRepo.get(runId);
  assert.equal(run.status, 'ABANDONED');
  assert.ok(run.finishedAt instanceof Date);
  assert.equal(await raw('managerGameweeks').countDocuments({ 'provenance.lastConfirmedByRunId': oid(runId) }), 0, 'no member T3 committed after shutdown');
  assert.equal(await raw('managers').countDocuments({ 'provenance.lastConfirmedByRunId': oid(runId) }), 0);
  assert.equal(await raw('liveGameweeks').countDocuments({ 'provenance.lastConfirmedByRunId': oid(runId) }), 0);
  assert.equal(sync.activeRuns.length, 0);
});

test('after shutdown no run can start, and no run document is created', async () => {
  const { sync, group } = await setup('closed');
  await sync.shutdown();
  const before = await raw('syncRuns').countDocuments();
  await assert.rejects(sync.syncGroupGameweek({ groupId: group.id, season: '2026-27', event: GW }), ShuttingDownError);
  await assert.rejects(sync.syncBootstrap({ season: '2026-27' }), ShuttingDownError);
  await assert.rejects(sync.addMembers(group.id, [104]), ShuttingDownError);
  assert.equal(await raw('syncRuns').countDocuments(), before);
  assert.deepEqual(await sync.shutdown(), { abandoned: [] });
});

test('runs that finished before shutdown keep their status; another process can sync right after', async () => {
  const { sync, group, world } = await setup('finished');
  const done = await sync.syncGroupGameweek({ groupId: group.id, season: '2026-27', event: GW });
  assert.equal(done.status, 'SUCCESS');
  assert.deepEqual(await sync.shutdown(), { abandoned: [] });
  assert.equal((await syncRunRepo.get(done.runId)).status, 'SUCCESS');
  const next = createSyncService({ client: worldClient(world), clock: tickingClock(new Date('2026-09-22T20:00:00Z')) });
  assert.equal((await next.syncGroupGameweek({ groupId: group.id, season: '2026-27', event: GW })).status, 'SUCCESS');
});

test('shutdown during a bootstrap-only job abandons it too', async () => {
  const { world, sync } = await setup('bootstrap-job');
  const g = gate(world, '/fixtures/');
  const running = sync.syncBootstrap({ season: '2026-27' });
  await g.arrived;
  const { abandoned } = await sync.shutdown();
  assert.equal(abandoned.length, 1);
  g.open();
  assert.equal((await running).status, 'ABANDONED');
  assert.equal((await raw('locks').findOne({ _id: lockKeys.bootstrap() })).owner, null);
});
