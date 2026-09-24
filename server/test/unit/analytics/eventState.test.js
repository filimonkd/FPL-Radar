import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEventState } from '../../../src/analytics/eventState.js';

const NOW = new Date('2026-09-20T12:00:00Z');
const ev = (over = {}) => ({ id: 5, deadlineTime: '2026-09-19T17:30:00Z', finished: false, dataChecked: false, ...over });
const fx = (event, done = false) => ({ event, finished: false, finishedProvisional: done });

test('one case per state', () => {
  assert.equal(deriveEventState(ev({ deadlineTime: '2026-09-21T00:00:00Z' }), [fx(5)], NOW), 'UPCOMING');
  assert.equal(deriveEventState(ev(), [fx(5, true), fx(5, false)], NOW), 'LIVE');
  assert.equal(deriveEventState(ev(), [fx(5, true), fx(5, true)], NOW), 'MATCHES_FINISHED');
  assert.equal(deriveEventState(ev({ finished: true }), [fx(5, true)], NOW), 'FPL_PROCESSING');
  assert.equal(deriveEventState(ev({ finished: true, dataChecked: true }), [fx(5, true)], NOW), 'DATA_CHECKED');
});

test('postponed fixture moved to another GW is ignored for the GW it left', () => {
  const fixtures = [fx(5, true), fx(5, true), fx(7, false), { ...fx(null, false) }];
  assert.equal(deriveEventState(ev(), fixtures, NOW), 'MATCHES_FINISHED');
});

test('missing fixtures cannot advance past LIVE unless event.finished', () => {
  assert.equal(deriveEventState(ev(), null, NOW), 'LIVE');
  assert.equal(deriveEventState(ev(), [], NOW), 'LIVE');
  assert.equal(deriveEventState(ev({ finished: true }), null, NOW), 'FPL_PROCESSING');
});

test('revert: data_checked true → false → FPL_PROCESSING', () => {
  assert.equal(deriveEventState(ev({ finished: true, dataChecked: true }), [], NOW), 'DATA_CHECKED');
  assert.equal(deriveEventState(ev({ finished: true, dataChecked: false }), [], NOW), 'FPL_PROCESSING');
});
