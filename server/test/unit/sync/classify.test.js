import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FplError, FplErrorKind } from '../../../src/fpl/errors.js';
import { LockLostError } from '../../../src/locks/errors.js';
import { classifyFailure, failureOf, SyncStageError } from '../../../src/sync/classify.js';

// Blocked / auth / error classification of sync failures (Step 7).

const resp = (status, text = '', headers = {}) => ({ status, text, contentType: headers['content-type'] ?? 'application/json', denyReason: headers['x-deny-reason'] ?? null, cfMitigated: headers['cf-mitigated'] ?? null, location: headers.location ?? null });
const err = (kind, response = null) => new FplError(kind, 'x', { status: response?.status, response });

test('BLOCKED needs a concrete denial indicator', () => {
  assert.equal(classifyFailure(err(FplErrorKind.HTTP, resp(403, 'Host not in allowlist', { 'x-deny-reason': 'host_not_allowed' }))), 'BLOCKED');
  assert.equal(classifyFailure(err(FplErrorKind.HTTP, resp(403, '', { 'cf-mitigated': 'challenge' }))), 'BLOCKED');
  assert.equal(classifyFailure(err(FplErrorKind.RATE_LIMITED, resp(429, '<title>Just a moment...</title>', { 'content-type': 'text/html' }))), 'BLOCKED');
  assert.equal(classifyFailure(err(FplErrorKind.RATE_LIMITED, resp(429, '{}'))), 'RATE_LIMITED', 'a plain 429 is FPL answering');
});

test('AUTH_REQUIRED for 401/403 without a block indicator, and for league login pages', () => {
  assert.equal(classifyFailure(err(FplErrorKind.HTTP, resp(403, '{"detail":"Authentication credentials were not provided."}'))), 'AUTH_REQUIRED');
  assert.equal(classifyFailure(err(FplErrorKind.HTTP, resp(401, '{}'))), 'AUTH_REQUIRED');
  const loginPage = err(FplErrorKind.INVALID_RESPONSE, resp(200, '<html>Sign in to users.premierleague.com</html>', { 'content-type': 'text/html' }));
  assert.equal(classifyFailure(loginPage, { league: true }), 'AUTH_REQUIRED');
  assert.equal(classifyFailure(loginPage), 'INVALID_RESPONSE', 'only league reads treat a login page as auth');
});

test('other failures map from the client error kind', () => {
  assert.equal(classifyFailure(err(FplErrorKind.NOT_FOUND, resp(404, '{}'))), 'NOT_FOUND');
  assert.equal(classifyFailure(err(FplErrorKind.UPSTREAM_UNAVAILABLE, resp(500, '{}'))), 'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyFailure(err(FplErrorKind.UPSTREAM_UNAVAILABLE, resp(503, 'The game is being updated.', { 'content-type': 'text/html' }))), 'UPDATING');
  assert.equal(classifyFailure(err(FplErrorKind.VALIDATION, resp(200, '{}'))), 'SCHEMA_FAIL');
  assert.equal(classifyFailure(err(FplErrorKind.TIMEOUT)), 'TIMEOUT');
  assert.equal(classifyFailure(err(FplErrorKind.NETWORK)), 'NETWORK');
  assert.equal(classifyFailure(err(FplErrorKind.CIRCUIT_OPEN)), 'CIRCUIT_OPEN');
  assert.equal(classifyFailure(err(FplErrorKind.HTTP, resp(418, '{}'))), 'HTTP_ERROR');
  assert.equal(classifyFailure(new SyncStageError('SEASON_MISMATCH', 'x')), 'SEASON_MISMATCH');
  assert.equal(classifyFailure(new LockLostError('l', 'fence')), 'LOCK_LOST');
  assert.equal(classifyFailure(new Error('boom')), 'INTERNAL');
});

test('failureOf builds a syncRuns.failures[] entry with the stage in the message', () => {
  assert.deepEqual(failureOf(err(FplErrorKind.NOT_FOUND, resp(404)), { entryId: 7, stage: 'fetch' }), { entryId: 7, code: 'NOT_FOUND', message: 'fetch: x' });
  assert.equal(failureOf(new Error('y'.repeat(900))).message.length, 500);
});
