import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFplClient } from '../../../src/fpl/client.js';
import { sha256Bytes } from '../../../src/utils/canonical.js';
import { fakeClock, testOptions, scriptedFetch, jsonResponse, minimalBootstrap } from './helpers.js';

// The request-log hook the sync uses to fill syncRuns.requests[] (v0.3 §8).

test('each logical call logs one entry with the hash and size of the exact response bytes', async () => {
  const body = minimalBootstrap();
  const clock = fakeClock();
  const client = createFplClient(testOptions(clock, { fetch: scriptedFetch([jsonResponse(body)]) }));
  const log = [];
  const data = await client.withRequestLog((e) => log.push(e)).getBootstrapStatic();
  assert.equal(data.events.length, 1);
  assert.equal(log.length, 1);
  const [e] = log;
  const bytes = Buffer.from(JSON.stringify(body));
  assert.deepEqual({ name: e.name, path: e.path, ok: e.ok, fromCache: e.fromCache, schemaOk: e.schemaOk, status: e.response.status, bytes: e.response.bytes },
    { name: 'bootstrapStatic', path: '/bootstrap-static/', ok: true, fromCache: false, schemaOk: true, status: 200, bytes: bytes.length });
  assert.equal(e.response.bodySha256, sha256Bytes(bytes));
  assert.ok(Buffer.isBuffer(e.response.body));
  assert.equal(e.response.text, JSON.stringify(body));
});

test('a cache hit logs fromCache with the hash of the bytes originally fetched', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([jsonResponse(minimalBootstrap())]);
  const client = createFplClient(testOptions(clock, { fetch }));
  const log = [];
  const c = client.withRequestLog((e) => log.push(e));
  await c.getBootstrapStatic();
  await c.getBootstrapStatic();
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(log.map((e) => e.fromCache), [false, true]);
  assert.equal(log[1].response.bodySha256, log[0].response.bodySha256);
});

test('retries are one entry; errors carry status, schemaOk and the response', async () => {
  const clock = fakeClock();
  const fetch = scriptedFetch([
    new Response('busy', { status: 503 }),
    jsonResponse({ current: [{ event: 1 }], past: [], chips: [] }), // fails validation
    jsonResponse({ detail: 'Not found.' }, { status: 404 }),
  ]);
  const client = createFplClient(testOptions(clock, { fetch, ttls: { entryHistory: 0, entryTransfers: 0 } }));
  const log = [];
  const c = client.withRequestLog((e) => log.push(e));
  await assert.rejects(c.getEntryHistory(1), { kind: 'validation' });
  await assert.rejects(c.getEntryTransfers(1), { kind: 'not_found' });
  assert.equal(log.length, 2, 'the 503 retry is not a separate entry');
  assert.deepEqual([log[0].ok, log[0].schemaOk, log[0].response.status], [false, false, 200]);
  assert.deepEqual([log[1].ok, log[1].schemaOk, log[1].response.status], [false, null, 404]);
  assert.ok(log[0].error.response, 'the thrown error carries the response');
});

test('the plain client methods are unchanged and a throwing logger never breaks a call', async () => {
  const clock = fakeClock();
  const client = createFplClient(testOptions(clock, { fetch: scriptedFetch([jsonResponse(minimalBootstrap())]) }));
  const c = client.withRequestLog(() => { throw new Error('logger down'); });
  assert.equal((await c.getBootstrapStatic()).events.length, 1);
  assert.equal((await client.getBootstrapStatic()).events.length, 1);
});
