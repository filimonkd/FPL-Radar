// Repository-level errors with stable codes for the API layer.

export class DuplicateMemberError extends Error {
  constructor(entryIds) {
    super(`duplicate member entryId(s): ${entryIds.join(', ')}`);
    this.name = 'DuplicateMemberError';
    this.code = 'DUPLICATE_MEMBER';
    this.entryIds = entryIds;
  }
}

// T4 step 3/4 lost the optimistic race: another decision moved the head (v0.3 §7).
export class ConcurrentDecisionError extends Error {
  constructor(gwResultId, detail) {
    super(`concurrent decision on ${gwResultId}: ${detail}`);
    this.name = 'ConcurrentDecisionError';
    this.code = 'CONCURRENT_DECISION';
    this.status = 409;
    this.gwResultId = gwResultId;
  }
}

export class NotFoundError extends Error {
  constructor(what, id) {
    super(`${what} ${id} not found`);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.status = 404;
  }
}
