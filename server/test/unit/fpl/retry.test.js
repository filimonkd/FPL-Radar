import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, backoffDelay } from '../../../src/fpl/retry.js';
import { createFplClient, FplErrorKind } from '../../../src/fpl/index.js';
import { fakeClock, jsonResponse, scriptedFetch, minimalBootstrap, testOptions } from './helpers.js';

const retryable = () => Object.assign(new Error('boom'), { retryable: true });

test('backoff is exponential and capped', () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 1000 };
  const max = () => 1;
  assert.deepEqual([1, 2, 3, 4, 5].map((a) => backoffDelay(a, policy, max)), [100, 200, 400, 800, 1000]);
  assert.equal(backoffDelay(3, policy, () => 0), 0);
});

test('withRetry retries retryable errors then succeeds', async () => {
  const delays = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw retryable();
      return 'ok';
    },
    { policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }, sleep: async (ms) => delays.push(ms), random: () => 1 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('withRetry gives up after maxAttempts', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw retryable();
    }, { policy: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1 }, sleep: async () => {} }),
    /boom/,
  );
  assert.equal(calls, 4);
});

test('withRetry does not retry non-retryable errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error('fatal');
    }, { policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 }, sleep: async () => {} }),
    /fatal/,
  );
  assert.equal(calls, 1);
});

test('client retries 5xx and succeeds', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([
    jsonResponse({}, { status: 503 }),
    jsonResponse({}, { status: 502 }),
    jsonResponse(minimalBootstrap()),
  ]);
  const events = [];
  const client = createFplClient(testOptions(clock, { fetch, onEvent: (e) => events.push(e) }));
  const data = await client.getBootstrapStatic();
  assert.equal(data.events[0].id, 1);
  assert.equal(fetch.calls.length, 3);
  assert.equal(events.filter((e) => e.type === 'retry').length, 2);
});

test('client does not retry 404', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse({ detail: 'Not found.' }, { status: 404 })]);
  const client = createFplClient(testOptions(clock, { fetch }));
  await assert.rejects(client.getEntry(123), { kind: FplErrorKind.NOT_FOUND, status: 404 });
  assert.equal(fetch.calls.length, 1);
});

test('client honours Retry-After on 429', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([
    jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }),
    jsonResponse(minimalBootstrap()),
  ]);
  const events = [];
  const client = createFplClient(testOptions(clock, { fetch, onEvent: (e) => events.push(e) }));
  await client.getBootstrapStatic();
  const retry = events.find((e) => e.type === 'retry');
  assert.equal(retry.errorKind, FplErrorKind.RATE_LIMITED);
  assert.equal(retry.delayMs, 2000);
});

test('client surfaces the last error after exhausting retries', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse({}, { status: 500 })]);
  const client = createFplClient(testOptions(clock, { fetch, retry: { maxAttempts: 2 } }));
  await assert.rejects(client.getBootstrapStatic(), { kind: FplErrorKind.UPSTREAM_UNAVAILABLE, status: 500 });
  assert.equal(fetch.calls.length, 2);
});
