import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';

const config = parseEnv({
  MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true',
  MONGODB_DB: 'fpl_rival_test',
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret',
});

async function getHealth(getDbStatus) {
  const app = createApp({ config, version: '0.0.0-test', getDbStatus });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/health returns 200 and status ok', async () => {
  const { status, body } = await getHealth(async () => ({ ok: true, state: 'connected' }));
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '0.0.0-test');
  assert.equal(body.env, 'test');
  assert.equal(body.checks.process.ok, true);
  assert.equal(body.checks.env.ok, true);
});

test('GET /api/health returns 503 degraded when MongoDB is down', async () => {
  const { status, body } = await getHealth(async () => ({ ok: false, state: 'disconnected' }));
  assert.equal(status, 503);
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.mongodb.ok, false);
});

// Step 12: readiness = DB + migrations + env + not shutting down; recovery is automatic.
async function getHealthWith(deps) {
  const app = createApp({ config, version: '0.0.0-test', ...deps });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    return { status: res.status, body: await res.json(), cacheControl: res.headers.get('cache-control') };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health: healthy → degraded → recovered, re-evaluated on every request', async () => {
  let dbUp = true;
  let pending = [];
  const runtime = { shuttingDown: false, activeRuns: 0 };
  const deps = {
    getDbStatus: async () => (dbUp ? { ok: true, state: 'connected' } : { ok: false, state: 'disconnected' }),
    getMigrationStatus: async () => ({ ok: pending.length === 0, applied: 5 - pending.length, expected: 5, pending }),
    getRuntime: () => runtime,
  };
  let r = await getHealthWith(deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.checks.migrations, { ok: true, applied: 5, expected: 5, pending: [] });
  assert.deepEqual(r.body.checks.runtime, { ok: true, shuttingDown: false, activeRuns: 0, lockHeld: false });
  assert.equal(r.cacheControl, 'no-store');

  dbUp = false;
  r = await getHealthWith(deps);
  assert.deepEqual([r.status, r.body.status, r.body.checks.mongodb.ok], [503, 'degraded', false]);
  assert.deepEqual(r.body.checks.migrations, { ok: false, state: 'unknown' }, 'migrations are not queried without a DB');

  dbUp = true;
  pending = ['005_x'];
  r = await getHealthWith(deps);
  assert.deepEqual([r.status, r.body.checks.migrations.pending], [503, ['005_x']]);

  pending = [];
  runtime.activeRuns = 1;
  r = await getHealthWith(deps);
  assert.deepEqual([r.status, r.body.checks.runtime.lockHeld], [200, true], 'a running sync is healthy');

  runtime.shuttingDown = true;
  r = await getHealthWith(deps);
  assert.deepEqual([r.status, r.body.status, r.body.checks.runtime.ok], [503, 'degraded', false], 'draining instance is not ready');

  runtime.shuttingDown = false;
  runtime.activeRuns = 0;
  r = await getHealthWith(deps);
  assert.deepEqual([r.status, r.body.status], [200, 'ok'], 'recovered');
});

test('health output carries no secrets', async () => {
  const secretConfig = parseEnv({
    MONGODB_URI: 'mongodb://user:hunter2hunter2@db.example.net:27017/',
    MONGODB_DB: 'fpl_rival_test',
    NODE_ENV: 'test',
    JWT_SECRET: 'jwt-secret-value-that-must-not-leak',
    TICK_SECRET: 'tick-secret-value-that-must-not-leak-xx',
  });
  const app = createApp({ config: secretConfig, version: 't', getDbStatus: async () => ({ ok: false, state: 'disconnected' }) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const text = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).text();
    for (const s of ['hunter2', 'jwt-secret-value', 'tick-secret-value', 'db.example.net']) assert.ok(!text.includes(s), s);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
