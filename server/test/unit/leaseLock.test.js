import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lease, tryAcquireLease, acquireLease, withLease } from '../../src/locks/leaseLock.js';
import { LockBusyError, LockLostError } from '../../src/locks/errors.js';
import { lockKeys } from '../../src/locks/lockKeys.js';

// In-memory stand-in for lockRepo: exercises Lease logic and error paths without a DB.
function fakeRepo({ acquireResults = [], heartbeatResults = [], fenceResults = [] } = {}) {
  const calls = { acquire: 0, heartbeat: 0, fence: 0, release: 0 };
  const next = (list, fallback) => (list.length ? list.shift() : fallback);
  return {
    calls,
    async acquire() { calls.acquire += 1; return next(acquireResults, { fencingToken: 7 }); },
    async heartbeat() { calls.heartbeat += 1; const r = next(heartbeatResults, true); if (r instanceof Error) throw r; return r; },
    async fence() { calls.fence += 1; return next(fenceResults, true); },
    async release() { calls.release += 1; return true; },
  };
}

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('lock keys are deterministic and scoped', () => {
  assert.equal(lockKeys.group('66f0c1a2b3c4d5e6f7a8b9c0'), 'sync:group:66f0c1a2b3c4d5e6f7a8b9c0');
  assert.equal(lockKeys.bootstrap(), 'sync:bootstrap');
  assert.equal(lockKeys.migrate(), 'migrate');
});

test('tryAcquireLease returns a lease with the repo token, or null when held', async () => {
  const lease = await tryAcquireLease('x', { repo: fakeRepo({ acquireResults: [{ fencingToken: 42 }] }) });
  assert.equal(lease.fencingToken, 42);
  assert.ok(lease.owner, 'a unique owner id is generated per lease');
  assert.equal(await tryAcquireLease('x', { repo: fakeRepo({ acquireResults: [null] }) }), null);
});

test('acquireLease polls until free, and throws LockBusyError (SYNC_IN_PROGRESS) on timeout', async () => {
  const repo = fakeRepo({ acquireResults: [null, null, { fencingToken: 3 }] });
  const lease = await acquireLease('x', { repo, waitMs: 10_000, sleep: async () => {} });
  assert.equal(lease.fencingToken, 3);
  assert.equal(repo.calls.acquire, 3);
  await assert.rejects(acquireLease('x', { repo: fakeRepo({ acquireResults: [null, null, null] }), waitMs: 0 }), (e) => e instanceof LockBusyError && e.code === 'SYNC_IN_PROGRESS');
});

test('a lost heartbeat marks the lease lost; fence then refuses without touching the DB', async () => {
  const repo = fakeRepo({ heartbeatResults: [false] });
  const lease = new Lease({ lockId: 'x', owner: 'o', fencingToken: 1, ttlMs: 1000, repo });
  assert.equal(await lease.heartbeat(), false);
  assert.equal(lease.lost, true);
  await assert.rejects(lease.fence({}), (e) => e instanceof LockLostError && e.code === 'LOCK_LOST');
  assert.equal(repo.calls.fence, 0);
});

test('a failed fence marks the lease lost and throws LockLostError', async () => {
  const lease = new Lease({ lockId: 'x', owner: 'o', fencingToken: 1, ttlMs: 1000, repo: fakeRepo({ fenceResults: [false] }) });
  await assert.rejects(lease.fence({}), LockLostError);
  assert.equal(lease.lost, true);
});

test('release is idempotent and stops the heartbeat', async () => {
  const repo = fakeRepo();
  const lease = new Lease({ lockId: 'x', owner: 'o', fencingToken: 1, ttlMs: 1000, repo });
  lease.startHeartbeat({ intervalMs: 5 });
  assert.equal(await lease.release(), true);
  assert.equal(await lease.release(), false);
  const beats = repo.calls.heartbeat;
  await flush();
  assert.equal(repo.calls.heartbeat, beats, 'no heartbeats after release');
  assert.equal(repo.calls.release, 1);
});

test('heartbeat timer: a transient DB error is not a lost lease; a failed renewal calls onLost once', async () => {
  const repo = fakeRepo({ heartbeatResults: [new Error('network blip'), true, false] });
  const lease = new Lease({ lockId: 'x', owner: 'o', fencingToken: 1, ttlMs: 1000, repo });
  const lost = [];
  lease.startHeartbeat({ intervalMs: 5, onLost: (e) => lost.push(e) });
  await flush(80);
  assert.equal(lost.length, 1);
  assert.ok(lost[0] instanceof LockLostError);
  assert.equal(lease.lost, true);
  assert.equal(repo.calls.heartbeat, 3, 'stops beating after the loss');
});

test('withLease releases on success and on failure, returning or rethrowing fn’s outcome', async () => {
  const ok = fakeRepo();
  assert.equal(await withLease('x', async (lease) => lease.fencingToken * 2, { repo: ok, heartbeatMs: 1000 }), 14);
  assert.equal(ok.calls.release, 1);
  const bad = fakeRepo();
  await assert.rejects(withLease('x', async () => { throw new Error('work failed'); }, { repo: bad, heartbeatMs: 1000 }), /work failed/);
  assert.equal(bad.calls.release, 1);
});
