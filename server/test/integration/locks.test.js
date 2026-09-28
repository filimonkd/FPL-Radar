import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { withTransaction } from '../../src/db/unitOfWork.js';
import { lockRepo } from '../../src/repositories/lockRepo.js';
import { tryAcquireLease, acquireLease, withLease } from '../../src/locks/leaseLock.js';
import { LockBusyError, LockLostError } from '../../src/locks/errors.js';
import { lockKeys } from '../../src/locks/lockKeys.js';
import { Lock, Manager } from '../../src/models/index.js';
import { docs } from '../helpers/docs.js';

const run = promisify(execFile);
const WORKER = fileURLToPath(new URL('../helpers/lockWorker.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let t;
before(async () => { t = await startTestDb(); await runMigrations(t.db); });
after(async () => { await t.stop(); });

const key = () => lockKeys.group(new mongoose.Types.ObjectId());

async function workers(count, env) {
  const startAt = Date.now() + 1500;
  const results = await Promise.all(Array.from({ length: count }, () =>
    run(process.execPath, [WORKER], { env: { ...process.env, TEST_URI: t.uri, TEST_DB: t.dbName, START_AT: String(startAt), ...env } })));
  return results.map((r) => JSON.parse(r.stdout.trim().split('\n').at(-1)));
}

test('first acquire creates the lease document with an owner, expiry and positive token', async () => {
  const id = key();
  const lease = await tryAcquireLease(id, { ttlMs: 60_000 });
  const doc = await lockRepo.get(id);
  assert.equal(String(doc.owner), String(lease.owner));
  assert.ok(doc.expiresAt > new Date());
  assert.ok(Number.isInteger(doc.fencingToken) && doc.fencingToken > 0);
  assert.equal(doc.fencingToken, lease.fencingToken);
});

test('concurrent acquire (in-process): 25 racers, exactly one holder — on a new lock and on a released one', async () => {
  for (const round of [1, 2, 3]) {
    const id = key();
    if (round > 1) {
      const warm = await tryAcquireLease(id, { ttlMs: 60_000 });
      await warm.release(); // race on an existing, free document too
    }
    const leases = await Promise.all(Array.from({ length: 25 }, () => tryAcquireLease(id, { ttlMs: 60_000 })));
    const winners = leases.filter(Boolean);
    assert.equal(winners.length, 1, `round ${round}`);
    assert.equal(String((await lockRepo.get(id)).owner), String(winners[0].owner));
  }
});

test('concurrent acquire (6 separate processes, own connections, same start instant): exactly one holder', async () => {
  const id = key();
  const out = await workers(6, { LOCK_ID: id, MODE: 'acquire' });
  const winners = out.filter((o) => o.acquired);
  assert.equal(winners.length, 1, JSON.stringify(out));
  assert.equal(String((await lockRepo.get(id)).owner), winners[0].owner);
});

test('a held lease blocks others; acquireLease waits for release or throws SYNC_IN_PROGRESS', async () => {
  const id = key();
  const a = await tryAcquireLease(id, { ttlMs: 60_000 });
  assert.equal(await tryAcquireLease(id, { ttlMs: 60_000 }), null);
  await assert.rejects(acquireLease(id, { waitMs: 200, pollMs: 50 }), (e) => e instanceof LockBusyError && e.code === 'SYNC_IN_PROGRESS');
  setTimeout(() => a.release(), 200);
  const b = await acquireLease(id, { waitMs: 5000, pollMs: 50, ttlMs: 60_000 });
  assert.ok(b.fencingToken > a.fencingToken);
});

test('expired takeover: a second process takes an expired lease; the stale holder can no longer heartbeat or fence', async () => {
  const id = key();
  const a = await tryAcquireLease(id, { ttlMs: 300 });
  await sleep(450);
  const [b] = await workers(1, { LOCK_ID: id, MODE: 'acquire', TTL_MS: '60000' });
  assert.equal(b.acquired, true);
  assert.ok(b.token > a.fencingToken);
  assert.equal(await a.heartbeat(), false);
  assert.equal(a.lost, true);
  await assert.rejects(withTransaction(async (session) => { await a.fence(session); }), LockLostError);
});

test('an expired lease is lost even if nobody took it: heartbeat and fence both refuse', async () => {
  const id = key();
  const a = await tryAcquireLease(id, { ttlMs: 250 });
  await sleep(400);
  assert.equal(await lockRepo.heartbeat(id, a.owner, a.fencingToken, { ttlMs: 60_000 }), false);
  await assert.rejects(withTransaction(async (session) => { await a.fence(session); }), LockLostError);
});

test('heartbeat extends an active lease past its original expiry', async () => {
  const id = key();
  const a = await tryAcquireLease(id, { ttlMs: 800 });
  const before = (await lockRepo.get(id)).expiresAt;
  await sleep(500);
  assert.equal(await a.heartbeat(), true);
  const after = (await lockRepo.get(id)).expiresAt;
  assert.ok(after > before, 'expiresAt moved forward');
  await sleep(500); // 1000 ms since acquire: past the original 800 ms expiry
  assert.equal(await tryAcquireLease(id, { ttlMs: 60_000 }), null, 'still held thanks to the heartbeat');
});

test('release is safe and idempotent; only the owner can release', async () => {
  const id = key();
  const a = await tryAcquireLease(id, { ttlMs: 60_000 });
  assert.equal(await lockRepo.release(id, new mongoose.Types.ObjectId()), false, 'a non-owner cannot release');
  assert.equal(await tryAcquireLease(id, { ttlMs: 60_000 }), null, 'still held');
  assert.equal(await a.release(), true);
  assert.equal(await a.release(), false);
  assert.equal(await lockRepo.release(id, a.owner), false, 'repo-level release is idempotent too');
  const doc = await lockRepo.get(id);
  assert.equal(doc.owner, null);
  const b = await tryAcquireLease(id, { ttlMs: 60_000 });
  assert.ok(b && b.fencingToken > a.fencingToken, 'free immediately after release');
  assert.equal(await a.heartbeat(), false, 'a released lease cannot be renewed');
});

test('fencing token is strictly monotonic per scope, even after TTL housekeeping deletes the document', async () => {
  const id = key();
  const tokens = [];
  for (let i = 0; i < 5; i++) {
    const l = await tryAcquireLease(id, { ttlMs: 60_000 });
    tokens.push(l.fencingToken);
    await l.release();
  }
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i] > tokens[i - 1], JSON.stringify(tokens));
  await Lock.collection.deleteOne({ _id: id }); // what the TTL index does to a long-dead lease
  // TTL removes a lease ≥ 24 h after it expired; tokens can only run ahead of the
  // clock by the number of acquisitions within one millisecond, so a short pause
  // models "housekeeping happens later" without depending on sub-ms timing.
  await sleep(50);
  const after = await tryAcquireLease(id, { ttlMs: 60_000 });
  assert.ok(after.fencingToken > tokens.at(-1), `${after.fencingToken} > ${tokens.at(-1)}`);
  const other = await tryAcquireLease(key(), { ttlMs: 60_000 });
  assert.ok(other.fencingToken > 0, 'tokens are per scope');
});

test('transaction fence: a valid lease commits its writes and stamps lastWriteAt', async () => {
  const id = key();
  const a = await tryAcquireLease(id, { ttlMs: 60_000 });
  await withTransaction(async (session) => {
    await a.fence(session);
    await Manager.create([docs.manager({ entryId: 801 })], { session });
  });
  assert.equal(await Manager.countDocuments({ _id: 801 }), 1);
  assert.ok((await lockRepo.get(id)).lastWriteAt instanceof Date);
});

test('stale-fence rejection: after a takeover the old holder’s transaction aborts and writes nothing', async () => {
  const id = key();
  const a = await tryAcquireLease(id, { ttlMs: 300 });
  await sleep(450);
  const b = await tryAcquireLease(id, { ttlMs: 60_000 });
  assert.ok(b);
  await assert.rejects(withTransaction(async (session) => {
    await a.fence(session);
    await Manager.create([docs.manager({ entryId: 802 })], { session });
  }), LockLostError);
  assert.equal(await Manager.countDocuments({ _id: 802 }), 0);
  // The new holder fences fine.
  await withTransaction(async (session) => { await b.fence(session); });
});

test('fence vs takeover race: the takeover waits for the fenced transaction to finish, then gets a higher token', async () => {
  const id = key();
  const a = await tryAcquireLease(id, { ttlMs: 400 });
  let committedAt = 0;
  let takeoverAt = 0;
  let takeover;
  await withTransaction(async (session) => {
    await a.fence(session); // lease valid: fence succeeds and writes the lock document
    await Manager.create([docs.manager({ entryId: 803 })], { session });
    await sleep(600); // lease expires while the transaction is still open
    takeover = tryAcquireLease(id, { ttlMs: 60_000 }).then((l) => { takeoverAt = Date.now(); return l; });
    await sleep(300);
    assert.equal(takeoverAt, 0, 'takeover is blocked behind the uncommitted fence write');
  });
  committedAt = Date.now();
  const b = await takeover;
  assert.ok(b, 'takeover succeeds once the transaction ends');
  assert.ok(takeoverAt >= committedAt - 5, 'takeover completed only after the commit');
  assert.ok(b.fencingToken > a.fencingToken);
  assert.equal(await Manager.countDocuments({ _id: 803 }), 1, 'the fenced writes committed before the new holder');
  await assert.rejects(withTransaction(async (session) => { await a.fence(session); }), LockLostError);
});

test('withLease heartbeats a short lease through long work, then releases', async () => {
  const id = key();
  let blockedMidway;
  const result = await withLease(id, async (lease) => {
    // > 3× the TTL. The TTL leaves room for a runner stall between beats: a
    // lease that really expires is (correctly) lost, which is not what this tests.
    await sleep(3_200);
    blockedMidway = await tryAcquireLease(id, { ttlMs: 60_000 });
    await withTransaction(async (session) => { await lease.fence(session); });
    return 'done';
  }, { ttlMs: 1_000, heartbeatMs: 100 });
  assert.equal(result, 'done');
  assert.equal(blockedMidway, null, 'a competitor could not take it while heartbeating');
  assert.equal((await lockRepo.get(id)).owner, null, 'released at the end');
});

test('withLease: a stolen lease triggers onLost and the next fence aborts; the lease is still released safely', async () => {
  const id = key();
  const lost = [];
  await assert.rejects(withLease(id, async (lease) => {
    // Simulate a takeover by another holder (as after an expiry nobody renewed).
    await Lock.collection.updateOne({ _id: id }, { $set: { owner: new mongoose.Types.ObjectId() }, $inc: { fencingToken: 1 } });
    await sleep(250);
    await withTransaction(async (session) => { await lease.fence(session); });
  }, { ttlMs: 60_000, heartbeatMs: 50, onLost: (e) => lost.push(e) }), LockLostError);
  assert.equal(lost.length, 1);
  assert.notEqual((await lockRepo.get(id)).owner, null, 'release by the loser did not free the new holder’s lease');
});

test('error paths: invalid TTL, fence without a transaction session', async () => {
  await assert.rejects(lockRepo.acquire(key(), new mongoose.Types.ObjectId(), { ttlMs: 0 }), RangeError);
  await assert.rejects(lockRepo.heartbeat(key(), new mongoose.Types.ObjectId(), 1, { ttlMs: -5 }), RangeError);
  await assert.rejects(lockRepo.fence(key(), new mongoose.Types.ObjectId(), 1, undefined), TypeError);
});

test('boot migrations under the migrate lease: 4 processes on a fresh database apply each migration exactly once', async () => {
  const fresh = `${t.dbName}_mig`;
  const startAt = Date.now() + 1500;
  const out = (await Promise.all(Array.from({ length: 4 }, () =>
    run(process.execPath, [WORKER], { env: { ...process.env, TEST_URI: t.uri, TEST_DB: fresh, START_AT: String(startAt), MODE: 'migrate' } }))))
    .map((r) => JSON.parse(r.stdout.trim().split('\n').at(-1)));
  const appliedCounts = out.map((o) => o.applied.length).sort();
  assert.deepEqual(appliedCounts, [0, 0, 0, 2], JSON.stringify(out));
  const db = mongoose.connection.client.db(fresh);
  assert.equal(await db.collection('_migrations').countDocuments(), 2);
  const lock = await db.collection('locks').findOne({ _id: 'migrate' });
  assert.equal(lock.owner, null, 'migrate lease released');
  assert.ok((await db.listCollections({ name: 'locks' }).toArray())[0].options.validator, 'locks got its validator via collMod');
  await db.dropDatabase();
});

test('the migrate lease is visibly held while another process migrates', async () => {
  const lease = await tryAcquireLease(lockKeys.migrate(), { ttlMs: 60_000 });
  assert.ok(lease);
  await assert.rejects(acquireLease(lockKeys.migrate(), { waitMs: 100, pollMs: 25 }), LockBusyError);
  await lease.release();
});
