import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { createWorld, worldClient, tickingClock, LEAGUE, GW } from '../helpers/fplWorld.js';

// Step 8 API: authentication, authorization, group management and membership,
// against the replica-set test database and a synthetic FPL API.

const PASSWORD = 'correct horse battery staple';
const JWT_SECRET = 'j'.repeat(48);
let t;
let server;
let base;
let world;
let adminToken;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  world = createWorld();
  const sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  const config = { NODE_ENV: 'test', PORT: 4000, MONGODB_URI: t.uri, MONGODB_DB: t.dbName, JWT_SECRET, ADMIN_PASSWORD_HASH: await bcrypt.hash(PASSWORD, 4), FPL_API_BASE_URL: 'https://fpl.test/api' };
  const app = createApp({ config, version: 'test', getDbStatus: async () => ({ ok: true }), services: { groups: createGroupService({ sync }) }, loginLimit: { windowMs: 60_000, limit: 5 }, log: () => {} });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await t.stop();
});

const raw = (coll) => t.db.collection(coll);

async function api(method, path, { body, token, share, cookie, rawBody } = {}) {
  const headers = {};
  if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (share) headers['x-share-token'] = share;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const as = (method, path, body) => api(method, path, { body, token: adminToken });

// ── authentication ──────────────────────────────────────────────────────

test('unauthenticated requests are rejected; health stays public', async () => {
  for (const [m, p] of [['GET', '/api/groups'], ['POST', '/api/groups'], ['GET', `/api/groups/${'a'.repeat(24)}`], ['GET', '/api/auth/me'], ['GET', `/api/leagues/${LEAGUE}/preview`], ['POST', '/api/entries/validate']]) {
    const r = await api(m, p, { body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.body.error.code, 'UNAUTHENTICATED');
  }
  assert.equal((await api('GET', '/api/health')).status, 200);
});

test('invalid, forged and expired credentials are treated as none', async () => {
  const forged = signAdminToken('another-secret-with-enough-length-000000');
  const expired = signAdminToken(JWT_SECRET, { ttlSeconds: 1, nowSeconds: Math.floor(Date.now() / 1000) - 60 });
  for (const token of [forged, expired, 'garbage']) assert.equal((await api('GET', '/api/groups', { token })).status, 401);
  assert.equal((await api('GET', '/api/groups', { share: 'x'.repeat(43) })).status, 401, 'unknown share token');
});

test('login: wrong password → 401, right password → httpOnly SameSite=Strict cookie', async () => {
  const bad = await api('POST', '/api/auth/login', { body: { password: 'nope' } });
  assert.deepEqual([bad.status, bad.body.error.code], [401, 'INVALID_CREDENTIALS']);
  const ok = await api('POST', '/api/auth/login', { body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /^fpl_admin=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api/);
  assert.equal(ok.body.token, undefined, 'the token is only in the httpOnly cookie');
  const cookie = setCookie.split(';')[0];
  adminToken = decodeURIComponent(cookie.slice('fpl_admin='.length)); // also accepted as a Bearer token
  assert.deepEqual((await api('GET', '/api/auth/me', { cookie })).body, { principal: { role: 'admin' } });
  assert.equal((await api('GET', '/api/groups', { cookie })).status, 200);
  const out = await api('POST', '/api/auth/logout', { cookie });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /fpl_admin=;/);
  assert.equal((await api('POST', '/api/auth/login', { body: { password: PASSWORD, fplPassword: 'x' } })).status, 400, 'no FPL credentials accepted');
});

test('login attempts are rate limited', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await api('POST', '/api/auth/login', { body: { password: `wrong-${i}` } });
  assert.deepEqual([last.status, last.body.error.code], [429, 'RATE_LIMITED']);
});

// ── league access classification and entry validation ───────────────────

test('league preview keeps OK / AUTH_REQUIRED / EMPTY / NOT_FOUND distinct and never fakes an empty league', async () => {
  const ok = await as('GET', `/api/leagues/${LEAGUE}/preview`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.access, 'OK');
  assert.deepEqual(ok.body.members.map((m) => m.entryId), [101, 102, 103]);

  world.overrides.set('/leagues-classic/777/standings/?page_standings=1', new Response('{"detail":"Authentication credentials were not provided."}', { status: 403, headers: { 'content-type': 'application/json' } }));
  world.overrides.set('/leagues-classic/778/standings/?page_standings=1', new Response(JSON.stringify({ league: { id: 778, name: 'Empty' }, standings: { has_next: false, page: 1, results: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  world.overrides.set('/leagues-classic/779/standings/?page_standings=1', new Response('Host not in allowlist', { status: 403, headers: { 'x-deny-reason': 'host_not_allowed' } }));
  try {
    assert.equal((await as('GET', '/api/leagues/777/preview')).body.access, 'AUTH_REQUIRED');
    assert.equal((await as('GET', '/api/leagues/778/preview')).body.access, 'EMPTY');
    assert.equal((await as('GET', '/api/leagues/4040/preview')).body.access, 'NOT_FOUND');
    const blocked = await as('GET', '/api/leagues/779/preview');
    assert.deepEqual([blocked.status, blocked.body.error.code, blocked.body.error.details.cause], [502, 'FPL_UNAVAILABLE', 'BLOCKED']);
    assert.equal((await as('GET', '/api/leagues/abc/preview')).status, 404);
  } finally {
    world.overrides.clear();
  }
});

test('entry validation reports unknown entries without creating anything', async () => {
  const r = await as('POST', '/api/entries/validate', { entryIds: [101, 999] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.valid.map((v) => v.entryId), [101]);
  assert.deepEqual(r.body.invalid, [999]);
  assert.equal(await raw('managers').countDocuments(), 0);
});

// ── group lifecycle ─────────────────────────────────────────────────────

let leagueGroup;
let manualGroup;

test('creating a league group takes members from standings, with managers and a logged run', async () => {
  const r = await as('POST', '/api/groups', { name: 'Group B', memberSource: 'LEAGUE_STANDINGS', fplLeagueId: LEAGUE, winnerRule: 'NET_POINTS', myEntryId: 101 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  leagueGroup = r.body.group;
  assert.equal(leagueGroup.slug, 'group-b');
  assert.deepEqual(leagueGroup.tieBreakRules, ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED']);
  assert.deepEqual(leagueGroup.members.map((m) => [m.entryId, m.addedManually]), [[101, false], [102, false], [103, false]]);
  assert.equal(await raw('managers').countDocuments({ _id: { $in: [101, 102, 103] } }), 3, 'no orphan members (db:check I3)');
  const run = await raw('syncRuns').findOne({ job: 'group-create', target: leagueGroup.id });
  assert.equal(run.status, 'SUCCESS');
  assert.ok(run.requests.length >= 2 && run.requests.every((q) => /^sha256:/.test(q.bodySha256)));
  const mgr = await raw('managers').findOne({ _id: 101 });
  assert.equal(String(mgr.provenance.lastConfirmedByRunId), String(run._id));
  assert.equal((await raw('locks').findOne({ _id: `sync:group:${leagueGroup.id}` })).owner, null, 'lease released');
});

test('a league already configured (even archived) is refused with its group id', async () => {
  const r = await as('POST', '/api/groups', { name: 'Again', memberSource: 'LEAGUE_STANDINGS', fplLeagueId: LEAGUE, winnerRule: 'NET_POINTS' });
  assert.deepEqual([r.status, r.body.error.code, r.body.error.details], [409, 'LEAGUE_ALREADY_CONFIGURED', { groupId: leagueGroup.id, archived: false }]);
});

test('a league without anonymous access is refused, not created empty; manual mode is the fallback', async () => {
  world.overrides.set('/leagues-classic/777/standings/?page_standings=1', new Response('{"detail":"Authentication credentials were not provided."}', { status: 403, headers: { 'content-type': 'application/json' } }));
  try {
    const r = await as('POST', '/api/groups', { name: 'Private', memberSource: 'LEAGUE_STANDINGS', fplLeagueId: 777, winnerRule: 'NET_POINTS' });
    assert.deepEqual([r.status, r.body.error.code, r.body.error.details], [422, 'LEAGUE_NOT_ACCESSIBLE', { access: 'AUTH_REQUIRED' }]);
    assert.equal(await raw('groups').countDocuments({ fplLeagueId: 777 }), 0);
    assert.equal((await raw('syncRuns').findOne({ job: 'group-create' }, { sort: { startedAt: -1 } })).status, 'FAILED');
    // Manual fallback: the league id is kept as a label only (v0.2 §10).
    const m = await as('POST', '/api/groups', { name: 'Private (manual)', memberSource: 'MANUAL', fplLeagueId: 777, entryIds: [102, 101], winnerRule: 'GROSS_POINTS' });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    manualGroup = m.body.group;
    assert.deepEqual(manualGroup.members.map((x) => [x.entryId, x.addedManually]), [[102, true], [101, true]]);
  } finally {
    world.overrides.clear();
  }
});

test('manual creation rejects unknown entries and duplicate entry IDs, persisting nothing', async () => {
  const before = await raw('groups').countDocuments();
  const unknown = await as('POST', '/api/groups', { name: 'X', memberSource: 'MANUAL', entryIds: [101, 999], winnerRule: 'NET_POINTS' });
  assert.deepEqual([unknown.status, unknown.body.error.code, unknown.body.error.details], [422, 'INVALID_ENTRY_IDS', { invalid: [999] }]);
  const dup = await as('POST', '/api/groups', { name: 'Y', memberSource: 'MANUAL', entryIds: [101, 101], winnerRule: 'NET_POINTS' });
  assert.deepEqual([dup.status, dup.body.error.code], [409, 'DUPLICATE_MEMBER']);
  const notMember = await as('POST', '/api/groups', { name: 'Z', memberSource: 'MANUAL', entryIds: [101], myEntryId: 103, winnerRule: 'NET_POINTS' });
  assert.deepEqual([notMember.status, notMember.body.error.code], [422, 'MY_ENTRY_NOT_MEMBER']);
  const slug = await as('POST', '/api/groups', { name: 'Group B', memberSource: 'MANUAL', entryIds: [101], winnerRule: 'NET_POINTS' });
  assert.deepEqual([slug.status, slug.body.error.code], [409, 'SLUG_TAKEN']);
  assert.equal(await raw('groups').countDocuments(), before);
});

test('request validation maps to 400 with the failing fields', async () => {
  const cases = [
    { name: 'A', memberSource: 'LEAGUE_STANDINGS', winnerRule: 'NET_POINTS' },
    { name: 'A', memberSource: 'MANUAL', winnerRule: 'NET_POINTS' },
    { name: 'A', memberSource: 'MANUAL', entryIds: [0], winnerRule: 'NET_POINTS' },
    { name: 'A', memberSource: 'MANUAL', entryIds: [1], winnerRule: 'MOST_GOALS' },
    { name: 'A', memberSource: 'MANUAL', entryIds: [1], winnerRule: 'NET_POINTS', tieBreakRules: ['LOWER_ENTRY_ID', 'SHARED'] },
    { name: 'A', memberSource: 'MANUAL', entryIds: [1], winnerRule: 'NET_POINTS', ownerPassword: 'x' },
  ];
  for (const body of cases) {
    const r = await as('POST', '/api/groups', body);
    assert.deepEqual([r.status, r.body.error.code], [400, 'VALIDATION_FAILED'], JSON.stringify(body));
    assert.ok(r.body.error.details.issues.length > 0);
  }
  const json = await api('POST', '/api/groups', { rawBody: '{"name":', token: adminToken });
  assert.deepEqual([json.status, json.body.error.code], [400, 'INVALID_JSON']);
  const chain = await as('PATCH', `/api/groups/${manualGroup.id}`, { tieBreakRules: ['SHARED', 'FEWER_TRANSFER_COST'] });
  assert.deepEqual([chain.status, chain.body.error.code], [422, 'VALIDATION_FAILED'], 'SHARED must be last (model rule)');
});

test('invalid or nonexistent group references are rejected', async () => {
  for (const id of ['abc', 'a'.repeat(23), 'Z'.repeat(24), '0'.repeat(24), 'ffffffffffffffffffffffff']) {
    for (const [m, p, b] of [['GET', `/api/groups/${id}`], ['PATCH', `/api/groups/${id}`, { name: 'x' }], ['POST', `/api/groups/${id}/members`, { entryIds: [101] }], ['POST', `/api/groups/${id}/archive`], ['POST', `/api/groups/${id}/sync`, { season: '2026-27', event: GW }]]) {
      const r = await as(m, p, b);
      assert.deepEqual([r.status, r.body.error.code], [404, 'NOT_FOUND'], `${m} ${p}`);
    }
  }
  assert.equal((await as('PATCH', `/api/groups/${manualGroup.id}/members/424242`, { isExcluded: true })).body.error.code, 'MEMBER_NOT_FOUND');
});

// ── membership ─────────────────────────────────────────────────────────

test('manual members are added once; duplicates are refused, never merged', async () => {
  const r = await as('POST', `/api/groups/${manualGroup.id}/members`, { entryIds: [103] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.group.members.map((m) => m.entryId), [102, 101, 103]);
  const again = await as('POST', `/api/groups/${manualGroup.id}/members`, { entryIds: [103] });
  assert.deepEqual([again.status, again.body.error.code, again.body.error.details], [409, 'DUPLICATE_MEMBER', { entryIds: [103] }]);
  const inBody = await as('POST', `/api/groups/${manualGroup.id}/members`, { entryIds: [104, 104] });
  assert.equal(inBody.status, 409);
  const unknown = await as('POST', `/api/groups/${manualGroup.id}/members`, { entryIds: [999] });
  assert.deepEqual([unknown.status, unknown.body.error.code], [422, 'INVALID_ENTRY_IDS']);
  const g = await raw('groups').findOne({ _id: new mongoose.Types.ObjectId(manualGroup.id) });
  assert.equal(new Set(g.members.map((m) => m.entryId)).size, g.members.length);
});

test('concurrent adds of one entry cannot duplicate it (lease + transactional uniqueness)', async () => {
  world.state.entries[104] = { profile: { id: 104, name: 'Team 104', player_first_name: 'M', player_last_name: '104' }, rows: [], chips: [], picks: [], activeChip: null, transfers: [] };
  const results = await Promise.all([1, 2, 3].map(() => as('POST', `/api/groups/${manualGroup.id}/members`, { entryIds: [104] })));
  const ok = results.filter((r) => r.status === 200).length;
  assert.equal(ok, 1, JSON.stringify(results.map((r) => [r.status, r.body.error?.code])));
  for (const r of results.filter((x) => x.status !== 200)) assert.ok(['SYNC_IN_PROGRESS', 'DUPLICATE_MEMBER'].includes(r.body.error.code));
  const g = await raw('groups').findOne({ _id: new mongoose.Types.ObjectId(manualGroup.id) });
  assert.equal(g.members.filter((m) => m.entryId === 104).length, 1);
});

test('members are excluded, never removed', async () => {
  const r = await as('PATCH', `/api/groups/${manualGroup.id}/members/102`, { isExcluded: true, joinedEvent: 3 });
  assert.equal(r.status, 200);
  const m = r.body.group.members.find((x) => x.entryId === 102);
  assert.deepEqual([m.isExcluded, m.joinedEvent], [true, 3]);
  assert.equal(r.body.group.members.length, 4);
});

test('config updates: myEntryId must be a member; league groups can fall back to manual', async () => {
  const bad = await as('PATCH', `/api/groups/${leagueGroup.id}`, { myEntryId: 555 });
  assert.deepEqual([bad.status, bad.body.error.code], [422, 'MY_ENTRY_NOT_MEMBER']);
  const ok = await as('PATCH', `/api/groups/${leagueGroup.id}`, { name: 'Group B!', winnerRule: 'GROSS_POINTS', tieBreakRules: ['HIGHER_CAPTAIN_POINTS', 'SHARED'] });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.group.name, ok.body.group.winnerRule, ok.body.group.slug], ['Group B!', 'GROSS_POINTS', 'group-b']);
  assert.equal((await as('PATCH', `/api/groups/${leagueGroup.id}`, { memberSource: 'LEAGUE_STANDINGS' })).status, 400, 'only the manual fallback');
  assert.equal((await as('PATCH', `/api/groups/${leagueGroup.id}`, { slug: 'x' })).status, 400);
  assert.equal((await as('PATCH', `/api/groups/${leagueGroup.id}`, {})).status, 400);
});

// ── authorization: share-token viewers ───────────────────────────────────

let shareA;
test('a share-token viewer reads its own group only, and never writes', async () => {
  const issued = await as('POST', `/api/groups/${leagueGroup.id}/share-token`);
  shareA = issued.body.shareToken;
  assert.match(shareA, /^[A-Za-z0-9_-]{43}$/);
  const own = await api('GET', `/api/groups/${leagueGroup.id}`, { share: shareA });
  assert.equal(own.status, 200);
  assert.equal(own.body.group.id, leagueGroup.id);
  assert.equal(own.body.group.shareToken, undefined, 'viewers never see the token');
  assert.deepEqual((await api('GET', '/api/auth/me', { share: shareA })).body, { principal: { role: 'viewer', groupId: leagueGroup.id } });

  const other = await api('GET', `/api/groups/${manualGroup.id}`, { share: shareA });
  assert.deepEqual([other.status, other.body.error.code], [404, 'NOT_FOUND'], "another group's existence is not confirmed");
  assert.equal((await api('GET', '/api/groups', { share: shareA })).status, 403);
  for (const [m, p, body] of [
    ['PATCH', `/api/groups/${leagueGroup.id}`, { name: 'hijack' }],
    ['POST', `/api/groups/${leagueGroup.id}/members`, { entryIds: [103] }],
    ['POST', `/api/groups/${leagueGroup.id}/archive`],
    ['POST', `/api/groups/${leagueGroup.id}/share-token`],
    ['POST', `/api/groups/${leagueGroup.id}/sync`, { season: '2026-27', event: GW }],
    ['POST', '/api/groups', { name: 'x', memberSource: 'MANUAL', entryIds: [1], winnerRule: 'NET_POINTS' }],
  ]) {
    const r = await api(m, p, { body, share: shareA });
    assert.deepEqual([r.status, r.body.error.code], [403, 'FORBIDDEN'], `${m} ${p}`);
  }
  assert.equal((await as('GET', `/api/groups/${leagueGroup.id}`)).body.group.shareToken, shareA, 'the admin sees it');
});

test('rotating or revoking a share token cuts the old viewer off', async () => {
  const rotated = (await as('POST', `/api/groups/${leagueGroup.id}/share-token`)).body.shareToken;
  assert.notEqual(rotated, shareA);
  assert.equal((await api('GET', `/api/groups/${leagueGroup.id}`, { share: shareA })).status, 401);
  assert.equal((await api('GET', `/api/groups/${leagueGroup.id}`, { share: rotated })).status, 200);
  assert.equal((await as('POST', `/api/groups/${leagueGroup.id}/share-token/revoke`)).status, 204);
  assert.equal((await api('GET', `/api/groups/${leagueGroup.id}`, { share: rotated })).status, 401);
});

// ── archive, sync, listing ─────────────────────────────────────────────

test('archived groups are read-only; unarchive restores writes', async () => {
  const a = await as('POST', `/api/groups/${manualGroup.id}/archive`);
  assert.deepEqual([a.status, a.body.group.isActive], [200, false]);
  for (const [m, p, body] of [
    ['PATCH', `/api/groups/${manualGroup.id}`, { name: 'x' }],
    ['POST', `/api/groups/${manualGroup.id}/members`, { entryIds: [103] }],
    ['PATCH', `/api/groups/${manualGroup.id}/members/101`, { isExcluded: true }],
    ['POST', `/api/groups/${manualGroup.id}/share-token`],
    ['POST', `/api/groups/${manualGroup.id}/sync`, { season: '2026-27', event: GW }],
  ]) {
    const r = await as(m, p, body);
    assert.deepEqual([r.status, r.body.error.code], [409, 'GROUP_ARCHIVED'], `${m} ${p}`);
  }
  assert.equal((await as('GET', `/api/groups/${manualGroup.id}`)).status, 200, 'reads still work');
  assert.ok(!(await as('GET', '/api/groups')).body.groups.some((g) => g.id === manualGroup.id));
  assert.ok((await as('GET', '/api/groups?includeArchived=true')).body.groups.some((g) => g.id === manualGroup.id));
  const dupLeague = await as('POST', '/api/groups', { name: 'Label reuse', memberSource: 'MANUAL', fplLeagueId: 777, entryIds: [101], winnerRule: 'NET_POINTS' });
  assert.deepEqual([dupLeague.status, dupLeague.body.error.details], [409, { groupId: manualGroup.id, archived: true }]);
  assert.equal((await as('POST', `/api/groups/${manualGroup.id}/unarchive`)).body.group.isActive, true);
});

test('an admin sync of a group runs the Step 7 sync and reports its run', async () => {
  const r = await as('POST', `/api/groups/${leagueGroup.id}/sync`, { season: '2026-27', event: GW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.run.status, 'SUCCESS');
  assert.equal((await as('POST', `/api/groups/${leagueGroup.id}/sync`, { season: '26-27', event: GW })).status, 400);
});

test('no FPL credentials exist anywhere in the database', async () => {
  const dump = [];
  for (const c of await t.db.listCollections().toArray()) dump.push(JSON.stringify(await raw(c.name).find().toArray()));
  const all = dump.join('\n');
  assert.doesNotMatch(all, /password|pl_profile|sessionid|csrftoken|cookie/i);
  assert.ok(!all.includes(PASSWORD));
});

test('transaction rollback: a failure inside the create T2 leaves no group and no managers', async () => {
  // Entry 105 exists on FPL but its profile fails the managers model (empty names),
  // so the T2 aborts after the group insert.
  world.state.entries[105] = { profile: { id: 105, name: '', player_first_name: '', player_last_name: '' }, rows: [], chips: [], picks: [], activeChip: null, transfers: [] };
  const groupsBefore = await raw('groups').countDocuments();
  const r = await as('POST', '/api/groups', { name: 'Rollback', memberSource: 'MANUAL', entryIds: [103, 105], winnerRule: 'NET_POINTS' });
  assert.deepEqual([r.status, r.body.error.code], [422, 'VALIDATION_FAILED']);
  assert.equal(await raw('groups').countDocuments(), groupsBefore);
  assert.equal(await raw('groups').countDocuments({ slug: 'rollback' }), 0);
  assert.equal(await raw('managers').countDocuments({ _id: 105 }), 0);
  const run = await raw('syncRuns').findOne({ job: 'group-create' }, { sort: { startedAt: -1 } });
  assert.equal(run.status, 'FAILED');
  delete world.state.entries[105];
});
