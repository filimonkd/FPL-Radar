import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { createPlayersService } from '../../src/services/playersService.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { groupRepo } from '../../src/repositories/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 17: the players API on synced synthetic FPL data, including the
// per-GW history backfilled by the sync.

const SEASON = '2026-27';
const JWT_SECRET = 'p'.repeat(48);
const admin = signAdminToken(JWT_SECRET);
let t;
let server;
let base;
let group;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  const world = createWorld({ entries: [501, 502] });
  const sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  const app = createApp({
    config: { NODE_ENV: 'test', JWT_SECRET }, version: 'test', getDbStatus: async () => ({ ok: true }), log: () => {},
    services: { groups: createGroupService({ sync }), players: createPlayersService() },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  group = await groupRepo.create({ name: 'Players', slug: 'players', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 501 }, { entryId: 502 }] });
  const r = await sync.syncGroupGameweek({ groupId: group.id, season: SEASON, event: GW });
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.failures));
});
after(async () => {
  await new Promise((r) => server.close(r));
  await t.stop();
});

async function api(path, { token = admin, share } = {}) {
  const headers = {};
  if (share) headers['x-share-token'] = share;
  else if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}
const playersPath = (q = '') => `/api/seasons/${SEASON}/players${q}`;

test('every player with intel, recent form over finished GWs, rotation and the next fixtures', async () => {
  const { status, body } = await api(playersPath());
  assert.equal(status, 200, JSON.stringify(body));
  const v = body.players;
  assert.equal(v.event, GW, 'defaults to the current GW');
  assert.equal(v.statsThrough, GW);
  assert.deepEqual(v.historyGws, [1, 2, 3, 4, 5], 'backfilled GW1–4 plus the synced GW5');
  assert.equal(v.players.length, 30);
  assert.deepEqual(v.teams.map((x) => x.shortName), ['C1', 'C2', 'C3', 'C4']);

  const p1 = v.players.find((p) => p.elementId === 1);
  assert.equal(p1.team, 'C1');
  assert.equal(p1.position, 'GKP');
  assert.equal(p1.priceTenths, 45);
  assert.equal(p1.epNextTenths, 10);
  // World history: GW g scores max(0, 5 - (5 - g)) = g points, 90 minutes each.
  assert.deepEqual(p1.last[3], { points: 12, minutes: 270, gws: 3, of: 3 });
  assert.deepEqual(p1.last[5], { points: 15, minutes: 450, gws: 5, of: 5 });
  assert.deepEqual(p1.last[10], { points: 15, minutes: 450, gws: 5, of: 5 });
  assert.deepEqual(p1.rotation, { risk: false, short: 0, games: 3 });
  assert.deepEqual(p1.fixtures.gws, [6, 7, 8]);
  assert.deepEqual(p1.fixtures.fixtures, [{ gw: 6, opponent: 2, home: true, fdr: 3 }]);
  assert.equal(p1.fixtures.avgFdr, 3);
  assert.equal(p1.fixtures.blanks, 2, 'the world has no fixtures after GW6');

  const p16 = v.players.find((p) => p.elementId === 16);
  assert.deepEqual(p16.last[3], { points: 1, minutes: 270, gws: 3, of: 3 }, 'a 0-point GW counts as 0 because it was stored');
});

test('an earlier GW: stats stop at that GW and fixtures start after it', async () => {
  const v = (await api(playersPath('?event=3'))).body.players;
  assert.equal(v.event, 3);
  assert.equal(v.statsThrough, 3);
  const p1 = v.players.find((p) => p.elementId === 1);
  assert.deepEqual(p1.last[3], { points: 6, minutes: 270, gws: 3, of: 3 });
  assert.deepEqual(p1.fixtures.gws, [4, 5, 6]);
  assert.equal(p1.fixtures.fixtures.length, 3);
});

test('read-only, signed-in only, validated', async () => {
  const counts = async () => Object.fromEntries(await Promise.all(['players', 'liveGameweeks', 'syncRuns', 'events'].map(async (c) => [c, await t.db.collection(c).countDocuments()])));
  const before = await counts();
  const a = (await api(playersPath())).body;
  const b = (await api(playersPath())).body;
  assert.deepEqual(a, b, 'deterministic');
  assert.deepEqual(await counts(), before, 'nothing written');

  assert.equal((await api(playersPath(), { token: null })).status, 401);
  const share = (await fetch(`${base}/api/groups/${group.id}/share-token`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } }).then((x) => x.json())).shareToken;
  assert.equal((await api(playersPath(), { share })).status, 200, 'any group viewer may read season-wide player data');
  assert.equal((await api('/api/seasons/2099-00/players')).status, 404);
  assert.equal((await api('/api/seasons/nope/players')).status, 404);
  assert.equal((await api(playersPath('?event=39'))).status, 400);
});
