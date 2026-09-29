import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runDbCheck } from '../../src/ops/dbCheck.js';

// Step 14: npm run db:seed (v0.3 §11) loads the committed samples through the
// real sync path into a fresh database; re-running is a replay; --finalize
// decides the sampled GW; production and remote targets are refused.

const SCRIPT = fileURLToPath(new URL('../../scripts/seedFromSamples.js', import.meta.url));
let t;
let dbName;
let db;

before(async () => {
  t = await startTestDb();
  dbName = `fpl_rival_seed_${randomUUID().slice(0, 8)}`;
  db = mongoose.connection.client.db(dbName);
});
after(async () => {
  await db.dropDatabase().catch(() => {});
  await t.stop();
});

// Asynchronous on purpose: a blocking spawnSync would stall this process's
// event loop, and with it the in-memory mongod whose log pipe it must drain.
const seed = (args = [], env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, NODE_ENV: 'development', MONGODB_URI: t.uri, MONGODB_DB: dbName, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout, stderr }));
});
const count = (c, q = {}) => db.collection(c).countDocuments(q);

test('first run: migrations, a league group from the samples, a SUCCESS sync; db:check clean', async () => {
  const r = await seed();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Created group "Sample league" \([a-f0-9]{24}\) from sample league \d+ with 10 members/);
  assert.match(r.stdout, /Synced 2026-27 GW5: SUCCESS/);
  assert.equal(await count('groups'), 1);
  assert.equal(await count('managers'), 10);
  assert.equal(await count('managerGameweeks'), 50, '10 managers × 5 sampled gameweeks');
  assert.equal(await count('syncRuns', { status: 'SUCCESS' }), 2, 'group-create + group-gw');
  const report = await runDbCheck(db);
  assert.equal(report.counts.error, 0, JSON.stringify(report.violations));
});

test('re-running is a replay (nothing duplicated); --finalize decides GW5 once', async () => {
  const before = { groups: await count('groups'), rows: await count('managerGameweeks') };
  const r = await seed(['--finalize']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /already seeded/);
  assert.match(r.stdout, /Finalized GW5: RULE_BASED/);
  assert.deepEqual({ groups: await count('groups'), rows: await count('managerGameweeks') }, before);
  assert.equal(await count('gwResultActions'), 1);
  const again = await seed(['--finalize']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already final/);
  assert.equal(await count('gwResultActions'), 1, 'no second decision');
  assert.equal((await runDbCheck(db)).counts.error, 0);
});

test('refuses production and remote targets without touching them', async () => {
  let r = await seed([], { NODE_ENV: 'production' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refuses to run with NODE_ENV=production/);
  r = await seed([], { MONGODB_URI: 'mongodb+srv://user:pw@cluster0.example.mongodb.net/' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /remote \(mongodb\+srv\) cluster/);
  assert.ok(!r.stderr.includes('pw@'));
  r = await seed([], { MONGODB_DB: '' });
  assert.equal(r.status, 1);
});
