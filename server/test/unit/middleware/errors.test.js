import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mapError } from '../../../src/middleware/errors.js';
import { AppError } from '../../../src/errors.js';
import { DuplicateMemberError, NotFoundError, ConcurrentDecisionError } from '../../../src/repositories/errors.js';
import { GroupArchivedError, ShuttingDownError } from '../../../src/sync/index.js';
import { SyncStageError } from '../../../src/sync/classify.js';
import { LockBusyError, LockLostError } from '../../../src/locks/errors.js';
import { FplError, FplErrorKind } from '../../../src/fpl/errors.js';

// Error → HTTP mapping (Step 8). Stable codes; no internals in 500s.

const pick = (e) => { const m = mapError(e); return [m.status, m.code]; };

test('request, document and JSON errors', () => {
  const zerr = z.object({ a: z.number() }).safeParse({ a: 'x' }).error;
  const m = mapError(zerr);
  assert.deepEqual([m.status, m.code], [400, 'VALIDATION_FAILED']);
  assert.equal(m.details.issues[0].path, 'a');
  assert.deepEqual(pick(Object.assign(new SyntaxError('x'), { type: 'entity.parse.failed' })), [400, 'INVALID_JSON']);
  assert.deepEqual(pick(Object.assign(new Error('x'), { type: 'entity.too.large' })), [413, 'PAYLOAD_TOO_LARGE']);
  assert.deepEqual(pick(Object.assign(new Error('v'), { name: 'ValidationError', errors: { name: { message: 'required' } } })), [422, 'VALIDATION_FAILED']);
});

test('domain errors keep their architecture codes', () => {
  assert.deepEqual(pick(new AppError(409, 'LEAGUE_ALREADY_CONFIGURED', 'x')), [409, 'LEAGUE_ALREADY_CONFIGURED']);
  assert.deepEqual(pick(new NotFoundError('group', 'x')), [404, 'NOT_FOUND']);
  const dup = mapError(new DuplicateMemberError([3, 1]));
  assert.deepEqual([dup.status, dup.code, dup.details], [409, 'DUPLICATE_MEMBER', { entryIds: [3, 1] }]);
  assert.deepEqual(pick(new GroupArchivedError('g')), [409, 'GROUP_ARCHIVED']);
  assert.deepEqual(pick(new LockBusyError('l')), [409, 'SYNC_IN_PROGRESS']);
  assert.deepEqual(pick(new ConcurrentDecisionError('g', 'x')), [409, 'CONCURRENT_DECISION']);
  assert.deepEqual(pick(new ShuttingDownError()), [503, 'SHUTTING_DOWN']);
  assert.deepEqual(pick(new LockLostError('l', 'fence')), [503, 'LOCK_LOST']);
  assert.deepEqual(pick(Object.assign(new Error('dup'), { code: 11000, keyPattern: { slug: 1 } })), [409, 'SLUG_TAKEN']);
  assert.deepEqual(pick(Object.assign(new Error('dup'), { code: 11000, keyPattern: { fplLeagueId: 1 } })), [409, 'LEAGUE_ALREADY_CONFIGURED']);
});

test('league access and FPL outages are distinct: never an empty league', () => {
  const na = mapError(new SyncStageError('LEAGUE_NOT_ACCESSIBLE', 'x', { access: 'AUTH_REQUIRED' }));
  assert.deepEqual([na.status, na.code, na.details], [422, 'LEAGUE_NOT_ACCESSIBLE', { access: 'AUTH_REQUIRED' }]);
  assert.deepEqual(pick(new SyncStageError('INVALID_ENTRY_IDS', 'x', { invalid: [9] })), [422, 'INVALID_ENTRY_IDS']);
  const blocked = mapError(new FplError(FplErrorKind.HTTP, 'x', { status: 403, response: { status: 403, text: '', denyReason: 'host_not_allowed' } }));
  assert.deepEqual([blocked.status, blocked.code, blocked.details], [502, 'FPL_UNAVAILABLE', { cause: 'BLOCKED' }]);
  assert.deepEqual(pick(new SyncStageError('RUN_FAILED', 'x')), [502, 'SYNC_FAILED']);
});

test('unknown errors are a bare 500', () => {
  const m = mapError(new TypeError('secret internals'));
  assert.deepEqual(m, { status: 500, code: 'INTERNAL_ERROR', message: 'internal error' });
});
