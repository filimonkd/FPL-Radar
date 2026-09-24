import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../../../src/fpl/cache.js';
import { createFplClient, FplErrorKind } from '../../../src/fpl/index.js';
import { fakeClock, jsonResponse, scriptedFetch, minimalBootstrap, testOptions } from './helpers.js';

test('returns values until the TTL expires', () => {
  const clock = fakeClock();
  const cache = new TtlCache({ now: clock.now });
  cache.set('k', 'v', 1000);
  clock.advance(1000); // lru-cache: fresh while age <= ttl
  assert.equal(cache.get('k'), 'v');
  clock.advance(1);
  assert.equal(cache.get('k'), undefined);
});

test('ttl of 0 disables caching', () => {
  const cache = new TtlCache({ now: fakeClock().now });
  cache.set('k', 'v', 0);
  assert.equal(cache.size, 0);
});

test('evicts least recently used entries beyond maxEntries', () => {
  const cache = new TtlCache({ maxEntries: 2, now: fakeClock().now });
  cache.set('a', 1, 1000);
  cache.set('b', 2, 1000);
  cache.get('a'); // a is now most recent
  cache.set('c', 3, 1000);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('getOrLoad de-duplicates concurrent loads', async () => {
  const cache = new TtlCache({ now: fakeClock().now });
  let loads = 0;
  const loader = async () => {
    loads++;
    await new Promise((r) => setImmediate(r));
    return 'value';
  };
  const results = await Promise.all([1, 2, 3].map(() => cache.getOrLoad('k', 1000, loader)));
  assert.equal(loads, 1);
  assert.deepEqual(results.map((r) => r.value), ['value', 'value', 'value']);
});

test('getOrLoad does not cache failures', async () => {
  const cache = new TtlCache({ now: fakeClock().now });
  await assert.rejects(cache.getOrLoad('k', 1000, async () => { throw new Error('nope'); }));
  const { value, cached } = await cache.getOrLoad('k', 1000, async () => 'ok');
  assert.equal(value, 'ok');
  assert.equal(cached, false);
});

test('client serves repeated calls from cache within TTL', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([() => jsonResponse(minimalBootstrap())]);
  const events = [];
  const client = createFplClient(testOptions(clock, { fetch, onEvent: (e) => events.push(e), ttls: { bootstrapStatic: 60_000 } }));

  await client.getBootstrapStatic();
  await client.getBootstrapStatic();
  assert.equal(fetch.calls.length, 1);
  assert.equal(events.filter((e) => e.type === 'cache_hit').length, 1);

  clock.advance(60_001);
  await client.getBootstrapStatic();
  assert.equal(fetch.calls.length, 2);
});

test('client caches per path', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([() => jsonResponse({ id: 1, name: 'Entry' })]);
  const client = createFplClient(testOptions(clock, { fetch }));
  await client.getEntry(1);
  await client.getEntry(2);
  await client.getEntry(1);
  assert.deepEqual(fetch.calls.map((c) => c.url), ['https://fpl.test/api/entry/1/', 'https://fpl.test/api/entry/2/']);
});

test('client de-duplicates concurrent identical requests', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([() => jsonResponse(minimalBootstrap())]);
  const client = createFplClient(testOptions(clock, { fetch }));
  await Promise.all([client.getBootstrapStatic(), client.getBootstrapStatic(), client.getBootstrapStatic()]);
  assert.equal(fetch.calls.length, 1);
});

test('client never caches invalid responses', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse({ unexpected: true }), jsonResponse(minimalBootstrap())]);
  const client = createFplClient(testOptions(clock, { fetch }));
  await assert.rejects(client.getBootstrapStatic(), { kind: FplErrorKind.VALIDATION });
  await client.getBootstrapStatic();
  assert.equal(fetch.calls.length, 2);
});

test('clearCache forces a refetch', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([() => jsonResponse(minimalBootstrap())]);
  const client = createFplClient(testOptions(clock, { fetch }));
  await client.getBootstrapStatic();
  client.clearCache();
  await client.getBootstrapStatic();
  assert.equal(fetch.calls.length, 2);
});
