// Transactions are opened only by db/unitOfWork.js (v0.3 §5, §10). Methods on
// the T1–T4 boundaries refuse to run outside one instead of opening their own.
export function requireTransaction(session, method) {
  if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) {
    throw new TypeError(`${method} must run inside a db/unitOfWork transaction (pass { session })`);
  }
  return session;
}

/** Mongoose query option object for an optional session. */
export const sessionOpt = (session) => (session ? { session } : {});
