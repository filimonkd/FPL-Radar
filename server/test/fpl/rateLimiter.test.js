import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../../src/fpl/rateLimiter.js';
import { createFplClient } from '../../src/fpl/index.js';
import { fakeClock, jsonResponse, scriptedFetch, minimalBootstrap, testOptions } from './helpers.js';

test('allows a burst up to capacity without waiting', async () => {
  const clock = fakeClock();
  const start = clock.now();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 }, clock);
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.equal(clock.now(), start);
});

test('throttles to the refill rate once the bucket is empty', async () => {
  const clock = fakeClock();
  const start = clock.now();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 4 }, clock);
  const times = [];
  for (let i = 0; i < 6; i++) {
    await limiter.acquire();
    times.push(clock.now() - start);
  }
  // 2 free, then one token every 250ms.
  assert.deepEqual(times, [0, 0, 250, 500, 750, 1000]);
});

test('serves concurrent waiters in FIFO order', async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 10 }, clock);
  const order = [];
  await Promise.all([1, 2, 3, 4].map((n) => limiter.acquire().then(() => order.push(n))));
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('tokens refill over idle time but never exceed capacity', () => {
  const clock = fakeClock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, clock);
  clock.advance(60_000);
  assert.equal(limiter.availableTokens, 2);
});

test('rejects invalid configuration', () => {
  assert.throws(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 }, fakeClock()), RangeError);
  assert.throws(() => new RateLimiter({ capacity: 1, refillPerSecond: 0 }, fakeClock()), RangeError);
});

test('client requests pass through the rate limiter', async () => {
  const clock = fakeClock();
  const start = clock.now();
  const fetch = scriptedFetch([() => jsonResponse(minimalBootstrap())]);
  const client = createFplClient(
    testOptions(clock, { fetch, rateLimit: { capacity: 1, refillPerSecond: 2 }, ttls: { bootstrapStatic: 0 } }),
  );
  for (let i = 0; i < 3; i++) await client.getBootstrapStatic();
  assert.equal(fetch.calls.length, 3);
  assert.equal(clock.now() - start, 1000);
});
