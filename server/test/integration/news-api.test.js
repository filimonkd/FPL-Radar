import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { createPlayersService, REFRESH_TTL_MS } from '../../src/services/playersService.js';
import { createNewsService } from '../../src/services/newsService.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { groupRepo, playerRepo } from '../../src/repositories/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 18: the injury & news feed and the throttled FPL refresh, end to end.

const SEASON = '2026-27';
const JWT_SECRET = 'n'.repeat(48);
const admin = signAdminToken(JWT_SECRET);
let t;
let server;
let base;
let group;
let world;
let now; // the players service clock
let share;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  world = createWorld({ entries: [601, 602] });
  world.state.elementPatch = {
    1: { status: 'i', news: 'Hamstring injury - Expected back 04 Oct', news_added: '2026-09-20T10:00:00Z', chance_of_playing_next_round: 0 },
    2: { status: 'd', news: 'Knock - 75% chance of playing', news_added: '2026-09-21T10:00:00Z', chance_of_playing_next_round: 75 },
    3: { cost_change_event: -1 },
    16: { status: 's', news: 'Suspended until 05 Oct', news_added: '2026-09-19T10:00:00Z', chance_of_playing_next_round: 0 },
    25: { status: 'i', news: 'Nobody here owns him', news_added: '2026-09-22T10:00:00Z' },
  };
  // 602 swaps player 1 for 16: 1 is mine only, 16 is the rival's only.
  world.state.entries[602].picks = world.state.entries[602].picks.map((p) => (p.element === 1 ? { ...p, element: 16 } : p));

  const sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  now = new Date('2026-09-22T19:00:00Z');
  const players = createPlayersService({ sync, clock: () => now });
  const app = createApp({
    config: { NODE_ENV: 'test', JWT_SECRET }, version: 'test', getDbStatus: async () => ({ ok: true }), log: () => {},
    services: { groups: createGroupService({ sync }), players, news: createNewsService({ players }) },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  group = await groupRepo.create({ name: 'News', slug: 'news', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', myEntryId: 601, members: [{ entryId: 601 }, { entryId: 602 }] });
  const r = await sync.syncGroupGameweek({ groupId: group.id, season: SEASON, event: GW });
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.failures));
  share = (await fetch(`${base}/api/groups/${group.id}/share-token`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } }).then((x) => x.json())).shareToken;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await t.stop();
});

async function api(path, { token = admin, shareToken, method = 'GET' } = {}) {
  const headers = {};
  if (shareToken) headers['x-share-token'] = shareToken;
  else if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers });
  return { status: res.status, body: await res.json() };
}
const newsPath = () => `/api/groups/${group.id}/gw/${GW}/news?season=${SEASON}`;
const refreshPath = `/api/seasons/${SEASON}/players/refresh`;

test('feed: owned players only, newest news first, owners and my alerts', async () => {
  const { status, body } = await api(newsPath());
  assert.equal(status, 200, JSON.stringify(body));
  const n = body.news;
  assert.deepEqual(n.items.map((x) => x.elementId), [2, 1, 16, 3], 'dated news newest first, then the undated price drop; 25 is unowned');
  const p2 = n.items[0];
  assert.deepEqual(p2.flags, [{ code: 'DOUBT', chance: 75 }]);
  assert.deepEqual(p2.ownedBy, [601, 602]);
  assert.equal(p2.news, 'Knock - 75% chance of playing');
  assert.equal(n.items[1].flags[0].label, 'Injured');
  assert.deepEqual(n.items[1].ownedBy, [601]);
  assert.deepEqual(n.items[2].ownedBy, [602]);
  assert.equal(n.items[2].ownedByMe, false);
  assert.deepEqual(n.mine.map((x) => x.elementId), [1, 2, 3], 'my squad, most severe first');
  assert.deepEqual(n.managers.map((m) => m.entryId), [601, 602]);
  assert.deepEqual(n.squads, [{ entryId: 601, event: GW }, { entryId: 602, event: GW }]);
  assert.ok(n.asOf, 'when FPL was last read');
  assert.equal((await api(newsPath(), { shareToken: share })).status, 200, 'viewers read the feed');
  assert.equal((await api(newsPath(), { token: null })).status, 401);
});

test('refresh: at most one FPL read per 5 minutes, admin only; a failure is reported, stored news kept', async () => {
  const asOf = await playerRepo.getLastConfirmedAt(SEASON);
  assert.ok(asOf, 'the group sync confirmed the players');

  now = new Date(asOf.getTime() + 60_000);
  let calls = world.calls.length;
  let r = (await api(refreshPath, { method: 'POST' })).body.refresh;
  assert.equal(r.refreshed, false);
  assert.equal(r.reason, 'FRESH');
  assert.equal(world.calls.length, calls, 'no FPL request inside the window');

  world.state.elementPatch[5] = { status: 'd', news: 'Illness', news_added: '2026-09-22T12:00:00Z', chance_of_playing_next_round: 50 };
  now = new Date(asOf.getTime() + REFRESH_TTL_MS + 1000);
  calls = world.calls.length;
  r = (await api(refreshPath, { method: 'POST' })).body.refresh;
  assert.equal(r.refreshed, true, JSON.stringify(r));
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(world.calls.slice(calls), ['/bootstrap-static/', '/fixtures/'], 'bootstrap and fixtures only');
  assert.ok(new Date(r.asOf) > asOf);
  const n = (await api(newsPath())).body.news;
  assert.equal(n.items[0].elementId, 5, 'the fresh news is in the feed at once');

  assert.equal((await api(refreshPath, { method: 'POST', shareToken: share })).status, 403, 'viewers never trigger FPL requests');
  assert.equal((await api(refreshPath, { method: 'POST', token: null })).status, 401);

  now = new Date(new Date(r.asOf).getTime() + REFRESH_TTL_MS + 1000);
  world.overrides.set('/bootstrap-static/', new Response('down', { status: 503 }));
  r = (await api(refreshPath, { method: 'POST' })).body.refresh;
  world.overrides.delete('/bootstrap-static/');
  assert.equal(r.refreshed, false);
  assert.equal(r.status, 'FAILED');
  assert.ok(r.failures.length >= 1);
  assert.equal((await api(newsPath())).body.news.items[0].elementId, 5, 'stored news is still served');
});
