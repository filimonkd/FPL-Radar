import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { MIGRATIONS } from '../../src/db/migrations/index.js';
import { runDbCheck } from '../../src/ops/dbCheck.js';
import { deploySmoke } from '../../scripts/deploySmoke.js';
import { createWorld, BASE_URL, GW } from '../helpers/fplWorld.js';

// Step 12: the real production process. `node src/server.js` with
// NODE_ENV=production and production-strength secrets, against a fresh database
// and a synthetic FPL API served over HTTP (never the real FPL). Covers boot
// (env → connect → migrations under the migrate lease → listen), health, tick,
// admin cookie login, group / result / chips / status endpoints, share-token
// access, the same-origin client, log redaction, SIGTERM with a sync in flight,
// and a clean restart that re-applies nothing and leaves no broken state.

const SERVER = fileURLToPath(new URL('../../src/server.js', import.meta.url));
const CLIENT_DIST = fileURLToPath(new URL('../../../client/dist/index.html', import.meta.url));
const SEASON = '2026-27';
const PASSWORD = `pw-${randomUUID()}`;
const JWT_SECRET = randomUUID() + randomUUID();
const TICK_SECRET = randomUUID() + randomUUID();

let t;
let fpl;
let world;
let env;
let dbName;
let db;

before(async () => {
  t = await startTestDb();
  dbName = `fpl_rival_prod_${randomUUID().slice(0, 8)}`;
  db = mongoose.connection.client.db(dbName);
  world = createWorld({ entries: [101, 102, 103, 104] }); // 104 is first fetched by the SIGTERM test
  fpl = createServer(async (req, res) => {
    const r = await world.fetch(BASE_URL + req.url.replace(/^\/api/, ''));
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => fpl.listen(0, '127.0.0.1', r));
  env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    MONGODB_URI: t.uri,
    MONGODB_DB: dbName,
    JWT_SECRET,
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4),
    TICK_SECRET,
    FPL_API_BASE_URL: `http://127.0.0.1:${fpl.address().port}/api`,
  };
});
after(async () => {
  await db.dropDatabase().catch(() => {});
  await new Promise((r) => fpl.close(r));
  await t.stop();
});

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return String(port);
}

/** Starts src/server.js on a free port; `ready` resolves once it listens. */
function boot(extraEnv = {}) {
  const portP = freePort();
  const proc = { out: '' };
  proc.ready = portP.then((port) => start(proc, { ...env, PORT: port, ...extraEnv }));
  return proc;
}

function start(proc, childEnv) {
  const child = spawn(process.execPath, [SERVER], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.child = child;
  proc.exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  child.stdout.on('data', (d) => { proc.out += d; });
  child.stderr.on('data', (d) => { proc.out += d; });
  const ready = new Promise((resolve, reject) => {
    const onData = () => {
      const m = /Server listening on http:\/\/localhost:(\d+)/.exec(proc.out);
      if (m) { proc.base = `http://127.0.0.1:${m[1]}`; resolve(proc); }
    };
    child.stdout.on('data', onData);
    proc.exited.then(({ code }) => reject(new Error(`server exited (${code}) before listening:\n${proc.out}`)));
  });
  proc.waitFor = async (re, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!re.test(proc.out)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re}:\n${proc.out}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return ready;
}

async function call(base, method, path, { body, cookie, share, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (share) h['x-share-token'] = share;
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, headers: res.headers, body: parsed };
}

let first;
let cookie;
let group;
let share;
let second;

test('production config refuses to boot with a weak secret, before touching the database', async () => {
  const p = boot({ JWT_SECRET: 'change-me', TICK_SECRET: '' });
  await assert.rejects(p.ready, /exited \(1\)/);
  assert.match(p.out, /JWT_SECRET must be a random secret of at least 32 characters in production/);
  assert.match(p.out, /TICK_SECRET/);
  assert.ok(!p.out.includes('change-me'), 'the value itself is not echoed');
  assert.ok(!(await t.db.admin().listDatabases()).databases.some((d) => d.name === dbName), 'no database was created');
});

test('first boot: migrations under the migrate lease, then healthy', async () => {
  first = await boot().ready;
  assert.match(first.out, new RegExp(`Migrations: ${MIGRATIONS.length} applied, 0 already applied`));
  const h = await call(first.base, 'GET', '/api/health');
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.env, 'production');
  assert.deepEqual(h.body.checks.migrations, { ok: true, applied: MIGRATIONS.length, expected: MIGRATIONS.length, pending: [] });
  assert.deepEqual(h.body.checks.runtime, { ok: true, shuttingDown: false, activeRuns: 0, lockHeld: false });
  const lock = await db.collection('locks').findOne({ _id: 'migrate' });
  assert.equal(lock.owner, null, 'migrate lease released after boot');
});

test('tick, security headers and no CORS', async () => {
  assert.equal((await call(first.base, 'POST', '/api/internal/tick', { headers: { 'x-tick-secret': TICK_SECRET } })).status, 204);
  assert.equal((await call(first.base, 'POST', '/api/internal/tick', { headers: { 'x-tick-secret': 'nope' } })).status, 401);
  const h = await call(first.base, 'GET', '/api/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(h.headers.get('access-control-allow-origin'), null);
  assert.match(h.headers.get('strict-transport-security'), /max-age/);
  assert.equal(h.headers.get('x-powered-by'), null);
});

test('admin login: HttpOnly Secure SameSite=Strict cookie on /api, no token in the body; auth enforced', async () => {
  assert.equal((await call(first.base, 'GET', '/api/groups')).status, 401);
  const bad = await call(first.base, 'POST', '/api/auth/login', { body: { password: 'wrong' } });
  assert.equal(bad.status, 401);
  const ok = await call(first.base, 'POST', '/api/auth/login', { body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /^fpl_admin=[^;]+; Max-Age=\d+; Path=\/api; Expires=[^;]+; HttpOnly; Secure; SameSite=Strict$/);
  assert.ok(!JSON.stringify(ok.body).includes(setCookie.split(';')[0].split('=')[1]), 'token only in the cookie');
  cookie = setCookie.split(';')[0];
  assert.equal((await call(first.base, 'GET', '/api/auth/me', { cookie })).body.principal.role, 'admin');
  // A forged cookie (wrong secret) is anonymous.
  const forged = `fpl_admin=${Buffer.from('{"alg":"HS256"}').toString('base64url')}.e30.x`;
  assert.equal((await call(first.base, 'GET', '/api/groups', { cookie: forged })).status, 401);
});

test('groups, sync, finalize, results, chips, status and share-token access', async () => {
  const created = await call(first.base, 'POST', '/api/groups', { cookie, body: { name: 'Prod', memberSource: 'MANUAL', entryIds: [101, 102, 103], winnerRule: 'NET_POINTS' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  group = created.body.group;
  const s = await call(first.base, 'POST', `/api/groups/${group.id}/sync`, { cookie, body: { season: SEASON, event: GW } });
  assert.deepEqual([s.status, s.body.run.status], [200, 'SUCCESS'], JSON.stringify(s.body));
  const fin = await call(first.base, 'POST', `/api/groups/${group.id}/gw/${GW}/finalize`, { cookie, body: { season: SEASON } });
  assert.equal(fin.status, 201, JSON.stringify(fin.body));
  const result = await call(first.base, 'GET', `/api/groups/${group.id}/gw/${GW}/result?season=${SEASON}`, { cookie });
  assert.deepEqual([result.status, result.body.result.status, result.body.result.winners], [200, 'FINAL', [103]], JSON.stringify(result.body));
  assert.equal((await call(first.base, 'GET', `/api/groups/${group.id}/gw/${GW}/actions/verify?season=${SEASON}`, { cookie })).body.valid, true);
  const chips = await call(first.base, 'GET', `/api/groups/${group.id}/chips?season=${SEASON}&event=${GW}`, { cookie });
  assert.equal(chips.status, 200, JSON.stringify(chips.body));
  const status = await call(first.base, 'GET', `/api/status?season=${SEASON}`, { cookie });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.ok(status.body.status.storage, 'storage gauge present');
  assert.ok(status.body.status.runs.length >= 1, 'run log present');

  share = (await call(first.base, 'POST', `/api/groups/${group.id}/share-token`, { cookie })).body.shareToken;
  assert.equal((await call(first.base, 'GET', `/api/groups/${group.id}/gw/${GW}/result?season=${SEASON}`, { share })).status, 200, 'viewer reads its group');
  assert.equal((await call(first.base, 'GET', `/api/status?season=${SEASON}`, { share })).status, 403, 'viewer is not admin');
  assert.equal((await call(first.base, 'POST', `/api/groups/${group.id}/sync`, { share, body: { season: SEASON, event: GW } })).status, 403);
});

test('the built client is served from the API origin (same-origin /api)', async () => {
  const res = await fetch(`${first.base}/groups/${group.id}`);
  if (existsSync(CLIENT_DIST)) {
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<div id="root"><\/div>/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  } else {
    assert.equal(res.status, 404, 'no client build: nothing but /api'); // CI builds before testing
  }
});

test('the post-deploy smoke script passes against the running instance, printing no secrets', async () => {
  const lines = [];
  const r = await deploySmoke(first.base, { tickSecret: TICK_SECRET, adminPassword: PASSWORD, season: SEASON, log: (l) => lines.push(l) });
  const expected = existsSync(CLIENT_DIST) ? r.results.every((x) => x.ok) : r.results.filter((x) => !x.ok).map((x) => x.name).join() === 'client served from the API origin with security headers';
  assert.ok(expected, lines.join('\n'));
  assert.equal(r.results.length, 7);
  for (const secret of [TICK_SECRET, PASSWORD]) assert.ok(!lines.join('\n').includes(secret));
});

test('SIGTERM with a sync in flight: run ABANDONED, lease released, exit 0; logs carry no secrets', async () => {
  let reached;
  let release;
  const arrived = new Promise((r) => { reached = r; });
  const held = new Promise((r) => { release = r; });
  // The production client caches FPL responses, so the held request is one this
  // process has not made yet: entry 104's transfers, in a second group's sync.
  world.overrides.set('/entry/104/transfers/', async () => { reached(); await held; return undefined; });
  const b = await call(first.base, 'POST', '/api/groups', { cookie, body: { name: 'Second', memberSource: 'MANUAL', entryIds: [101, 104], winnerRule: 'NET_POINTS' } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  second = b.body.group;

  const pending = call(first.base, 'POST', `/api/groups/${second.id}/sync`, { cookie, body: { season: SEASON, event: GW } });
  await arrived;
  const h = await call(first.base, 'GET', '/api/health');
  assert.deepEqual([h.status, h.body.checks.runtime.activeRuns, h.body.checks.runtime.lockHeld], [200, 1, true]);
  const running = await db.collection('syncRuns').findOne({ status: 'RUNNING' });
  assert.ok(running);

  first.child.kill('SIGTERM');
  await first.waitFor(/abandoned 1 running sync run\(s\)/);
  const lock = await db.collection('locks').findOne({ _id: running.lockId });
  assert.equal(lock.owner, null, 'lease released while the request is still open');
  assert.equal((await db.collection('syncRuns').findOne({ _id: running._id })).status, 'ABANDONED');

  release(); // FPL answers late; the stale run cannot commit or succeed
  world.overrides.delete('/entry/104/transfers/');
  const r = await pending;
  assert.deepEqual([r.status, r.body.run.status, r.body.run.failures.map((f) => f.code)], [200, 'ABANDONED', ['LOCK_LOST']], 'the late work failed its fence');
  assert.deepEqual(await first.exited, { code: 0, signal: null });
  assert.equal((await db.collection('syncRuns').findOne({ _id: running._id })).status, 'ABANDONED', 'never a false success');

  for (const secret of [PASSWORD, JWT_SECRET, TICK_SECRET, env.ADMIN_PASSWORD_HASH, cookie.split('=')[1], share]) {
    assert.ok(!first.out.includes(secret), 'a secret reached the log');
  }
});

test('restart: nothing re-applied, state intact, db:check clean, sync and finalize still work', async () => {
  const before = await db.collection('gwResultActions').countDocuments();
  const again = await boot().ready;
  try {
    assert.match(again.out, new RegExp(`Migrations: 0 applied, ${MIGRATIONS.length} already applied`));
    assert.equal((await call(again.base, 'GET', '/api/health')).status, 200);
    assert.equal((await call(again.base, 'GET', '/api/auth/me', { cookie })).body.principal.role, 'admin', 'sessions survive a restart');
    const s = await call(again.base, 'POST', `/api/groups/${second.id}/sync`, { cookie, body: { season: SEASON, event: GW } });
    assert.deepEqual([s.status, s.body.run?.status], [200, 'SUCCESS'], `the abandoned run left no lock behind: ${JSON.stringify(s.body)}`);
    assert.equal((await call(again.base, 'GET', `/api/groups/${group.id}/gw/${GW}/actions/verify?season=${SEASON}`, { cookie })).body.valid, true);
    assert.equal(await db.collection('gwResultActions').countDocuments(), before, 'the decision log is untouched');
    const report = await runDbCheck(db);
    assert.equal(report.counts.error, 0, JSON.stringify(report.violations));
  } finally {
    again.child.kill('SIGTERM');
    assert.deepEqual(await again.exited, { code: 0, signal: null });
  }
});
