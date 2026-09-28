// Lock errors (architecture v0.3 §5).

// The lease is held by someone else → API maps this to 409 SYNC_IN_PROGRESS.
export class LockBusyError extends Error {
  constructor(lockId) {
    super(`lock ${lockId} is held by another run`);
    this.name = 'LockBusyError';
    this.code = 'SYNC_IN_PROGRESS';
    this.lockId = lockId;
  }
}

// The lease expired or was taken over → the run aborts and is marked FAILED (LOCK_LOST).
export class LockLostError extends Error {
  constructor(lockId, op) {
    super(`lease on ${lockId} lost (${op})`);
    this.name = 'LockLostError';
    this.code = 'LOCK_LOST';
    this.lockId = lockId;
    this.op = op;
  }
}
