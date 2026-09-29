import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { createPlayersService } from '../../src/services/playersService.js';
import { createFinderService } from '../../src/services/finderService.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { groupRepo } from '../../src/repositories/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 19: the differential & value finder on synced synthetic FPL data.

const SEASON = '2026-27';
const JWT_SECRET = 'f'.repeat(48);
const admin = signAdminToken(JWT_SECRET);
let t;
let server;
let base;
let group;
let other;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  const world = createWorld({ entries: [701, 702, 703] });
  // Every member owns 1–15 (the default squad); 16–30 are owned by nobody.
  const patch = {};
  for (let id = 1; id <= 30; id += 1) patch[id] = { total_points: 10, selected_by_percent: '20.0', form: '2.0', status: 'a' };
  Object.assign(patch, {
    // World prices are 44 + id tenths; position and team follow (id - 1) % 4.
    16: { total_points: 40, selected_by_percent: '1.2', form: '6.0', status: 'a' }, // FWD, team 4, £6.0m
    18: { total_points: 50, selected_by_percent: '3.5', form: '4.0', status: 'i' }, // DEF, team 2, £6.2m, injured
    22: { total_points: 45, selected_by_percent: '9.9', form: '5.0', status: 'a' }, // DEF, team 2, £6.6m
    3: { total_points: 70, selected_by_percent: '55.0', form: '7.0', status: 'a' }, // MID, team 3, £4.7m, owned by all
  });
  world.state.elementPatch = patch;
  const sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  const players = createPlayersService({ sync });
  const app = createApp({
    config: { NODE_ENV: 'test', JWT_SECRET }, version: 'test', getDbStatus: async () => ({ ok: true }), log: () => {},
    services: { groups: createGroupService({ sync }), players, finder: createFinderService({ players }) },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  group = await groupRepo.create({ name: 'FFM300', slug: 'ffm300', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', myEntryId: 701, members: [701, 702, 703].map((entryId) => ({ entryId })) });
  other = await groupRepo.create({ name: 'Other', slug: 'other', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 701 }] });
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
const finderPath = (g, q = '') => `/api/groups/${g.id}/gw/${GW}/finder?season=${SEASON}${q}`;

test('value sort by default, with world and group ownership, mine, and the next fixtures', async () => {
  const { status, body } = await api(finderPath(group));
  assert.equal(status, 200, JSON.stringify(body));
  const f = body.finder;
  assert.equal(f.groupName, 'FFM300');
  assert.equal(f.total, 30);
  assert.equal(f.groupOf, 3);
  assert.equal(f.sort, 'value');
  assert.deepEqual(f.rows.slice(0, 4).map((r) => r.elementId), [3, 18, 22, 16], '14.9, 8.1, 6.8, 6.7 points per £m');
  const p3 = f.rows[0];
  assert.deepEqual([p3.pointsPerMillion, p3.selectedByTenths, p3.groupOwners, p3.ownedByMe], [14.9, 550, 3, true]);
  const p22 = f.rows[2];
  assert.deepEqual([p22.groupOwners, p22.ownedByMe, p22.team, p22.position], [0, false, 'C2', 'DEF']);
  assert.deepEqual(p22.fixtures.fixtures, [{ gw: 6, opponent: 1, home: false, fdr: 2, opponentShort: 'C1' }]);
  assert.equal(p22.easyRun, true, 'FDR 2 < 3.0');
  assert.equal(f.rows.find((r) => r.elementId === 1).easyRun, false, 'team 1 is at home to team 2, FDR 3: not under 3.0');
});

test('filters from the query string: differentials, position, price, world ownership, fit only; sorts', async () => {
  const ids = async (q) => (await api(finderPath(group, q))).body.finder.rows.map((r) => r.elementId);
  const diffs = await ids('&maxGroupOwners=0&maxOwnership=10&limit=5');
  assert.deepEqual(diffs, [18, 22, 16], 'unowned in the group, under 10% of the world');
  assert.deepEqual(await ids('&maxGroupOwners=0&maxOwnership=10&fit=true'), [22, 16], 'the injured one hidden');
  assert.deepEqual(await ids('&maxGroupOwners=0&position=DEF&maxPrice=6.3'), [18], 'DEF up to £6.3m');
  assert.deepEqual((await ids('&maxGroupOwners=0&sort=form')).slice(0, 3), [16, 22, 18]);
  const byFdr = (await api(finderPath(group, '&sort=fdr'))).body.finder.rows;
  assert.ok(byFdr.slice(0, 15).every((r) => r.fixtures.avgFdr === 2), 'easiest runs first');
});

test('read-only access rules and validation', async () => {
  assert.equal((await api(finderPath(group), { token: null })).status, 401);
  const share = (await fetch(`${base}/api/groups/${group.id}/share-token`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } }).then((x) => x.json())).shareToken;
  assert.equal((await api(finderPath(group), { share })).status, 200);
  assert.equal((await api(finderPath(other), { share })).status, 404);
  assert.equal((await api(finderPath(group, '&sort=luck'))).status, 400);
  assert.equal((await api(finderPath(group, '&position=GK'))).status, 400);
  assert.equal((await api(finderPath(group, '&limit=0'))).status, 400);
});
