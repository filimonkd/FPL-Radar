import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canFinalize } from '../../../src/analytics/eventState.js';

const OBSERVED = new Date('2026-09-22T10:00:00Z');
const fresh = (entryId, over = {}) => ({
  entryId, reconciliationStatus: 'RECONCILED', syncRunStartedAt: new Date('2026-09-22T11:00:00Z'), syncRunStatus: 'SUCCESS', ...over,
});
const ctx = (over = {}) => ({
  groupActive: true, eventState: 'DATA_CHECKED', resultStatus: null, dataCheckedObservedAt: OBSERVED,
  eligibleRows: [fresh(1), fresh(2, { reconciliationStatus: 'RECONCILED_NO_COST' })], ...over,
});

test('allowed: DATA_CHECKED, fresh SUCCESS runs, all reconciled', () => {
  assert.deepEqual(canFinalize(ctx()), { allowed: true, reasons: [] });
  assert.equal(canFinalize(ctx({ resultStatus: 'PROVISIONAL' })).allowed, true);
});

test('each reason', () => {
  const reasonsOf = (over) => canFinalize(ctx(over)).reasons;
  assert.deepEqual(reasonsOf({ groupActive: false }), ['GROUP_ARCHIVED']);
  assert.deepEqual(reasonsOf({ eventState: 'MATCHES_FINISHED' }), ['NOT_DATA_CHECKED']);
  assert.deepEqual(reasonsOf({ eventState: 'FPL_PROCESSING' }), ['NOT_DATA_CHECKED']);
  assert.deepEqual(reasonsOf({ resultStatus: 'FINAL' }), ['ALREADY_FINAL']);
  assert.deepEqual(reasonsOf({ resultStatus: 'OVERRIDDEN' }), ['ALREADY_FINAL']);
  assert.deepEqual(reasonsOf({ eligibleRows: [fresh(1, { syncRunStartedAt: new Date('2026-09-22T09:00:00Z') })] }), ['STALE_SYNC']);
  assert.deepEqual(reasonsOf({ eligibleRows: [fresh(1, { syncRunStatus: 'PARTIAL' })] }), ['STALE_SYNC']);
  assert.deepEqual(reasonsOf({ eligibleRows: [fresh(1, { syncRunStatus: 'ABANDONED' })] }), ['STALE_SYNC']);
  assert.deepEqual(reasonsOf({ eligibleRows: [fresh(1, { reconciliationStatus: 'MISMATCH' })] }), ['RECONCILIATION_FAILED']);
  assert.deepEqual(reasonsOf({ eligibleRows: [] }), ['NO_ELIGIBLE_MANAGERS']);
});

test('multiple reasons: all returned, not just the first', () => {
  const r = canFinalize(ctx({
    groupActive: false, eventState: 'LIVE', resultStatus: 'FINAL', dataCheckedObservedAt: null,
    eligibleRows: [fresh(1, { reconciliationStatus: 'INCOMPLETE' })],
  }));
  assert.equal(r.allowed, false);
  assert.deepEqual(r.reasons, ['GROUP_ARCHIVED', 'NOT_DATA_CHECKED', 'ALREADY_FINAL', 'STALE_SYNC', 'RECONCILIATION_FAILED']);
});
