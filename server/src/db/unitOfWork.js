import mongoose from 'mongoose';

// The only transaction opener (architecture v0.3 §5, §10). Repositories accept
// { session } and never start their own transactions.
//
// Settings per §5: snapshot reads, majority writes, primary reads and a 10 s
// commit timeout. The driver's withTransaction retries the callback on
// TransientTransactionError and the commit on UnknownTransactionCommitResult,
// so every write inside `fn` must be idempotent (deterministic _id upserts or
// seq-guarded inserts).

export const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
  maxCommitTimeMS: 10_000,
});

/**
 * Runs fn(session) in a transaction and returns fn's result.
 * @template T
 * @param {(session: import('mongoose').ClientSession) => Promise<T>} fn
 * @param {{ connection?: import('mongoose').Connection }} [opts]
 * @returns {Promise<T>}
 */
export async function withTransaction(fn, { connection = mongoose.connection } = {}) {
  const session = await connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    }, TRANSACTION_OPTIONS);
    return result;
  } finally {
    await session.endSession();
  }
}
