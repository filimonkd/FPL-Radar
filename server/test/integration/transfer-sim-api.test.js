import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { createPlayersService } from '../../src/services/playersService.js';
import { createTransferService } from '../../src/services/transferService.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { groupRepo } from '../../src/repositories/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 20: the transfer simulator on synced synthetic FPL data. World facts
// used below: prices are 44 + id tenths; team = (id - 1) % 4 + 1; position
// type = (id - 1) % 4 + 1; ep_next = (id - 1) % 5 + 1; every squad is 1–15;
// each manager bought player 3 for £5.5m in GW2; bank £0.5m; after GW5 the
// world only has GW6 fixtures (team 1 home to 2, team 3 home to 4).

const SEASON = '2026-27';
const JWT_SECRET = 't'.repeat(48);
const admin = signAdminToken(JWT_SECRET);
let t;
let server;
let base;
let group;
let noMe;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  const world = createWorld({ entries: [801, 802] });
  world.state.elementPatch = {
    1: { cost_change_start: 5 }, // £4.5m now, started at £4.0m: sells for £4.2m
    17: { ep_next: '6.0' },
  };
  const sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  const players = createPlayersService({ sync });
  const app = createApp({
    config: { NODE_ENV: 'test', JWT_SECRET }, version: 'test', getDbStatus: async () => ({ ok: true }), log: () => {},
    services: { groups: createGroupService({ sync }), players, transfers: createTransferService({ players }) },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  group = await groupRepo.create({ name: 'Sim', slug: 'sim', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', myEntryId: 801, members: [{ entryId: 801 }, { entryId: 802 }] });
  noMe = await groupRepo.create({ name: 'No me', slug: 'no-me', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 801 }] });
  const r = await sync.syncGroupGameweek({ groupId: group.id, season: SEASON, event: GW });
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.failures));
});
after(async () => {
  await new Promise((r) => server.close(r));
  await t.stop();
});

async function api(path, { token = admin } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}
const sim = (q) => api(`/api/groups/${group.id}/transfer-sim?season=${SEASON}&${q}`);

test('plan: my latest squad with estimated selling prices, the bank and the rules', async () => {
  const { status, body } = await api(`/api/groups/${group.id}/transfer-plan?season=${SEASON}`);
  assert.equal(status, 200, JSON.stringify(body));
  const p = body.plan;
  assert.deepEqual([p.event, p.squadEvent, p.myEntryId, p.bankTenths], [GW, GW, 801, 5]);
  assert.equal(p.squad.length, 15);
  const p1 = p.squad.find((x) => x.elementId === 1);
  assert.deepEqual([p1.priceTenths, p1.purchaseTenths, p1.sellingTenths], [45, 40, 42], 'owned since the start: half the rise, rounded down');
  const p3 = p.squad.find((x) => x.elementId === 3);
  assert.deepEqual([p3.priceTenths, p3.purchaseTenths, p3.sellingTenths], [47, 55, 47], 'bought at £5.5m, now £4.7m: the fall is passed on');
  assert.deepEqual(p.rules, { fdrFactor: { 1: 1.2, 2: 1.1, 3: 1, 4: 0.9, 5: 0.8 }, hitCost: 4, projectionGws: 5 });
});

test('simulate: bank after, price difference, club limit and a break-even verdict', async () => {
  const { status, body } = await sim('out=1&in=17');
  assert.equal(status, 200, JSON.stringify(body));
  const s = body.sim;
  assert.deepEqual(s.check, { samePosition: true, alreadyOwned: false, clubCount: 4, clubLimitBroken: true, priceDiffTenths: 19, bankAfterTenths: -14, affordable: false });
  assert.deepEqual(s.projection.perGw.map((g) => [g.gw, g.out, g.in, g.gain, g.source]), [
    [6, 1, 6, 5, 'FPL'], [7, 0, 0, 0, 'ESTIMATE'], [8, 0, 0, 0, 'ESTIMATE'], [9, 0, 0, 0, 'ESTIMATE'], [10, 0, 0, 0, 'ESTIMATE'],
  ], 'GW6 from FPL ep_next; the world has no fixtures after GW6');
  assert.deepEqual([s.projection.verdict, s.projection.withinGws, s.projection.total, s.projection.net], ['PAYS_OFF', 1, 5, 1]);
  assert.deepEqual([s.out.elementId, s.in.elementId, s.in.last[3].gws], [1, 17, 3]);

  const small = (await sim('out=2&in=22&hit=true')).body.sim.projection; // ep 2.0 → 2.0
  assert.deepEqual([small.verdict, small.total, small.net], ['DOES_NOT_PAY', 0, -4]);
  const free = (await sim('out=1&in=21&hit=false')).body.sim.projection; // ep 1.0 → 1.0
  assert.equal(free.verdict, 'DOES_NOT_PAY', 'no gain, even for free');
});

test('errors: not my player, unknown player, no "me", validation, access', async () => {
  assert.equal((await sim('out=20&in=17')).body.error.code, 'NOT_IN_SQUAD');
  assert.equal((await sim('out=1&in=999')).status, 404);
  const r = await api(`/api/groups/${noMe.id}/transfer-plan?season=${SEASON}`);
  assert.deepEqual([r.status, r.body.error.code], [422, 'ME_NOT_SET']);
  assert.equal((await sim('out=1')).status, 400);
  assert.equal((await sim('out=1&in=17&hit=maybe')).status, 400);
  assert.equal((await api(`/api/groups/${group.id}/transfer-plan?season=${SEASON}`, { token: null })).status, 401);
});
