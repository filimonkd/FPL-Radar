import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { createOwnershipService } from '../../src/services/ownershipService.js';
import { createStatusService } from '../../src/services/statusService.js';
import { createRivalsService } from '../../src/services/rivalsService.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { groupRepo } from '../../src/repositories/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 16: rival analytics end to end on synced synthetic FPL data.

const SEASON = '2026-27';
const JWT_SECRET = 'r'.repeat(48);
const admin = signAdminToken(JWT_SECRET);
let t;
let server;
let base;
let group;
let other;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  const world = createWorld({ entries: [101, 102, 103, 104] });
  world.state.chips = ['wildcard', 'freehit', 'bboost', '3xc'].flatMap((name, i) => [
    { id: i * 2 + 1, name, number: 1, start_event: name === 'wildcard' || name === 'freehit' ? 2 : 1, stop_event: 19, chip_type: name === 'wildcard' || name === 'freehit' ? 'transfer' : 'team' },
    { id: i * 2 + 2, name, number: 1, start_event: 20, stop_event: 38, chip_type: name === 'wildcard' || name === 'freehit' ? 'transfer' : 'team' },
  ]);
  const e = world.state.entries;
  // 102: three different starters (9, 10, 11 → 16, 17, 18) and a GW5 transfer in of 20.
  e[102].picks = e[102].picks.map((p) => (p.element >= 9 && p.element <= 11 ? { ...p, element: p.element + 7 } : p));
  e[102].transfers.push({ element_in: 20, element_in_cost: 45, element_out: 7, element_out_cost: 50, entry: 102, event: 5, time: '2026-09-11T08:00:00Z' });
  e[103].transfers.push({ element_in: 20, element_in_cost: 45, element_out: 8, element_out_cost: 50, entry: 103, event: 5, time: '2026-09-11T09:00:00Z' });

  const sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  const ownership = createOwnershipService();
  const status = createStatusService();
  const app = createApp({
    config: { NODE_ENV: 'test', JWT_SECRET }, version: 'test', getDbStatus: async () => ({ ok: true }), log: () => {},
    services: { groups: createGroupService({ sync }), ownership, status, rivals: createRivalsService({ ownership, status }) },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  group = await groupRepo.create({ name: 'Rivals', slug: 'rivals', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', myEntryId: 101, members: [101, 102, 103, 104].map((entryId) => ({ entryId })) });
  other = await groupRepo.create({ name: 'Other', slug: 'other', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 101 }] });
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
const rivalsPath = (g, gw = GW) => `/api/groups/${g.id}/gw/${gw}/rivals?season=${SEASON}`;

test('leaderboard, podium and GW top scorer from synced totals', async () => {
  const { status, body } = await api(rivalsPath(group));
  assert.equal(status, 200, JSON.stringify(body));
  const r = body.rivals;
  assert.equal(r.leaderboard.length, 4);
  const totals = r.leaderboard.map((x) => x.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a), 'ordered by FPL season total');
  assert.deepEqual(r.leaderboard.map((x) => x.rank), [1, 2, 3, 4]);
  assert.equal(r.podium.length, 3);
  assert.equal(r.gwTop[0].entryId, 104, 'highest GW5 score in the world');
  assert.equal(r.leaderboard.find((x) => x.entryId === 101).isMe, true);
  assert.match(r.inputsHash, /^sha256:/);
  assert.ok(r.sources.length >= 1, 'provenance runs listed');
});

test('spy vs me: differentials, XI overlap, bank/value, captain', async () => {
  const r = (await api(rivalsPath(group))).body.rivals;
  const r102 = r.rivals.find((x) => x.entryId === 102);
  const me = r.leaderboard.find((x) => x.entryId === 101);
  assert.equal(r102.overallDiff, r102.total - me.total);
  assert.equal(r102.gwDiff, r102.gwScore - me.gwScore);
  assert.deepEqual([r102.overlap.shared, r102.overlap.of, r102.overlap.theirOnly], [8, 11, [16, 17, 18]]);
  assert.equal(r102.captain, 1);
  assert.ok(Number.isInteger(r102.bankTenths) && Number.isInteger(r102.valueTenths));
  assert.equal(r.rivals.some((x) => x.entryId === 101), false, 'me is not my own rival');
});

test('rival radar: closest rivals, form, hits, chips left, head to head, threat', async () => {
  const r = (await api(rivalsPath(group))).body.rivals;
  assert.equal(r.closest.myRank, 4);
  assert.equal(r.closest.above.entryId, r.leaderboard[2].entryId);
  assert.equal(r.closest.below, null, 'nobody below the last place');
  const r102 = r.rivals.find((x) => x.entryId === 102);
  assert.equal(r102.hits, 4, 'the GW3 hit');
  assert.deepEqual(r102.formGws, [3, 4, 5]);
  const r103 = r.rivals.find((x) => x.entryId === 103);
  assert.ok(!r103.chipsLeft.includes('bboost'), 'bench boost used in GW2 is gone from the first window');
  assert.ok(r103.chipsLeft.includes('3xc'));
  assert.equal(r103.h2h.gws, 5);
  assert.equal(r103.h2h.losses + r103.h2h.wins + r103.h2h.draws, 5);
  for (const x of r.rivals) assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(x.threat.level));
  assert.match(r.rules.threat, /3\+ = HIGH/);
});

test('strategy lab: bandwagon, xPts from FPL ep_next, FDR for the next 3 GWs', async () => {
  const r = (await api(rivalsPath(group))).body.rivals;
  const top = r.strategy.bandwagon[0];
  assert.deepEqual([top.elementId, top.count, top.boughtBy, top.iOwn], [20, 2, [102, 103], false]);
  assert.ok(r.strategy.xpts.every((m) => m.xPts > 0 && m.missing === 0), JSON.stringify(r.strategy.xpts));
  assert.deepEqual(r.strategy.fdrWindow, [6, 7, 8]);
  assert.ok(r.strategy.fdr.every((m) => m.fdr >= 1 && m.fdr <= 5 && m.fixtures > 0));
});

test('read-only and deterministic', async () => {
  const counts = async () => Object.fromEntries(await Promise.all(['managerGameweeks', 'syncRuns', 'resultSnapshots', 'gwResults'].map(async (c) => [c, await t.db.collection(c).countDocuments()])));
  const before = await counts();
  const a = (await api(rivalsPath(group))).body.rivals;
  const b = (await api(rivalsPath(group))).body.rivals;
  assert.deepEqual(a, b);
  assert.deepEqual(await counts(), before);
});

test('authorization: admin and own-group viewer only; bad input rejected', async () => {
  assert.equal((await api(rivalsPath(group), { token: null })).status, 401);
  const share = (await fetch(`${base}/api/groups/${group.id}/share-token`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } }).then((x) => x.json())).shareToken;
  assert.equal((await api(rivalsPath(group), { share })).status, 200);
  assert.equal((await api(rivalsPath(other), { share })).status, 404, 'other groups are invisible to a viewer');
  assert.equal((await api(`/api/groups/${group.id}/gw/39/rivals?season=${SEASON}`)).status, 404);
  assert.equal((await api(`/api/groups/${group.id}/gw/5/rivals?season=bad`)).status, 400);
  assert.equal((await api('/api/groups/0123456789abcdef01234567/gw/5/rivals?season=2026-27')).status, 404);
});
