import { Lock } from '../models/Lock.js';

// Lease-lock persistence (architecture v0.3 §5). Every operation is a single
// atomic statement evaluated against the server clock ($$NOW), so clock skew
// between app instances does not matter. Callers go through locks/leaseLock.js.
//
// Fencing token: strictly increasing per lock id. Each acquisition sets
// max(previous + 1, server epoch ms), so it keeps increasing even after the TTL
// index removes a long-dead lock document: TTL deletes a lease ≥ 24 h after it
// expired, and tokens can only run ahead of the clock by the number of
// acquisitions within one millisecond. ObjectId order is never used as a sequence.

export const DEFAULT_TTL_MS = 120_000;
const DUPLICATE_KEY = 11000;

const notExpired = { $expr: { $gt: ['$expiresAt', '$$NOW'] } };
const expiryIn = (ttlMs) => ({ $add: ['$$NOW', ttlMs] });

function checkTtl(ttlMs) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new RangeError(`ttlMs must be a positive integer, got ${ttlMs}`);
}

export const lockRepo = {
  /**
   * Acquire the lease when it is free or expired. Returns the lock document, or
   * null when another owner holds an unexpired lease.
   * @param {string} lockId
   * @param {import('mongoose').Types.ObjectId} owner  unique per run
   */
  async acquire(lockId, owner, { ttlMs = DEFAULT_TTL_MS } = {}) {
    checkTtl(ttlMs);
    const grant = [{
      $set: {
        owner,
        fencingToken: { $max: [{ $add: [{ $ifNull: ['$fencingToken', 0] }, 1] }, { $toLong: '$$NOW' }] },
        expiresAt: expiryIn(ttlMs),
        acquiredAt: '$$NOW',
        heartbeatAt: '$$NOW',
        lastWriteAt: null,
      },
    }];
    const opts = { returnDocument: 'after', updatePipeline: true, lean: true };

    // 1. Take over an existing lease that is free or expired (server clock).
    //    MongoDB forbids $expr in an upsert filter, so this step never upserts.
    const taken = await Lock.findOneAndUpdate(
      { _id: lockId, $or: [{ owner: null }, { $expr: { $lte: ['$expiresAt', '$$NOW'] } }] },
      grant,
      opts,
    );
    if (taken) return taken;

    // 2. Create the lease document if it does not exist. The filter can never
    //    match an existing lock (every lock has an owner field), so a held lock
    //    makes the insert collide on _id; so does losing a first-time race.
    try {
      return await Lock.findOneAndUpdate({ _id: lockId, owner: { $exists: false } }, grant, { ...opts, upsert: true });
    } catch (err) {
      if (err.code === DUPLICATE_KEY) return null;
      throw err;
    }
  },

  /** Extend an unexpired lease we still own. Returns false when it was lost. */
  async heartbeat(lockId, owner, fencingToken, { ttlMs = DEFAULT_TTL_MS } = {}) {
    checkTtl(ttlMs);
    const r = await Lock.updateOne(
      { _id: lockId, owner, fencingToken, ...notExpired },
      [{ $set: { expiresAt: expiryIn(ttlMs), heartbeatAt: '$$NOW' } }],
      { updatePipeline: true },
    );
    return r.matchedCount === 1;
  },

  /**
   * Fence write: must be the first statement of every guarded transaction. It
   * writes the lock document, so a concurrent takeover conflicts with the
   * transaction instead of interleaving. Returns false when the lease was lost.
   */
  async fence(lockId, owner, fencingToken, session) {
    if (!session) throw new TypeError('fence requires a transaction session');
    const r = await Lock.updateOne(
      { _id: lockId, owner, fencingToken, ...notExpired },
      [{ $set: { lastWriteAt: '$$NOW' } }],
      { session, updatePipeline: true },
    );
    return r.matchedCount === 1;
  },

  /** Release a lease we own. Idempotent; returns whether this call released it. */
  async release(lockId, owner) {
    const r = await Lock.updateOne(
      { _id: lockId, owner },
      [{ $set: { owner: null, expiresAt: '$$NOW' } }],
      { updatePipeline: true },
    );
    return r.modifiedCount === 1;
  },

  async get(lockId) {
    return Lock.findById(lockId).lean();
  },
};
