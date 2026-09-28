import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import mongoose from 'mongoose';
import { CONNECTION_OPTIONS, configureMongoose } from '../../src/db/connection.js';
import { scan } from '../../scripts/checkBundle.js';

// Step 12: production readiness checks that need no database. The live
// Atlas/Render deployment itself follows docs/DEPLOYMENT.md.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

test('runtime versions: Node 22, Mongoose 9 (its own driver), MongoDB 8.0 everywhere', () => {
  assert.equal(read('.node-version').trim(), '22');
  for (const p of ['package.json', 'server/package.json', 'client/package.json']) assert.equal(json(p).engines.node, '>=22 <23', p);
  const server = json('server/package.json');
  assert.match(server.dependencies.mongoose, /^9\./);
  assert.equal(server.dependencies.mongodb, undefined, 'no separately installed driver');
  assert.match(server.config.mongodbMemoryServer.version, /^8\.0\./);
  assert.match(read('docker-compose.yml'), /image: mongo:8\.0\b/);
  assert.match(read('.github/workflows/backup.yml'), /image: mongo:8\.0\b/);
  const lock = json('package-lock.json');
  assert.match(lock.packages['node_modules/mongoose'].version, /^9\./);
  assert.match(lock.packages['node_modules/mongodb'].version, /^7\./, 'the driver Mongoose 9 ships');
});

test('production Mongo connection options (v0.3 §11)', () => {
  assert.equal(CONNECTION_OPTIONS.serverSelectionTimeoutMS, 10_000);
  assert.equal(CONNECTION_OPTIONS.autoIndex, false);
  assert.equal(CONNECTION_OPTIONS.autoCreate, false);
  assert.deepEqual([CONNECTION_OPTIONS.retryWrites, CONNECTION_OPTIONS.retryReads, CONNECTION_OPTIONS.w], [true, true, 'majority']);
  assert.deepEqual([CONNECTION_OPTIONS.maxPoolSize, CONNECTION_OPTIONS.minPoolSize], [10, 0]);
  configureMongoose();
  assert.equal(mongoose.get('bufferCommands'), false, 'requests fail fast while the DB is down');
  assert.equal(mongoose.get('strictQuery'), true);
});

test('render.yaml: build/start/health, Node from .node-version, secrets never inline', () => {
  const y = read('render.yaml');
  assert.match(y, /buildCommand: npm ci --include=dev && npm run build/);
  assert.match(y, /startCommand: npm start/);
  assert.match(y, /healthCheckPath: \/api\/health/);
  assert.match(y, /key: NODE_ENV\n\s+value: production/);
  for (const k of ['MONGODB_URI', 'ADMIN_PASSWORD_HASH']) assert.match(y, new RegExp(`key: ${k}[^\\n]*\\n\\s+sync: false`), k);
  for (const k of ['JWT_SECRET', 'TICK_SECRET']) assert.match(y, new RegExp(`key: ${k}[^\\n]*\\n\\s+generateValue: true`), k);
  assert.ok(!/mongodb(\+srv)?:\/\/[^\s…]*@/.test(y), 'no connection string with credentials');
  assert.equal(json('package.json').scripts.start, 'npm run start -w server');
  assert.match(json('server/package.json').scripts.start, /^node (--env-file-if-exists=\.\.\/\.env )?src\/server\.js$/);
});

test('backup workflow follows the temporary-access procedure and never prints documents', () => {
  const y = read('.github/workflows/backup.yml');
  assert.match(y, /cron: '0 6 \* \* 1'/);
  assert.match(y, /workflow_dispatch/);
  assert.match(y, /atlas accessLists create "\$ip" --type ipAddress[^\n]*\\\n\s+--deleteAfter/);
  assert.match(y, /Remove the Atlas access entry\n\s+if: always\(\)\n[\s\S]*atlas accessLists delete/);
  assert.ok(!y.includes('0.0.0.0'), 'never an open access entry');
  for (const c of ['groups', 'managers', 'seasons', 'events', 'managerGameweeks', 'managerSeasons', 'resultSnapshots', 'gwResults', 'gwResultActions', 'syncRuns']) {
    assert.match(y, new RegExp(`COLLECTIONS: .*\\b${c}\\b`), c);
  }
  assert.match(y, /node server\/scripts\/dbCheck\.js > dump\/dbcheck\.json/, 'report goes into the encrypted archive, not the log');
  assert.match(y, /age -R ops\/backup\.pub/);
  assert.match(y, /retention-days: 90/);
  assert.match(y, /dbcheck-\$\{\{ steps\.check\.outputs\.result \}\}/);
  assert.match(y, /BACKUP_RO_URI: \$\{\{ secrets\.BACKUP_RO_URI \}\}/);
});

test('CI builds the client and scans the bundle', () => {
  const y = read('.github/workflows/ci.yml');
  assert.match(y, /npm run build\n\s+- run: npm run check:bundle/);
});

test('bundle scanner flags server secrets and env names', () => {
  assert.deepEqual(scan('fetch("/api/health")'), []);
  assert.deepEqual(scan('const u="mongodb+srv://x"'), ['MongoDB connection string']);
  assert.deepEqual(scan('JWT_SECRET'), ['server env variable name']);
  assert.deepEqual(scan(`$2b$12$${'a'.repeat(53)}`), ['bcrypt hash']);
  assert.deepEqual(scan('https://fantasy.premierleague.com/api/'), ['direct FPL API URL (the browser must go through /api)']);
});

test('no delete paths: no DELETE routes and no delete calls outside TTL', () => {
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  const files = readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(join(src, f), 'utf8')]);
  for (const [f, text] of files) {
    assert.ok(!/\brouter\.delete\s*\(|\bapp\.delete\s*\(/.test(text), `${f} declares a DELETE route`);
    assert.ok(!/\.(deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|remove|drop|dropCollection|dropDatabase)\s*\(/.test(text), `${f} deletes documents`);
  }
});

// ── HTTP surface in production mode (no DB needed) ────────────────────────

const PROD = parseEnv({
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb+srv://app:pw@cluster0.example.mongodb.net/',
  MONGODB_DB: 'fpl_rival',
  JWT_SECRET: 'j'.repeat(40),
  ADMIN_PASSWORD_HASH: `$2b$12$${'a'.repeat(53)}`,
  TICK_SECRET: 't'.repeat(40),
});

async function withApp(opts, fn) {
  const app = createApp({ config: PROD, version: 't', getDbStatus: async () => ({ ok: true, state: 'connected' }), ...opts });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('tick: 204 with the secret, 401 without or wrong, 404 when not configured; keep-warm only', async () => {
  await withApp({}, async (base) => {
    const tick = (headers) => fetch(`${base}/api/internal/tick`, { method: 'POST', headers });
    assert.equal((await tick({ 'X-Tick-Secret': 't'.repeat(40) })).status, 204);
    assert.equal((await tick({})).status, 401);
    assert.equal((await tick({ 'X-Tick-Secret': 't'.repeat(39) })).status, 401);
    assert.equal((await tick({ 'X-Tick-Secret': 'x'.repeat(40) })).status, 401);
    assert.equal((await fetch(`${base}/api/internal/tick`)).status, 404, 'GET is not a tick');
  });
  const app = createApp({ config: { ...PROD, TICK_SECRET: undefined }, version: 't', getDbStatus: async () => ({ ok: true }) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/tick`, { method: 'POST', headers: { 'X-Tick-Secret': 'anything' } });
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('same-origin client: static assets, SPA fallback, security headers, no CORS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fpl-client-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  try {
    await withApp({ clientDir: dir }, async (base) => {
      const home = await fetch(`${base}/`, { headers: { Origin: 'https://evil.example' } });
      assert.equal(home.status, 200);
      assert.match(await home.text(), /id="root"/);
      assert.equal(home.headers.get('cache-control'), 'no-cache');
      assert.equal(home.headers.get('access-control-allow-origin'), null, 'no CORS');
      assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
      assert.match(home.headers.get('strict-transport-security'), /max-age=/);
      assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(home.headers.get('x-powered-by'), null);

      const deep = await fetch(`${base}/groups/abc/gw/5`);
      assert.deepEqual([deep.status, /id="root"/.test(await deep.text())], [200, true], 'client-side route');

      const asset = await fetch(`${base}/assets/index-abc123.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('cache-control'), /max-age=31536000.*immutable/);
      assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404, 'never the SPA shell for an asset');

      const api = await fetch(`${base}/api/nope`);
      assert.equal(api.status, 404);
      assert.equal((await api.json()).error.code, 'NOT_FOUND', 'unknown /api paths stay JSON 404s');

      const pre = await fetch(`${base}/api/health`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
      assert.equal(pre.headers.get('access-control-allow-origin'), null, 'no preflight approval');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
