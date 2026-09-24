import { EventState as ES } from './constants.js';

// Event state machine and finalization gate (architecture v0.2 §3). Pure:
// `now` is passed in; nothing reads the clock.

const toDate = (v) => (v instanceof Date ? v : new Date(v));

/**
 * @param {{ id: number, deadlineTime: Date|string, finished: boolean, dataChecked: boolean }} event
 * @param {{ event: number|null, finished: boolean, finishedProvisional: boolean }[]|null} fixtures
 * @param {Date} now
 */
export function deriveEventState(event, fixtures, now) {
  if (event.dataChecked === true) return ES.DATA_CHECKED;
  if (event.finished === true) return ES.FPL_PROCESSING;
  // Fixtures moved to another GW (or unscheduled, event = null) are ignored.
  const gwFixtures = Array.isArray(fixtures) ? fixtures.filter((f) => f.event === event.id) : [];
  if (gwFixtures.length > 0 && gwFixtures.every((f) => f.finishedProvisional === true || f.finished === true)) {
    return ES.MATCHES_FINISHED;
  }
  if (toDate(now).getTime() >= toDate(event.deadlineTime).getTime()) return ES.LIVE;
  return ES.UPCOMING;
}

export const FinalizeBlockReason = Object.freeze({
  GROUP_ARCHIVED: 'GROUP_ARCHIVED',
  NOT_DATA_CHECKED: 'NOT_DATA_CHECKED',
  ALREADY_FINAL: 'ALREADY_FINAL',
  STALE_SYNC: 'STALE_SYNC',
  RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
  NO_ELIGIBLE_MANAGERS: 'NO_ELIGIBLE_MANAGERS',
});

const RECONCILED = ['RECONCILED', 'RECONCILED_NO_COST'];

/**
 * Returns every failing reason, not just the first.
 * @param {{ groupActive: boolean, eventState: string, resultStatus: string|null, dataCheckedObservedAt: Date|null,
 *   eligibleRows: { entryId: number, reconciliationStatus: string|null, syncRunStartedAt: Date|null, syncRunStatus: string|null }[] }} ctx
 */
export function canFinalize({ groupActive, eventState, resultStatus, dataCheckedObservedAt, eligibleRows }) {
  const reasons = [];
  if (!groupActive) reasons.push(FinalizeBlockReason.GROUP_ARCHIVED);
  if (eventState !== ES.DATA_CHECKED) reasons.push(FinalizeBlockReason.NOT_DATA_CHECKED);
  if (resultStatus === 'FINAL' || resultStatus === 'OVERRIDDEN') reasons.push(FinalizeBlockReason.ALREADY_FINAL);

  const observed = dataCheckedObservedAt ? toDate(dataCheckedObservedAt).getTime() : null;
  const stale = eligibleRows.some(
    (r) =>
      r.syncRunStatus !== 'SUCCESS' ||
      r.syncRunStartedAt == null ||
      observed === null ||
      toDate(r.syncRunStartedAt).getTime() <= observed,
  );
  if (stale) reasons.push(FinalizeBlockReason.STALE_SYNC);
  if (eligibleRows.some((r) => !RECONCILED.includes(r.reconciliationStatus))) reasons.push(FinalizeBlockReason.RECONCILIATION_FAILED);
  if (eligibleRows.length === 0) reasons.push(FinalizeBlockReason.NO_ELIGIBLE_MANAGERS);
  return { allowed: reasons.length === 0, reasons };
}
