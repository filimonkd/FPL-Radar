import { Types } from 'mongoose';
import { lockRepo, DEFAULT_TTL_MS } from '../repositories/lockRepo.js';
import { LockBusyError, LockLostError } from './errors.js';

// Lease lock with fencing (architecture v0.3 §5), built on lockRepo.
//
//   const lease = await acquireLease(lockKeys.group(id));
//   await withTransaction(async (session) => { await lease.fence(session); …writes… });
//   await lease.release();
//
// or withLease(lockId, async (lease) => …), which heartbeats and always releases.

export const DEFAULT_HEARTBEAT_MS = 30_000;

export class Lease {
  #stopTimer = null;

  constructor({ lockId, owner, fencingToken, ttlMs, repo = lockRepo }) {
    this.lockId = lockId;
    this.owner = owner; // unique per run (the run's ObjectId): identity only, never ordering
    this.fencingToken = fencingToken;
    this.ttlMs = ttlMs;
    this.lost = false;
    this.released = false;
    this.repo = repo;
  }

  /** Extends the lease; marks it lost (and returns false) if it expired or was taken over. */
  async heartbeat() {
    if (this.lost || this.released) return false;
    const ok = await this.repo.heartbeat(this.lockId, this.owner, this.fencingToken, { ttlMs: this.ttlMs });
    if (!ok) this.lost = true;
    return ok;
  }

  /** First statement of a guarded transaction; throws LockLostError to abort it. */
  async fence(session) {
    if (this.lost || this.released) throw new LockLostError(this.lockId, 'fence');
    const ok = await this.repo.fence(this.lockId, this.owner, this.fencingToken, session);
    if (!ok) {
      this.lost = true;
      throw new LockLostError(this.lockId, 'fence');
    }
  }

  /** Safe to call repeatedly, and after the lease was lost. */
  async release() {
    this.stopHeartbeat();
    if (this.released) return false;
    this.released = true;
    return this.repo.release(this.lockId, this.owner);
  }

  /** Heartbeats every intervalMs; calls onLost(error) once if the lease is lost. */
  startHeartbeat({ intervalMs = DEFAULT_HEARTBEAT_MS, onLost = () => {} } = {}) {
    this.stopHeartbeat();
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        if (!(await this.heartbeat())) {
          this.stopHeartbeat();
          onLost(new LockLostError(this.lockId, 'heartbeat'));
        }
      } catch {
        // A transient DB error is not proof of a lost lease; the next beat or fence decides.
      } finally {
        running = false;
      }
    }, intervalMs);
    timer.unref?.();
    this.#stopTimer = () => clearInterval(timer);
  }

  stopHeartbeat() {
    this.#stopTimer?.();
    this.#stopTimer = null;
  }
}

/**
 * Tries once to acquire; returns a Lease, or null when held elsewhere.
 * @param {string} lockId  from locks/lockKeys.js
 */
export async function tryAcquireLease(lockId, { owner = new Types.ObjectId(), ttlMs = DEFAULT_TTL_MS, repo = lockRepo } = {}) {
  const doc = await repo.acquire(lockId, owner, { ttlMs });
  return doc ? new Lease({ lockId, owner, fencingToken: doc.fencingToken, ttlMs, repo }) : null;
}

/** Acquires, polling for up to waitMs while held; throws LockBusyError on timeout. */
export async function acquireLease(lockId, { waitMs = 0, pollMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...opts } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lease = await tryAcquireLease(lockId, opts);
    if (lease) return lease;
    if (Date.now() >= deadline) throw new LockBusyError(lockId);
    await sleep(pollMs);
  }
}

/**
 * Runs fn(lease) under the lease with a heartbeat, always releasing afterwards.
 * If the heartbeat detects a lost lease, fn's next fence() throws LockLostError.
 */
export async function withLease(lockId, fn, { heartbeatMs = DEFAULT_HEARTBEAT_MS, onLost, ...opts } = {}) {
  const lease = await acquireLease(lockId, opts);
  lease.startHeartbeat({ intervalMs: heartbeatMs, onLost });
  try {
    return await fn(lease);
  } finally {
    await lease.release().catch(() => {}); // never mask fn's outcome; expiry frees it anyway
  }
}
