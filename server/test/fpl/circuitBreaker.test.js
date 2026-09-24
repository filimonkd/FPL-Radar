import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitState } from '../../src/fpl/circuitBreaker.js';
import { FplError, FplErrorKind } from '../../src/fpl/errors.js';
import { createFplClient } from '../../src/fpl/index.js';
import { fakeClock, jsonResponse, scriptedFetch, minimalBootstrap, testOptions } from './helpers.js';

const upstream = () => new FplError(FplErrorKind.UPSTREAM_UNAVAILABLE, 'down');
const notFound = () => new FplError(FplErrorKind.NOT_FOUND, 'missing');
const fail = (errFactory) => () => Promise.reject(errFactory());
const ok = () => Promise.resolve('ok');

function breaker(clock, changes = []) {
  return new CircuitBreaker(
    { failureThreshold: 3, resetTimeoutMs: 1000 },
    { now: clock.now, onStateChange: (c) => changes.push(`${c.from}->${c.to}`) },
  );
}

test('opens after consecutive upstream failures and rejects fast', async () => {
  const clock = fakeClock();
  const cb = breaker(clock);
  for (let i = 0; i < 3; i++) await assert.rejects(cb.execute(fail(upstream)));
  assert.equal(cb.state, CircuitState.OPEN);

  let called = false;
  await assert.rejects(cb.execute(async () => { called = true; }), { kind: FplErrorKind.CIRCUIT_OPEN });
  assert.equal(called, false);
});

test('a success resets the consecutive failure count', async () => {
  const cb = breaker(fakeClock());
  await assert.rejects(cb.execute(fail(upstream)));
  await assert.rejects(cb.execute(fail(upstream)));
  await cb.execute(ok);
  await assert.rejects(cb.execute(fail(upstream)));
  await assert.rejects(cb.execute(fail(upstream)));
  assert.equal(cb.state, CircuitState.CLOSED);
});

test('non-upstream errors (e.g. 404) do not trip the breaker', async () => {
  const cb = breaker(fakeClock());
  for (let i = 0; i < 10; i++) await assert.rejects(cb.execute(fail(notFound)));
  assert.equal(cb.state, CircuitState.CLOSED);
});

test('half-open probe success closes the circuit', async () => {
  const clock = fakeClock();
  const changes = [];
  const cb = breaker(clock, changes);
  for (let i = 0; i < 3; i++) await assert.rejects(cb.execute(fail(upstream)));
  clock.advance(1000);
  assert.equal(cb.state, CircuitState.HALF_OPEN);
  assert.equal(await cb.execute(ok), 'ok');
  assert.equal(cb.state, CircuitState.CLOSED);
  assert.deepEqual(changes, ['closed->open', 'open->half_open', 'half_open->closed']);
});

test('half-open probe failure re-opens the circuit', async () => {
  const clock = fakeClock();
  const cb = breaker(clock);
  for (let i = 0; i < 3; i++) await assert.rejects(cb.execute(fail(upstream)));
  clock.advance(1000);
  await assert.rejects(cb.execute(fail(upstream)), { kind: FplErrorKind.UPSTREAM_UNAVAILABLE });
  assert.equal(cb.state, CircuitState.OPEN);
  clock.advance(999);
  assert.equal(cb.state, CircuitState.OPEN);
});

test('half-open allows only one concurrent probe', async () => {
  const clock = fakeClock();
  const cb = breaker(clock);
  for (let i = 0; i < 3; i++) await assert.rejects(cb.execute(fail(upstream)));
  clock.advance(1000);

  let release;
  const probe = cb.execute(() => new Promise((r) => { release = r; }));
  await assert.rejects(cb.execute(ok), { kind: FplErrorKind.CIRCUIT_OPEN });
  release('done');
  assert.equal(await probe, 'done');
  assert.equal(cb.state, CircuitState.CLOSED);
});

test('client stops calling upstream while the circuit is open', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse({}, { status: 503 })]);
  const client = createFplClient(
    testOptions(clock, { fetch, retry: { maxAttempts: 1 }, breaker: { failureThreshold: 2, resetTimeoutMs: 5000 } }),
  );

  await assert.rejects(client.getBootstrapStatic());
  await assert.rejects(client.getBootstrapStatic());
  assert.equal(client.circuitState, CircuitState.OPEN);
  await assert.rejects(client.getBootstrapStatic(), { kind: FplErrorKind.CIRCUIT_OPEN });
  assert.equal(fetch.calls.length, 2);
});

test('an open circuit ends a retry loop early', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse({}, { status: 503 })]);
  const client = createFplClient(
    testOptions(clock, { fetch, retry: { maxAttempts: 5 }, breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 } }),
  );
  await assert.rejects(client.getBootstrapStatic(), { kind: FplErrorKind.CIRCUIT_OPEN });
  assert.equal(fetch.calls.length, 2);
});

test('client recovers after the reset timeout', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([
    jsonResponse({}, { status: 503 }),
    jsonResponse(minimalBootstrap()),
  ]);
  const client = createFplClient(
    testOptions(clock, { fetch, retry: { maxAttempts: 1 }, breaker: { failureThreshold: 1, resetTimeoutMs: 5000 } }),
  );
  await assert.rejects(client.getBootstrapStatic());
  assert.equal(client.circuitState, CircuitState.OPEN);
  clock.advance(5000);
  await client.getBootstrapStatic();
  assert.equal(client.circuitState, CircuitState.CLOSED);
});
