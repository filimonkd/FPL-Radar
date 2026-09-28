import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { createResultService } from '../../src/services/resultService.js';
import { createOwnershipService } from '../../src/services/ownershipService.js';
import { ownershipInputs, buildOwnershipView } from '../../src/services/ownershipModel.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { groupRepo, ownershipRepo } from '../../src/repositories/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 10: ownership / captaincy / transfers from synced data, end to end
// through the API (v0.2 §7, §14). Synthetic FPL data served via the real client.

const SEASON = '2026-27';
const JWT_SECRET = 'o'.repeat(48);
const admin = signAdminToken(JWT_SECRET);
let t;
let server;
let base;
let world;
let sync;
let group;
let other;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  world = createWorld({ entries: [101, 102, 103, 104, 105] });
  const e = world.state.entries;
  // 102: triple captain on element 1, transfers 7 → 20 in GW5 with a 4-point hit.
  e[102].activeChip = '3xc';
  e[102].picks = e[102].picks.map((p) => (p.element === 1 ? { ...p, multiplier: 3 } : p.element === 7 ? { ...p, element: 20 } : p));
  e[102].rows[4] = { event: 5, points: 62, cost: 4 };
  e[102].transfers.push({ element_in: 20, element_in_cost: 45, element_out: 7, element_out_cost: 50, entry: 102, event: 5, time: '2026-09-11T08:00:00Z' });
  // 103: captain 5 (plays 0 min), vice 6; FPL auto-subs 5 → 12; free transfer 8 → 20.
  e[103].picks = e[103].picks.map((p) => ({
    ...p, is_captain: p.element === 5, is_vice_captain: p.element === 6, multiplier: p.element === 5 ? 0 : p.element === 6 ? 2 : p.element === 12 ? 1 : p.position <= 11 ? 1 : 0,
    ...(p.element === 8 ? { element: 20 } : {}),
  }));
  e[103].autoSubs = [{ element_in: 12, element_out: 5 }];
  e[103].transfers.push({ element_in: 20, element_in_cost: 45, element_out: 8, element_out_cost: 50, entry: 103, event: 5, time: '2026-09-11T09:00:00Z' });
  // 104: no picks for GW5. 105: excluded from the group.
  e[104].noPicks = true;
  world.state.live = world.state.live.map((el) => (el.id === 5 ? { ...el, stats: { minutes: 0, total_points: 0 } } : el));

  sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  const config = { NODE_ENV: 'test', PORT: 4000, MONGODB_URI: t.uri, MONGODB_DB: t.dbName, JWT_SECRET, FPL_API_BASE_URL: 'https://fpl.test/api' };
  const app = createApp({
    config, version: 'test', getDbStatus: async () => ({ ok: true }), log: () => {},
    services: { groups: createGroupService({ sync }), results: createResultService({ sync }), ownership: createOwnershipService() },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  group = await groupRepo.create({
    name: 'Owners', slug: 'owners', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', myEntryId: 101,
    members: [101, 102, 103, 104].map((entryId) => ({ entryId })).concat([{ entryId: 105, isExcluded: true }]),
  });
  other = await groupRepo.create({ name: 'Other', slug: 'other', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 101 }] });
  const r = await sync.syncGroupGameweek({ groupId: group.id, season: SEASON, event: GW });
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.failures));
});
after(async () => {
  await new Promise((r) => server.close(r));
  await t.stop();
});

const raw = (coll) => t.db.collection(coll);
async function api(path, { token = admin, share } = {}) {
  const headers = {};
  if (share) headers['x-share-token'] = share;
  else if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}
const ownershipPath = (g, gw = GW, q = '') => `/api/groups/${g.id}/gw/${gw}/ownership?season=${SEASON}${q}`;
const transfersPath = (g, gw = GW) => `/api/groups/${g.id}/gw/${gw}/transfers?season=${SEASON}`;
const row = (o, elementId) => o.rows.find((r) => r.player.id === elementId);

test('ownership: denominators, captaincy and picked vs effective EO match a hand count', async () => {
  const { status, body } = await api(ownershipPath(group));
  assert.equal(status, 200, JSON.stringify(body));
  const o = body.ownership;
  assert.deepEqual([o.eventState, o.defaultView, o.view, o.effectiveProvisional], ['DATA_CHECKED', 'effective', 'effective', false]);
  assert.deepEqual(o.eligible, [101, 102, 103, 104]);
  assert.deepEqual(o.ineligible, [{ entryId: 105, reason: 'EXCLUDED' }]);
  assert.deepEqual(o.denominators, { rivals: 2, all: 3 });
  assert.deepEqual(o.missingEntryIds, [104]);
  assert.deepEqual(o.captaincy.map((c) => [c.entryId, c.pickedCaptain, c.capMult, c.effectiveCaptain.elementId, c.effectiveCaptain.via]),
    [[101, 1, 2, 1, 'CAPTAIN'], [102, 1, 3, 1, 'CAPTAIN'], [103, 5, 2, 6, 'VICE']]);
  assert.deepEqual(o.captaincy[2].autoSubbed, [{ elementId: 5, autoSubbed: 'OUT' }, { elementId: 12, autoSubbed: 'IN' }]);

  const e1 = row(o, 1);
  assert.deepEqual([e1.pickedCaptain.all.count, e1.pickedTriple.all.count, e1.effectiveCaptain.all.count, e1.pickedEo.all, e1.effectiveEo.all], [2, 1, 2, 2, 2]);
  const e5 = row(o, 5);
  assert.deepEqual([e5.pickedEo.all, e5.effectiveEo.all, e5.effectiveCaptain.all.count], [4 / 3, 2 / 3, 0]);
  const e6 = row(o, 6);
  assert.deepEqual([e6.effectiveCaptain.all.count, e6.effectiveEo.all], [1, 4 / 3]);
  const e20 = row(o, 20);
  assert.deepEqual([e20.pickedSquad.all.count, e20.owners, e20.myPickedMultiplier], [2, [102, 103], 0]);
  assert.equal(e20.player.webName, 'P20');
  // Rival comparison for Me (101): exposure = my multiplier − rivals' EO.
  assert.deepEqual([e1.myEffectiveMultiplier, e1.effectiveEo.rivals, e1.effectiveExposure], [2, 2, 0]);
  assert.deepEqual([e5.myEffectiveMultiplier, e5.effectiveEo.rivals, e5.effectiveExposure], [1, 0.5, 0.5]);
  assert.match(o.inputsHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(o.sources.length >= 1 && o.sources.every((s) => s.status === 'SUCCESS'), 'input references: the runs that confirmed the data');
});

test('rows are ordered deterministically by the selected metric, then element id', async () => {
  for (const view of ['picked', 'effective']) {
    const o = (await api(ownershipPath(group, GW, `&view=${view}`))).body.ownership;
    const key = view === 'picked' ? 'pickedEo' : 'effectiveEo';
    for (let i = 1; i < o.rows.length; i++) {
      const [a, b] = [o.rows[i - 1], o.rows[i]];
      assert.ok(a[key].all > b[key].all || (a[key].all === b[key].all && a.player.id < b.player.id), `${view}: ${a.player.id} before ${b.player.id}`);
    }
  }
});

test('transfers: GW activity per manager and players in / out across the group', async () => {
  const { status, body } = await api(transfersPath(group));
  assert.equal(status, 200, JSON.stringify(body));
  const tr = body.transfers;
  assert.deepEqual(tr.members.map((m) => [m.entryId, m.transfers.map((x) => [x.elementIn, x.elementOut]), m.transferCost]),
    [[101, [], 0], [102, [[20, 7]], 4], [103, [[20, 8]], 0], [104, [], 0]]);
  assert.deepEqual(tr.playersIn.map((p) => [p.elementId, p.count, p.entryIds]), [[20, 2, [102, 103]]]);
  assert.deepEqual(tr.playersOut.map((p) => [p.elementId, p.count]), [[7, 1], [8, 1]]);
  assert.deepEqual(tr.totals, { transfers: 2, managersWithTransfers: 2, managersWithHits: 1, hitCost: 4 });
  assert.deepEqual(tr.missingEntryIds, []);
});

test('reads never write, and repeated identical inputs give identical output', async () => {
  const dump = async () => {
    const out = {};
    for (const c of ['resultSnapshots', 'gwResultActions', 'gwResults', 'seasons', 'managerGameweeks', 'syncRuns', 'locks', 'groups']) out[c] = JSON.stringify(await raw(c).find().sort({ _id: 1 }).toArray());
    return out;
  };
  const before = await dump();
  const a = (await api(ownershipPath(group))).body.ownership;
  const b = (await api(ownershipPath(group))).body.ownership;
  await api(transfersPath(group));
  assert.deepEqual(await dump(), before);
  assert.deepEqual(b, a);
  // A replay sync (same FPL data) changes only confirmations: same view, same inputsHash.
  await sync.syncGroupGameweek({ groupId: group.id, season: SEASON, event: GW });
  const c = (await api(ownershipPath(group))).body.ownership;
  const { sources: _s1, ...restA } = a;
  const { sources: _s2, ...restC } = c;
  assert.deepEqual(restC, restA);
});

test('the view reproduces from the persisted inputs alone', async () => {
  const api1 = (await api(ownershipPath(group))).body.ownership;
  const loaded = await ownershipRepo.loadSquads(group.id, SEASON, GW);
  const rebuilt = JSON.parse(JSON.stringify(buildOwnershipView(ownershipInputs(loaded, GW))));
  const { groupId: _g, season: _s, sources: _src, ...served } = api1;
  assert.deepEqual(rebuilt, served);
});

test('missing / incomplete data: a GW without picks or live reports everyone missing, never zero-scores', async () => {
  const o = (await api(ownershipPath(group, 4))).body.ownership;
  assert.deepEqual(o.denominators, { rivals: 0, all: 0 });
  assert.deepEqual(o.missingEntryIds, [101, 102, 103, 104]);
  assert.deepEqual(o.rows, []);
  const future = (await api(ownershipPath(group, 20))).body.ownership;
  assert.deepEqual(future.eligible, []);
  assert.ok(future.ineligible.filter((i) => i.reason === 'NO_TEAM').length === 4, 'synced entries without a GW row are NO_TEAM');
  assert.equal(future.defaultView, 'picked', 'before MATCHES_FINISHED the picked view is the default');
});

test('authorization: anonymous 401, viewer reads its own group only, bad input rejected', async () => {
  const share = (await fetch(`${base}/api/groups/${group.id}/share-token`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } }).then((r) => r.json())).shareToken;
  for (const p of [ownershipPath(group), transfersPath(group)]) {
    assert.equal((await api(p, { token: null })).status, 401, p);
    assert.equal((await api(p, { share })).status, 200, p);
  }
  assert.equal((await api(ownershipPath(other), { share })).status, 404);
  assert.equal((await api(transfersPath(other), { share })).status, 404);
  assert.equal((await api(`/api/groups/${group.id}/gw/0/ownership?season=${SEASON}`)).status, 404);
  assert.equal((await api(`/api/groups/nope/gw/5/ownership?season=${SEASON}`)).status, 404);
  assert.equal((await api(`/api/groups/${'f'.repeat(24)}/gw/5/transfers?season=${SEASON}`)).status, 404);
  assert.equal((await api(`/api/groups/${group.id}/gw/5/ownership`)).status, 400, 'season required');
  assert.equal((await api(ownershipPath(group, GW, '&view=best'))).status, 400);
});
