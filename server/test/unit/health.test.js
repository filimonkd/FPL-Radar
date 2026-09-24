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
