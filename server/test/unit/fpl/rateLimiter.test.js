import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../../../src/fpl/rateLimiter.js';
import { createFplClient } from '../../../src/fpl/index.js';
import { fakeClock, jsonResponse, scriptedFetch, minimalBootstrap, testOptions } from './helpers.js';

// bottleneck runs on real timers, so these tests measure wall-clock time with
// generous upper bounds to stay stable on slow CI machines.

const elapsedSince = (start) => performance.now() - start;
const acquire = (limiter) => limiter.schedule(async () => {});

test('allows a burst up to capacity without waiting', async () => {
  const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1 });
  const start = performance.now();
  await Promise.all([acquire(limiter), acquire(limiter), acquire(limiter)]);
  assert.ok(elapsedSince(start) < 200, `burst took ${elapsedSince(start)}ms`);
  await limiter.stop();
});

test('throttles to the refill rate once the bucket is empty', async () => {
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 20 }); // one token per 50ms
  const start = performance.now();
  const times = [];
  for (let i = 0; i < 6; i++) {
    await acquire(limiter);
    times.push(elapsedSince(start));
  }
  // 2 free, then 4 more at ~50ms intervals => >= ~200ms total.
  assert.ok(times[1] < 40, `burst took ${times[1]}ms`);
  assert.ok(times[5] >= 180, `6 requests finished after only ${times[5]}ms`);
  assert.ok(times[5] < 2000, `6 requests took ${times[5]}ms`);
  await limiter.stop();
});

test('serves concurrent waiters in FIFO order', async () => {
  const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 50 });
  const order = [];
  await Promise.all([1, 2, 3, 4].map((n) => acquire(limiter).then(() => order.push(n))));
  assert.deepEqual(order, [1, 2, 3, 4]);
  await limiter.stop();
});

test('tokens refill over idle time but never exceed capacity', async () => {
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 50 });
  await acquire(limiter);
  await acquire(limiter);
  assert.equal(await limiter.availableTokens(), 0);
  await new Promise((r) => setTimeout(r, 200)); // room for ~10 refills
  assert.equal(await limiter.availableTokens(), 2);
  await limiter.stop();
});

test('rejects invalid configuration', () => {
  assert.throws(() => createRateLimiter({ capacity: 0, refillPerSecond: 1 }), RangeError);
  assert.throws(() => createRateLimiter({ capacity: 1, refillPerSecond: 0 }), RangeError);
});

test('client requests pass through the rate limiter', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([() => jsonResponse(minimalBootstrap())]);
  const client = createFplClient(
    testOptions(clock, { fetch, rateLimit: { capacity: 1, refillPerSecond: 20 }, ttls: { bootstrapStatic: 0 } }),
  );
  const start = performance.now();
  for (let i = 0; i < 3; i++) await client.getBootstrapStatic();
  assert.equal(fetch.calls.length, 3);
  // 1 free, then 2 more at ~50ms intervals.
  assert.ok(elapsedSince(start) >= 90, `3 requests finished after only ${elapsedSince(start)}ms`);
  await client.close();
});
