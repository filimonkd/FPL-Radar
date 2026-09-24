import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStatus, parseRetryAfter, FplError } from '../../../src/fpl/errors.js';
import { createFplClient, FplErrorKind } from '../../../src/fpl/index.js';
import { fakeClock, jsonResponse, scriptedFetch, testOptions } from './helpers.js';

test('classifies HTTP statuses', () => {
  assert.equal(classifyStatus(404), FplErrorKind.NOT_FOUND);
  assert.equal(classifyStatus(429), FplErrorKind.RATE_LIMITED);
  assert.equal(classifyStatus(500), FplErrorKind.UPSTREAM_UNAVAILABLE);
  assert.equal(classifyStatus(503), FplErrorKind.UPSTREAM_UNAVAILABLE);
  assert.equal(classifyStatus(400), FplErrorKind.HTTP);
  assert.equal(classifyStatus(403), FplErrorKind.HTTP);
});

test('only transient kinds are retryable', () => {
  const retryable = Object.values(FplErrorKind).filter((k) => new FplError(k, '').retryable);
  assert.deepEqual(retryable.sort(), ['network', 'rate_limited', 'timeout', 'upstream_unavailable']);
});

test('parses Retry-After seconds and HTTP-date', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('3', now), 3000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfter('garbage', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});

test('times out a hanging request', async () => {
  const clock = fakeClock();
  const hang = (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const client = createFplClient(testOptions(clock, { fetch: scriptedFetch([hang]), timeoutMs: 20, retry: { maxAttempts: 1 } }));
  await assert.rejects(client.getBootstrapStatic(), (err) => {
    assert.equal(err.kind, FplErrorKind.TIMEOUT);
    assert.equal(err.retryable, true);
    return true;
  });
});

test('retries after a timeout', async () => {
  const clock = fakeClock();
  const hang = (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const fetch = scriptedFetch([hang, jsonResponse({ id: 7, name: 'Entry' })]);
  const client = createFplClient(testOptions(clock, { fetch, timeoutMs: 20 }));
  const entry = await client.getEntry(7);
  assert.equal(entry.id, 7);
  assert.equal(fetch.calls.length, 2);
});

test('classifies network failures', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([new TypeError('fetch failed')]);
  const client = createFplClient(testOptions(clock, { fetch, retry: { maxAttempts: 1 } }));
  await assert.rejects(client.getEntry(1), { kind: FplErrorKind.NETWORK });
});

test('classifies non-JSON bodies', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([new Response('<html>maintenance</html>', { status: 200 })]);
  const client = createFplClient(testOptions(clock, { fetch }));
  await assert.rejects(client.getEntry(1), { kind: FplErrorKind.INVALID_RESPONSE });
  assert.equal(fetch.calls.length, 1);
});

test('classifies other 4xx as non-retryable http errors', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse({}, { status: 403 })]);
  const client = createFplClient(testOptions(clock, { fetch }));
  await assert.rejects(client.getEntry(1), (err) => err.kind === FplErrorKind.HTTP && err.status === 403 && !err.retryable);
  assert.equal(fetch.calls.length, 1);
});

test('rejects invalid ids before any request', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse({})]);
  const client = createFplClient(testOptions(clock, { fetch }));
  await assert.rejects(client.getEntry(0), TypeError);
  await assert.rejects(client.getEntryPicks(1, 'x'), TypeError);
  await assert.rejects(client.getEventLive(1.5), TypeError);
  assert.equal(fetch.calls.length, 0);
});

test('logging hook sees request/response/error and cannot break requests', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse({}, { status: 404 })]);
  const events = [];
  const client = createFplClient(
    testOptions(clock, {
      fetch,
      userAgent: 'fpl-radar-test',
      onEvent: (e) => {
        events.push(e);
        throw new Error('logger bug');
      },
    }),
  );
  await assert.rejects(client.getEntry(5), { kind: FplErrorKind.NOT_FOUND });
  assert.deepEqual(events.map((e) => e.type), ['request', 'response', 'error']);
  assert.equal(events[0].url, 'https://fpl.test/api/entry/5/');
  assert.equal(events[1].status, 404);
  assert.equal(typeof events[1].durationMs, 'number');
  assert.equal(fetch.calls[0].init.headers['user-agent'], 'fpl-radar-test');
});
