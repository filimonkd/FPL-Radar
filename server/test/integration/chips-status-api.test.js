import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { createResultService } from '../../src/services/resultService.js';
import { createOwnershipService } from '../../src/services/ownershipService.js';
import { createStatusService } from '../../src/services/statusService.js';
import { chipInputs, buildChipView } from '../../src/services/chipModel.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { groupRepo, ownershipRepo } from '../../src/repositories/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 11: chips page and status page (v0.2 §8; v0.3 §9, §15), end to end on
// synced synthetic FPL data.

const SEASON = '2026-27';
const JWT_SECRET = 'c'.repeat(48);
const admin = signAdminToken(JWT_SECRET);
const T = (event) => new Date(Date.UTC(2026, 7, 15 + (event - 1) * 7, 11)).toISOString();
let t;
let server;
let base;
let world;
let sync;
let results;
let group;
let clean;
let other;

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  world = createWorld({ entries: [101, 102, 103, 104, 105] });
  world.state.chips = ['wildcard', 'freehit', 'bboost', '3xc'].flatMap((name, i) => [
    { id: i * 2 + 1, name, number: 1, start_event: name === 'wildcard' || name === 'freehit' ? 2 : 1, stop_event: 19, chip_type: name === 'wildcard' || name === 'freehit' ? 'transfer' : 'team' },
    { id: i * 2 + 2, name, number: 1, start_event: 20, stop_event: 38, chip_type: name === 'wildcard' || name === 'freehit' ? 'transfer' : 'team' },
  ]);
  const e = world.state.entries;
  e[101].chips = [{ name: 'bboost', event: 5, time: T(5) }];
  e[101].activeChip = 'bboost';
  e[102].chips = [{ name: '3xc', event: 5, time: T(5) }];
  e[102].activeChip = '3xc';
  e[103].chips = [{ name: 'wildcard', event: 2, time: T(2) }]; // GW2, window 2–19 starts here
  e[104].chips = [{ name: 'freehit', event: 5, time: T(5) }]; // squad shows none → disagreement
  e[105].chips = [];
  e[105].activeChip = 'wildcard'; // squad shows a chip history does not list

  sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  results = createResultService({ sync });
  const config = { NODE_ENV: 'test', PORT: 4000, MONGODB_URI: t.uri, MONGODB_DB: t.dbName, JWT_SECRET, FPL_API_BASE_URL: 'https://fpl.test/api' };
  const app = createApp({
    config, version: 'test', getDbStatus: async () => ({ ok: true }), log: () => {},
    services: { groups: createGroupService({ sync }), results, ownership: createOwnershipService(), status: createStatusService() },
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // 999 does not exist on FPL: its sync fails, so it is never synced.
  group = await groupRepo.create({ name: 'Chips', slug: 'chips', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [101, 102, 103, 104, 105, 999].map((entryId) => ({ entryId })) });
  clean = await groupRepo.create({ name: 'Clean', slug: 'clean', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [101, 102, 103].map((entryId) => ({ entryId })) });
  other = await groupRepo.create({ name: 'Other', slug: 'other', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [101].map((entryId) => ({ entryId })) });
  const r = await sync.syncGroupGameweek({ groupId: group.id, season: SEASON, event: GW });
  assert.equal(r.status, 'PARTIAL');
  assert.deepEqual(r.failures.map((f) => [f.entryId, f.code]), [[999, 'NOT_FOUND']]);
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
const chipsPath = (g, q = `season=${SEASON}&event=${GW}`) => `/api/groups/${g.id}/chips?${q}`;
const gwState = (c, entryId) => c.gameweek.find((x) => x.entryId === entryId);

test('chips: each documented chip type, active vs declared vs applied, and missing data', async () => {
  const { status, body } = await api(chipsPath(group));
  assert.equal(status, 200, JSON.stringify(body));
  const c = body.chips;
  assert.deepEqual([c.event, c.eventState, c.provisional], [GW, 'DATA_CHECKED', false]);
  assert.equal(c.rules.source, 'FPL_BOOTSTRAP');
  assert.deepEqual([...new Set(c.rules.rules.map((r) => r.label))], ['Triple Captain', 'Bench Boost', 'Free Hit', 'Wildcard'], 'rules ordered by chip name (3xc, bboost, freehit, wildcard)');
  assert.deepEqual(c.gameweek.map((g) => [g.entryId, g.state]), [[101, 'PLAYED'], [102, 'PLAYED'], [103, 'NONE'], [104, 'SOURCE_DISAGREEMENT'], [105, 'ACTIVE_UNCONFIRMED'], [999, 'UNKNOWN']]);
  assert.deepEqual([gwState(c, 101).applied.scoringEffect, gwState(c, 102).applied.scoringEffect, gwState(c, 105).applied.scoringEffect], ['BENCH_BOOST', 'TRIPLE_CAPTAIN', 'NONE']);
  assert.deepEqual([gwState(c, 104).declared, gwState(c, 104).squadChip], ['freehit', null]);
  assert.deepEqual([gwState(c, 999).reason, gwState(c, 999).applied], ['NOT_SYNCED', null], 'an unsynced member is never "no chip"');
  assert.deepEqual(c.missingEntryIds, [999]);
  assert.deepEqual(c.playedThisEvent.map((p) => [p.chipName, p.count, p.entryIds]), [['3xc', 1, [102]], ['bboost', 1, [101]]], 'only confirmed plays are counted (104 disagrees)');
});

test('availability: used and unused chips per window, the window starting at GW2', async () => {
  const c = (await api(chipsPath(group))).body.chips;
  const m = (id) => c.availability.managers.find((x) => x.entryId === id);
  const w = (id, name) => m(id).chips.filter((x) => x.chipName === name).map((x) => [x.window, x.used, x.available, x.current]);
  assert.deepEqual(w(101, 'bboost'), [[[1, 19], 1, false, true], [[20, 38], 0, true, false]]);
  assert.deepEqual(w(103, 'wildcard'), [[[2, 19], 1, false, true], [[20, 38], 0, true, false]]);
  assert.deepEqual(w(103, 'freehit'), [[[2, 19], 0, true, true], [[20, 38], 0, true, false]], 'unused');
  assert.ok(!c.availability.managers.some((x) => x.entryId === 999));
});

test('an earlier GW reads its own chip state; a GW without rows is UNKNOWN, not "no chip"', async () => {
  const gw2 = (await api(chipsPath(group, `season=${SEASON}&event=2`))).body.chips;
  assert.deepEqual([gwState(gw2, 103).state, gwState(gw2, 103).declared], ['PLAYED', 'wildcard']);
  assert.equal(gwState(gw2, 101).state, 'NONE');
  const gw9 = (await api(chipsPath(group, `season=${SEASON}&event=9`))).body.chips;
  assert.deepEqual([gw9.provisional, gwState(gw9, 101).state, gwState(gw9, 101).reason], [true, 'UNKNOWN', 'NO_GW_ROW']);
  const current = (await api(chipsPath(group, `season=${SEASON}`))).body.chips;
  assert.equal(current.event, GW, 'defaults to the current GW');
});

test('provenance, repeat sync determinism, and reproduction from persisted inputs', async () => {
  const a = (await api(chipsPath(group))).body.chips;
  assert.ok(a.sources.length >= 1);
  const runIds = new Set(a.sources.map((s) => s.syncRunId));
  const chipRulesRun = String((await raw('seasons').findOne({ _id: SEASON })).chipRules.provenance.lastConfirmedByRunId);
  assert.ok(runIds.has(chipRulesRun), 'the chip rules\' confirming run is cited');
  await sync.syncGroupGameweek({ groupId: group.id, season: SEASON, event: GW });
  const b = (await api(chipsPath(group))).body.chips;
  const strip = ({ sources: _s, ...rest }) => rest;
  assert.deepEqual(strip(b), strip(a), 'a repeat sync of identical FPL data changes nothing');
  const rebuilt = JSON.parse(JSON.stringify(buildChipView(chipInputs(await ownershipRepo.loadChips(group.id, SEASON, GW), GW))));
  const { groupId: _g, season: _s, sources: _src, ...served } = b;
  assert.deepEqual(rebuilt, served);
});

test('status page: runs, semantics verbatim, chip rules, storage gauge, smoke verdicts; run drill-down', async () => {
  const { status, body } = await api(`/api/status?season=${SEASON}`);
  assert.equal(status, 200, JSON.stringify(body));
  const s = body.status;
  assert.equal(s.semantics.value, 'GROSS_BEFORE_HITS', 'entry 102\'s GW3 hit proved it; shown as stored');
  assert.deepEqual([s.chipRules.source, s.chipRules.rules], ['FPL_BOOTSTRAP', 8]);
  assert.ok(s.storage.usedBytes > 0 && s.storage.quotaBytes === 512 * 1024 * 1024 && typeof s.storage.warning === 'boolean');
  assert.ok(s.runs.length >= 2);
  assert.ok(s.runs.every((r, i) => i === 0 || new Date(s.runs[i - 1].startedAt) >= new Date(r.startedAt)), 'newest first');
  assert.equal(s.smoke.available, true);
  assert.ok(s.smoke.checks.length >= 30);
  const partial = s.runs.find((r) => r.status === 'PARTIAL');
  const run = (await api(`/api/status/runs/${partial.id}`)).body.run;
  assert.equal(run.requests.length, partial.requests);
  assert.deepEqual(run.failures.map((f) => f.entryId), [999]);
  assert.equal((await api(`/api/status/runs/${'f'.repeat(24)}`)).status, 404);
  const empty = (await api('/api/status?season=2030-31')).body.status;
  assert.deepEqual([empty.semantics, empty.chipRules, empty.smoke.available], [null, null, false]);
});

test('events: gameweek states and live state of the current GW', async () => {
  const ev = (await api(`/api/seasons/${SEASON}/events`)).body;
  assert.equal(ev.currentEvent, GW);
  assert.equal(ev.events.length, 38);
  assert.deepEqual(ev.events.slice(0, 6).map((e) => e.state), ['DATA_CHECKED', 'DATA_CHECKED', 'DATA_CHECKED', 'DATA_CHECKED', 'DATA_CHECKED', 'LIVE']);
  assert.ok(ev.events[4].dataCheckedObservedAt);
  assert.equal(ev.events[5].dataCheckedObservedAt, null);
  assert.deepEqual([ev.live.gw, ev.live.elements, ev.live.settled], [GW, 30, 30]);
});

test('chips / status reads never touch a finalized result', async () => {
  await sync.syncGroupGameweek({ groupId: clean.id, season: SEASON, event: GW });
  const fin = await results.finalize(clean.id, SEASON, GW);
  assert.equal(fin.pointer.status, 'FINAL');
  const dump = async () => {
    const out = {};
    for (const c of ['resultSnapshots', 'gwResultActions', 'gwResults', 'seasons', 'managerSeasons', 'managerGameweeks', 'syncRuns', 'locks']) out[c] = JSON.stringify(await raw(c).find().sort({ _id: 1 }).toArray());
    return out;
  };
  const before = await dump();
  await api(chipsPath(clean));
  await api(`/api/status?season=${SEASON}`);
  await api(`/api/seasons/${SEASON}/events`);
  assert.deepEqual(await dump(), before);
  assert.deepEqual(await results.verifyChain(clean.id, SEASON, GW), { valid: true });
  assert.equal((await raw('resultSnapshots').findOne({ _id: new mongoose.Types.ObjectId(fin.snapshot.id) })).contentHash, fin.snapshot.contentHash);
});

test('authorization: chips for admin / own-group viewer; status admin-only; events signed-in', async () => {
  const share = (await fetch(`${base}/api/groups/${group.id}/share-token`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } }).then((r) => r.json())).shareToken;
  assert.equal((await api(chipsPath(group), { token: null })).status, 401);
  assert.equal((await api(chipsPath(group), { share })).status, 200);
  assert.equal((await api(chipsPath(other), { share })).status, 404);
  assert.equal((await api(`/api/status?season=${SEASON}`, { token: null })).status, 401);
  assert.equal((await api(`/api/status?season=${SEASON}`, { share })).status, 403);
  assert.equal((await api(`/api/status/runs/${'a'.repeat(24)}`, { share })).status, 403);
  assert.equal((await api(`/api/seasons/${SEASON}/events`, { token: null })).status, 401);
  assert.equal((await api(`/api/seasons/${SEASON}/events`, { share })).status, 200);
  assert.equal((await api(chipsPath(group, `season=${SEASON}&event=39`))).status, 400);
  assert.equal((await api(`/api/groups/${group.id}/chips`)).status, 400, 'season required');
  assert.equal((await api(`/api/status`)).status, 400);
  assert.equal((await api('/api/seasons/2026/events')).status, 404);
});
