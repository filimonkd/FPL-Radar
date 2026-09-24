// Shared enums of the analytics layer (architecture v0.2 §2–§7).

export const PointsSemantics = Object.freeze({
  GROSS_BEFORE_HITS: 'GROSS_BEFORE_HITS',
  NET_AFTER_HITS: 'NET_AFTER_HITS',
  UNVERIFIED: 'UNVERIFIED',
  CONFLICTED: 'CONFLICTED',
});

export const ReconciliationStatus = Object.freeze({
  RECONCILED: 'RECONCILED',
  RECONCILED_NO_COST: 'RECONCILED_NO_COST',
  MISMATCH: 'MISMATCH',
  SEMANTICS_CONFLICT: 'SEMANTICS_CONFLICT',
  SOURCE_DISAGREEMENT: 'SOURCE_DISAGREEMENT',
  INCOMPLETE: 'INCOMPLETE',
});

export const RECONCILED_STATUSES = Object.freeze([ReconciliationStatus.RECONCILED, ReconciliationStatus.RECONCILED_NO_COST]);
export const isReconciled = (status) => RECONCILED_STATUSES.includes(status);

export const EventState = Object.freeze({
  UPCOMING: 'UPCOMING',
  LIVE: 'LIVE',
  MATCHES_FINISHED: 'MATCHES_FINISHED',
  FPL_PROCESSING: 'FPL_PROCESSING',
  DATA_CHECKED: 'DATA_CHECKED',
});

export const WinnerRule = Object.freeze({ NET_POINTS: 'NET_POINTS', GROSS_POINTS: 'GROSS_POINTS' });
