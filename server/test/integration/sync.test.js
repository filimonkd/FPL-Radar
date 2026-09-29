import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { gunzipSync } from 'node:zlib';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { canonicalJson, sha256Bytes } from '../../src/utils/canonical.js';
import { tryAcquireLease } from '../../src/locks/leaseLock.js';
import { lockKeys } from '../../src/locks/lockKeys.js';
import { LockBusyError } from '../../src/locks/errors.js';
import { lockRepo } from '../../src/repositories/lockRepo.js';
import { groupRepo, seasonRepo, syncRunRepo, resultRepo, managerGameweekRepo } from '../../src/repositories/index.js';
import { computeGwResult, canFinalize } from '../../src/analytics/index.js';
import { createSyncService, GroupArchivedError } from '../../src/sync/index.js';
import { createWorld, worldClient, tickingClock, LEAGUE, GW, historyCurrent } from '../helpers/fplWorld.js';
import { decide, snapshotFrom } from '../helpers/repoFixtures.js';

// Step 7 sync (architecture v0.2 §15, v0.3 §5–§9) against a synthetic FPL API
// served through the real client, on the replica-set test database.

const SEASON = '2026-27';
let t;
let world;
let clock;
let sync;
let group;
const runs = [];

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  world = createWorld();
  clock = tickingClock();
  sync = createSyncService({ client: worldClient(world), clock, heartbeatMs: 60_000 });
  group = await groupRepo.create({ name: 'League group', slug: 'league-group', memberSource: 'LEAGUE_STANDINGS', fplLeagueId: LEAGUE, winnerRule: 'NET_POINTS', members: [] });
});
after(async () => { await t.stop(); });

const raw = (coll) => t.db.collection(coll);
const oid = (id) => new mongoose.Types.ObjectId(id);
const syncGroup = (over = {}) => sync.syncGroupGameweek({ groupId: group.id, season: SEASON, event: GW, ...over });
const SNAPSHOT_COLLECTIONS = ['seasons', 'events', 'players', 'managers', 'managerSeasons', 'managerGameweeks', 'liveGameweeks', 'groups'];

// Everything except confirmation stamps and the recomputed settled flag (Step 6 documented behaviour).
function strip(doc) {
  const scrub = (p) => {
    if (!p) return p;
    const { lastConfirmedByRunId, lastConfirmedAt, settled, ...rest } = p;
    return rest;
  };
  const out = { ...doc, provenance: scrub(doc.provenance) };
  if (doc.chipRules) out.chipRules = { ...doc.chipRules, provenance: scrub(doc.chipRules.provenance) };
  if (!doc.provenance) delete out.provenance;
  return canonicalJson(JSON.parse(JSON.stringify(out)));
}
async function dump() {
  const out = {};
  for (const c of SNAPSHOT_COLLECTIONS) out[c] = (await raw(c).find().sort({ _id: 1 }).toArray()).map(strip);
  return out;
}

test('a first group sync writes every collection and ends SUCCESS', async () => {
  const r = await syncGroup();
  runs.push(r);
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.failures));
  const run = await syncRunRepo.get(r.runId);
  assert.equal(run.status, 'SUCCESS');
  assert.equal(run.lockId, lockKeys.group(group.id));
  assert.ok(run.finishedAt instanceof Date);
  // bootstrap + fixtures + 2 standings pages + 3 × (entry, history, picks, transfers) + live
  // + the one-time Step 17 history backfill of finished GW1–4.
  assert.equal(run.requests.length, 21);
  assert.deepEqual(run.requests.filter((q) => /^\/event\/\d+\/live\/$/.test(q.path)).map((q) => q.path).sort(), ['/event/1/live/', '/event/2/live/', '/event/3/live/', '/event/4/live/', '/event/5/live/']);
  assert.deepEqual(r.stats.history, { missing: 4, filled: 4 });
  for (const q of run.requests) {
    assert.match(q.bodySha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(q.schemaOk, true);
    assert.equal(q.rawResponseId, null, 'a MANUAL-trigger run stores no bodies');
  }

  const g = await groupRepo.getById(group.id);
  assert.deepEqual(g.members.map((m) => [m.entryId, m.leftLeague]), [[101, false], [102, false], [103, false]]);
  assert.equal(await raw('events').countDocuments({ season: SEASON }), 38);
  assert.equal(await raw('players').countDocuments({ season: SEASON }), 30);
  assert.equal(await raw('managerGameweeks').countDocuments({ season: SEASON }), 15);
  assert.equal((await raw('managers').findOne({ _id: 101 })).playerName, 'Manager 101', 'profile from /entry/ in T3');
  const season = await seasonRepo.get(SEASON);
  assert.deepEqual(season.unscheduledFixtures.map((f) => f.id), [99]);
  assert.equal(season.chipRules.source, 'FPL_BOOTSTRAP');

  // DATA_CHECKED first observed during this run, so its rows are not settled yet.
  const e5 = await raw('events').findOne({ _id: `${SEASON}:${GW}` });
  assert.equal(e5.state, 'DATA_CHECKED');
  assert.ok(e5.dataCheckedObservedAt > run.startedAt);
  assert.equal((await raw('managerGameweeks').findOne({ _id: `${SEASON}:101:5` })).provenance.settled, false);
  assert.equal((await raw('events').findOne({ _id: `${SEASON}:6` })).dataCheckedObservedAt, null);

  // Entry 102's GW3 hit proves GROSS_BEFORE_HITS.
  assert.deepEqual(season.pointsSemantics, { value: 'GROSS_BEFORE_HITS', evidenceRows: 1, conflictRows: 0, firstVerifiedRunId: r.runId });
  const hit = await managerGameweekRepo.listForEntry(SEASON, 102);
  assert.deepEqual([hit[2].points.reconciliationStatus, hit[2].points.netGwPoints, hit[2].points.grossGwPoints], ['RECONCILED', 66, 70]);
  // Freshness timestamps: the row was confirmed and changed by this run, at write time.
  const p = (await managerGameweekRepo.listForEntry(SEASON, 101, { withProvenance: true }))[4].provenance;
  assert.equal(p.lastConfirmedByRunId, r.runId);
  assert.equal(p.lastChangedByRunId, r.runId);
  assert.ok(p.lastConfirmedAt > run.startedAt && p.lastConfirmedAt < run.finishedAt);
});

test('repeated identical syncs are idempotent and never double-count semantics evidence', async () => {
  // Run 2 reconciles against the season now verified GROSS: the unchanged engine relabels
  // the C = 0 rows' pointsSemantics (UNVERIFIED → GROSS_BEFORE_HITS). Those rows change,
  // but their points inputs did not, so they add no evidence.
  const r2 = await syncGroup();
  runs.push(r2);
  assert.equal(r2.status, 'SUCCESS');
  assert.deepEqual(r2.stats.members.rows, { inserted: 0, changed: 14, unchanged: 1 });
  assert.deepEqual(r2.stats.evidence, { gross: 0, net: 0 });
  const relabelled = await raw('managerGameweeks').find({ 'provenance.lastChangedByRunId': oid(r2.runId) }).toArray();
  assert.ok(relabelled.every((d) => d.points.transferCost === 0 && d.points.pointsSemantics === 'GROSS_BEFORE_HITS'));
  const before = await dump();
  const r3 = await syncGroup();
  runs.push(r3);
  assert.equal(r3.status, 'SUCCESS');
  assert.deepEqual(r3.stats.members.rows, { inserted: 0, changed: 0, unchanged: 15 });
  assert.deepEqual(r3.stats.evidence, { gross: 0, net: 0 });
  assert.deepEqual(await dump(), before, 'a replay changes nothing but confirmation stamps');
  assert.deepEqual((await seasonRepo.get(SEASON)).pointsSemantics, { value: 'GROSS_BEFORE_HITS', evidenceRows: 1, conflictRows: 0, firstVerifiedRunId: runs[0].runId });
  for (const c of ['managerGameweeks', 'managers', 'events', 'players']) {
    assert.equal(await raw(c).countDocuments({ 'provenance.lastConfirmedByRunId': oid(r3.runId) }), await raw(c).countDocuments(), `${c} confirmed by the latest run`);
    assert.equal(await raw(c).countDocuments({ 'provenance.lastChangedByRunId': oid(r3.runId) }), 0, `${c} not changed by a replay`);
  }
  // Live data: the synced GW is re-confirmed; finished, complete GWs are not re-fetched (Step 17).
  assert.deepEqual(r3.stats.history, { missing: 0, filled: 0 });
  assert.equal(await raw('liveGameweeks').countDocuments({ 'provenance.lastConfirmedByRunId': oid(r3.runId) }), 1);
  assert.equal(await raw('liveGameweeks').countDocuments({ 'provenance.lastChangedByRunId': oid(r3.runId) }), 0);
  assert.equal(await raw('liveGameweeks').countDocuments(), 5);
  // Rows confirmed after DATA_CHECKED was observed are now settled.
  assert.equal((await raw('managerGameweeks').findOne({ _id: `${SEASON}:101:5` })).provenance.settled, true);
});

let finalized;
test('finalized results are never overwritten; a changed settled row is reported, not hidden', async () => {
  // Finalize GW5 from the synced data (T4 through the repositories; the service is Step 9).
  const inputs = await resultRepo.loadResultInputs(group.id, SEASON, GW);
  const eligibleRows = inputs.gwRows.map((row) => ({ entryId: row.entryId, reconciliationStatus: row.reconciliationStatus, ...inputs.freshness.find((f) => f.entryId === row.entryId) }));
  assert.deepEqual(canFinalize({ ...inputs.gate, eventState: inputs.eventState, eligibleRows }), { allowed: true, reasons: [] });
  const result = computeGwResult(inputs);
  const lease = await tryAcquireLease(lockKeys.group(group.id));
  finalized = await decide({ lease, groupId: group.id, action: 'FINALIZE', snapshot: snapshotFrom(group.id, result, inputs, { computedAt: clock(), group: inputs.group }), at: clock() });
  await lease.release();
  const snapBefore = await raw('resultSnapshots').findOne({ _id: oid(finalized.snapshot.id) });

  // FPL corrects entry 101's GW5 (bonus change): +2 points.
  world.state.entries[101].rows[4].points += 2;
  const r = await syncGroup();
  runs.push(r);
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(r.stats.members.rows, { inserted: 0, changed: 1, unchanged: 14 });
  const changed = await raw('managerGameweeks').find({ 'provenance.lastChangedByRunId': oid(r.runId) }).toArray();
  assert.deepEqual(changed.map((d) => d._id), [`${SEASON}:101:5`], 'only the corrected row changed');
  assert.ok(r.warnings.some((w) => w.code === 'SETTLED_ROW_CHANGED' && w.detail.id === `${SEASON}:101:5`));
  assert.deepEqual(await raw('resultSnapshots').findOne({ _id: oid(finalized.snapshot.id) }), snapBefore, 'snapshot untouched');
  assert.equal((await resultRepo.getPointer(group.id, SEASON, GW)).currentSnapshotId, finalized.snapshot.id);
  assert.deepEqual(await resultRepo.verifyChain(group.id, SEASON, GW), { valid: true });
  assert.equal((await raw('syncRuns').findOne({ _id: oid(runs[2].runId) })).expireAt, undefined, 'the finalized sources stay retained');
});

test('a row changed without new points evidence does not add semantics evidence', async () => {
  world.state.entries[102].rows[2].bench = 7; // points_on_bench on the hit row
  const r = await syncGroup();
  runs.push(r);
  assert.equal(r.stats.members.rows.changed, 1);
  assert.deepEqual(r.stats.evidence, { gross: 0, net: 0 });
  assert.equal((await seasonRepo.get(SEASON)).pointsSemantics.evidenceRows, 1);
});

test('conflicting evidence makes the season CONFLICTED once, and replays keep it that way', async () => {
  // Entry 103 takes a hit in GW4 whose Δ equals R (NET_AFTER_HITS) against a GROSS season.
  world.state.entries[103].rows[3] = { event: 4, points: 64, cost: 4, net: true };
  const r = await syncGroup();
  runs.push(r);
  assert.deepEqual(r.stats.evidence, { gross: 0, net: 1 });
  assert.deepEqual((await seasonRepo.get(SEASON)).pointsSemantics, { value: 'CONFLICTED', evidenceRows: 1, conflictRows: 1, firstVerifiedRunId: runs[0].runId });
  const row = (await managerGameweekRepo.listForEntry(SEASON, 103))[3];
  assert.deepEqual([row.points.reconciliationStatus, row.points.netGwPoints], ['SEMANTICS_CONFLICT', null]);

  const again = await syncGroup();
  runs.push(again);
  assert.deepEqual(again.stats.evidence, { gross: 0, net: 0 }, 'no double counting');
  assert.deepEqual((await seasonRepo.get(SEASON)).pointsSemantics, { value: 'CONFLICTED', evidenceRows: 1, conflictRows: 1, firstVerifiedRunId: runs[0].runId });
  // Under a CONFLICTED season every hit row is SEMANTICS_CONFLICT; C = 0 rows stay valid (v0.2 §2).
  const rows102 = await managerGameweekRepo.listForEntry(SEASON, 102);
  assert.equal(rows102[2].points.reconciliationStatus, 'SEMANTICS_CONFLICT');
  assert.equal(rows102[0].points.reconciliationStatus, 'RECONCILED_NO_COST');
  world.state.entries[103].rows[3] = { event: 4, points: 64, cost: 0 };
});

test('a season without hits stays UNVERIFIED', async () => {
  const w2 = createWorld({ seasonStartYear: 2027, entries: [201, 202] });
  const s2 = createSyncService({ client: worldClient(w2), clock: tickingClock(new Date('2027-09-22T19:00:00Z')) });
  const g2 = await groupRepo.create({ name: 'Manual', slug: 'manual-2027', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 201 }, { entryId: 202 }] });
  const r = await s2.syncGroupGameweek({ groupId: g2.id, season: '2027-28', event: GW });
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual((await seasonRepo.get('2027-28')).pointsSemantics, { value: 'UNVERIFIED', evidenceRows: 0, conflictRows: 0, firstVerifiedRunId: null });
  const rows = await managerGameweekRepo.listForEntry('2027-28', 201);
  assert.ok(rows.every((x) => x.points.pointsSemantics === 'UNVERIFIED' && x.points.reconciliationStatus === 'RECONCILED_NO_COST'));
  assert.ok(!w2.calls.some((p) => p.startsWith('/leagues-classic/')), 'MANUAL groups use the stored member list');
});

test('history backfill: never on FINALIZE runs; an FPL failure is a warning, not a failed sync', async () => {
  const w = createWorld({ seasonStartYear: 2029, entries: [401, 402] });
  const s = createSyncService({ client: worldClient(w), clock: tickingClock(new Date('2029-09-22T19:00:00Z')) });
  const g = await groupRepo.create({ name: 'History', slug: 'history-2029', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 401 }, { entryId: 402 }] });
  const fin = await s.syncGroupGameweek({ groupId: g.id, season: '2029-30', event: GW, trigger: 'FINALIZE' });
  assert.equal(fin.status, 'SUCCESS');
  assert.equal(fin.stats.history, undefined, 'no backfill stage on a FINALIZE run');
  assert.ok(!w.calls.some((p) => /^\/event\/[1-4]\/live\/$/.test(p)), 'no earlier GW fetched (its body would be kept as evidence)');

  w.state.history = false; // FPL answers 404 for earlier GWs
  const man = await s.syncGroupGameweek({ groupId: g.id, season: '2029-30', event: GW });
  assert.equal(man.status, 'SUCCESS', 'results do not depend on history');
  assert.deepEqual(man.failures, []);
  assert.deepEqual(man.warnings.filter((x) => x.code === 'HISTORY_BACKFILL_INCOMPLETE').map((x) => [x.detail.gw, x.detail.failure]), [[1, 'NOT_FOUND']], 'stops at the first failure');
  assert.deepEqual(man.stats.history, { missing: 4, filled: 0 });

  w.state.history = true;
  const again = await s.syncGroupGameweek({ groupId: g.id, season: '2029-30', event: GW });
  assert.deepEqual(again.stats.history, { missing: 4, filled: 4 }, 'filled on the next sync');
  const gws = (await t.db.collection('liveGameweeks').find({ season: '2029-30' }).toArray()).map((d) => d.gw).sort();
  assert.deepEqual(gws, [1, 2, 3, 4, 5]);
});

test('negative bench points from FPL are stored as reported, not rejected', async () => {
  // Real FPL data: a benched player's card or own goal makes points_on_bench -1.
  const w = createWorld({ seasonStartYear: 2028, entries: [301, 302] });
  w.state.entries[301].rows = w.state.entries[301].rows.map((r) => (r.event === GW ? { ...r, bench: -1 } : r));
  w.state.entries[301].rows[1] = { ...w.state.entries[301].rows[1], bench: -3 };
  const s = createSyncService({ client: worldClient(w), clock: tickingClock(new Date('2028-09-22T19:00:00Z')) });
  const g = await groupRepo.create({ name: 'Bench', slug: 'bench-2028', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 301 }, { entryId: 302 }] });
  const r = await s.syncGroupGameweek({ groupId: g.id, season: '2028-29', event: GW });
  assert.equal(r.status, 'SUCCESS', JSON.stringify(r.failures));
  const rows = await managerGameweekRepo.listForEntry('2028-29', 301);
  assert.deepEqual(rows.map((x) => [x.event, x.pointsOnBench]), [[1, 0], [2, -3], [3, 0], [4, 0], [5, -1]]);
});

test('a partial member failure isolates that member and records the run accurately', async () => {
  const prevRun = runs.at(-1).runId;
  world.overrides.set('/entry/102/history/', new Response('{"detail":"oops"}', { status: 500 }));
  world.overrides.set(`/entry/103/event/${GW}/picks/`, new Response('Host not in allowlist', { status: 403, headers: { 'x-deny-reason': 'host_not_allowed' } }));
  try {
    const r = await syncGroup();
    runs.push(r);
    assert.equal(r.status, 'PARTIAL');
    const run = await syncRunRepo.get(r.runId);
    assert.equal(run.status, 'PARTIAL');
    assert.deepEqual(run.failures.map((f) => [f.entryId, f.code]), [[102, 'UPSTREAM_UNAVAILABLE'], [103, 'BLOCKED']]);
    assert.ok(run.requests.some((q) => q.path === '/entry/102/history/' && q.httpStatus === 500 && q.schemaOk === null));
    // Failed members keep their previous confirmations; entry 101 is confirmed by this run.
    const inputs = await resultRepo.loadResultInputs(group.id, SEASON, GW);
    assert.deepEqual(inputs.freshness.map((f) => [f.entryId, f.syncRunId]), [[101, r.runId], [102, prevRun], [103, prevRun]]);
    assert.equal(await raw('managerGameweeks').countDocuments({ entryId: { $in: [102, 103] }, 'provenance.lastConfirmedByRunId': oid(r.runId) }), 0);
  } finally {
    world.overrides.clear();
  }
});

test('league standings needing auth freeze the members and mark the run PARTIAL', async () => {
  world.overrides.set(`/leagues-classic/${LEAGUE}/standings/?page_standings=1`, new Response('{"detail":"Authentication credentials were not provided."}', { status: 403, headers: { 'content-type': 'application/json' } }));
  const before = await groupRepo.getById(group.id);
  try {
    const r = await syncGroup();
    runs.push(r);
    assert.equal(r.status, 'PARTIAL');
    assert.ok(r.warnings.some((w) => w.code === 'LEAGUE_AUTH_REQUIRED'));
    assert.deepEqual(r.failures, []);
    assert.deepEqual(await groupRepo.getById(group.id), before, 'members frozen, group untouched');
  } finally {
    world.overrides.clear();
  }
});

test('league members that leave are kept and marked leftLeague, never removed', async () => {
  world.state.standings = [101, 103];
  try {
    const r = await syncGroup();
    runs.push(r);
    assert.equal(r.status, 'SUCCESS');
    assert.deepEqual((await groupRepo.getById(group.id)).members.map((m) => [m.entryId, m.leftLeague]), [[101, false], [102, true], [103, false]]);
  } finally {
    world.state.standings = [101, 102, 103];
  }
  await syncGroup().then((r) => runs.push(r));
  assert.deepEqual((await groupRepo.getById(group.id)).members.map((m) => [m.entryId, m.leftLeague]), [[101, false], [102, false], [103, false]]);
});

test('a bootstrap failure fails the run before any member is fetched', async () => {
  world.overrides.set('/bootstrap-static/', new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }));
  const callsBefore = world.calls.length;
  try {
    const r = await syncGroup();
    assert.equal(r.status, 'FAILED');
    assert.deepEqual(r.failures.map((f) => f.code), ['BLOCKED']);
    assert.match(r.failures[0].message, /^bootstrap: /);
    assert.deepEqual(world.calls.slice(callsBefore), ['/bootstrap-static/']);
    assert.equal((await syncRunRepo.get(r.runId)).status, 'FAILED');
  } finally {
    world.overrides.clear();
  }
});

test('FINALIZE runs store evidence bodies and link them through the request log', async () => {
  const r = await syncGroup({ trigger: 'FINALIZE' });
  runs.push(r);
  assert.equal(r.status, 'SUCCESS');
  const run = await syncRunRepo.get(r.runId);
  const stored = run.requests.filter((q) => q.rawResponseId);
  const storedPaths = stored.map((q) => q.path).sort();
  assert.deepEqual(storedPaths, [
    '/entry/101/event/5/picks/', '/entry/101/history/', '/entry/101/transfers/',
    '/entry/102/event/5/picks/', '/entry/102/history/', '/entry/102/transfers/',
    '/entry/103/event/5/picks/', '/entry/103/history/', '/entry/103/transfers/',
    `/event/${GW}/live/`,
  ]);
  for (const q of stored) {
    const doc = await raw('fplRawResponses').findOne({ _id: oid(q.rawResponseId) });
    assert.equal(doc.reason, 'FINAL_EVIDENCE');
    assert.equal(String(doc.syncRunId), r.runId);
    assert.equal(doc.bodySha256, q.bodySha256);
    assert.equal(sha256Bytes(gunzipSync(doc.bodyGzip.buffer)), q.bodySha256, 'stored bytes hash to the logged hash');
    assert.ok(doc.expireAt instanceof Date, 'expiring until a snapshot references it');
  }
  assert.ok(!run.requests.find((q) => q.path === '/bootstrap-static/').rawResponseId, 'bootstrap is never stored');
  // Documents point at the exact request hashes of the run that confirmed them.
  const row = await raw('managerGameweeks').findOne({ _id: `${SEASON}:101:5` });
  assert.equal(String(row.provenance.lastConfirmedByRunId), r.runId);
  assert.equal(row.provenance.sourceRequests.history, run.requests.find((q) => q.path === '/entry/101/history/').bodySha256);
  assert.equal(row.provenance.sourceRequests.picks, run.requests.find((q) => q.path === '/entry/101/event/5/picks/').bodySha256);
  const inputs = await resultRepo.loadResultInputs(group.id, SEASON, GW);
  const src = inputs.sources.find((s) => s.syncRunId === r.runId);
  for (const h of src.requestHashes) assert.ok(run.requests.some((q) => q.bodySha256 === h), 'every source hash is in the run log');
});

test('responses that fail validation are captured as SCHEMA_FAIL and fail only that member', async () => {
  const bad = structuredClone(world.state.entries[103].picks);
  bad[1].is_captain = true; // two captains: passes zod, fails the picks rules
  world.overrides.set(`/entry/103/event/${GW}/picks/`, () => new Response(JSON.stringify({ active_chip: null, automatic_subs: [], entry_history: { event: GW, points: 61, total_points: 1, event_transfers: 1, event_transfers_cost: 0, points_on_bench: 0 }, picks: bad }), { status: 200, headers: { 'content-type': 'application/json' } }));
  world.overrides.set('/entry/102/history/', () => new Response(JSON.stringify({ current: [{ event: 1 }], past: [], chips: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const r = await syncGroup();
    runs.push(r);
    assert.equal(r.status, 'PARTIAL');
    assert.deepEqual(r.failures.map((f) => [f.entryId, f.code]), [[102, 'SCHEMA_FAIL'], [103, 'SCHEMA_FAIL']]);
    const captured = await raw('fplRawResponses').find({ syncRunId: oid(r.runId), reason: 'SCHEMA_FAIL' }).sort({ path: 1 }).toArray();
    assert.deepEqual(captured.map((d) => d.path), ['/entry/102/history/', `/entry/103/event/${GW}/picks/`]);
    const run = await syncRunRepo.get(r.runId);
    assert.equal(run.requests.find((q) => q.path === '/entry/102/history/').schemaOk, false);
  } finally {
    world.overrides.clear();
  }
});

test('a transient upstream error is retried by the client and logged once', async () => {
  let n = 0;
  world.overrides.set('/entry/101/transfers/', () => (n++ === 0 ? new Response('busy', { status: 503 }) : undefined));
  try {
    const r = await syncGroup();
    runs.push(r);
    assert.equal(r.status, 'SUCCESS');
    const run = await syncRunRepo.get(r.runId);
    assert.equal(run.requests.filter((q) => q.path === '/entry/101/transfers/').length, 1);
    assert.equal(n, 2);
  } finally {
    world.overrides.clear();
  }
});

test('concurrent syncs of one group are serialized by the group lease', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  world.overrides.set('/bootstrap-static/', async () => { await gate; return undefined; });
  const runsBefore = await raw('syncRuns').countDocuments();
  const first = syncGroup();
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(syncGroup(), (err) => err instanceof LockBusyError && err.code === 'SYNC_IN_PROGRESS');
  release();
  world.overrides.clear();
  const r = await first;
  runs.push(r);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(await raw('syncRuns').countDocuments(), runsBefore + 1, 'the refused sync inserted no run');
  const next = await syncGroup(); // free again once the first released
  runs.push(next);
  assert.equal(next.status, 'SUCCESS');
});

test('a stale lease holder cannot commit, and its run ends ABANDONED', async () => {
  const lockId = lockKeys.group(group.id);
  let takeover = null;
  world.overrides.set('/entry/102/history/', async () => {
    // Another instance takes the lease over mid-run (as after an expiry) and abandons the old run.
    const held = await lockRepo.get(lockId);
    await lockRepo.release(lockId, held.owner);
    takeover = await tryAcquireLease(lockId, { ttlMs: 60_000 });
    await syncRunRepo.markAbandoned(lockId, takeover.fencingToken);
    return undefined;
  });
  try {
    const r = await syncGroup();
    assert.equal(r.status, 'ABANDONED');
    assert.equal((await syncRunRepo.get(r.runId)).status, 'ABANDONED');
    for (const c of ['managerGameweeks', 'managerSeasons', 'managers', 'liveGameweeks']) {
      assert.equal(await raw(c).countDocuments({ 'provenance.lastConfirmedByRunId': oid(r.runId) }), 0, `${c}: nothing committed after the takeover`);
    }
    assert.equal((await lockRepo.get(lockId)).owner.toString(), String(takeover.owner), 'the stale holder did not release the new lease');
  } finally {
    world.overrides.clear();
    await takeover?.release();
  }
});

test('a crashed run is marked ABANDONED by the next acquirer', async () => {
  const lockId = lockKeys.group(group.id);
  const crashed = await tryAcquireLease(lockId, { ttlMs: 200 });
  await syncRunRepo.insert({ id: String(crashed.owner), job: 'group-gw', target: group.id, season: SEASON, event: GW, trigger: 'MANUAL', lockId, lockFencingToken: crashed.fencingToken, startedAt: clock() });
  await assert.rejects(syncGroup(), LockBusyError, 'still held until it expires');
  await new Promise((r) => setTimeout(r, 400)); // the crashed holder never heartbeats
  const r = await syncGroup();
  runs.push(r);
  assert.equal(r.status, 'SUCCESS');
  assert.ok(r.warnings.some((w) => w.code === 'RUNS_ABANDONED' && w.detail.count === 1));
  const dead = await syncRunRepo.get(String(crashed.owner));
  assert.equal(dead.status, 'ABANDONED');
  assert.ok(dead.finishedAt instanceof Date);
});

test('an archived group is not synced and gets no run', async () => {
  const g = await groupRepo.create({ name: 'Old', slug: 'old-group', memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: [{ entryId: 101 }] });
  await groupRepo.archive(g.id);
  const before = await raw('syncRuns').countDocuments();
  await assert.rejects(sync.syncGroupGameweek({ groupId: g.id, season: SEASON, event: GW }), GroupArchivedError);
  assert.equal(await raw('syncRuns').countDocuments(), before);
});

test('a season mismatch fails the run without writing', async () => {
  const r = await syncGroup({ season: '2025-26' });
  assert.equal(r.status, 'FAILED');
  assert.deepEqual(r.failures.map((f) => f.code), ['SEASON_MISMATCH']);
  assert.equal(await raw('events').countDocuments({ season: '2025-26' }), 0);
});

test('the bootstrap job runs under its own lease and is idempotent', async () => {
  const a = await sync.syncBootstrap({ season: SEASON });
  assert.equal(a.status, 'SUCCESS');
  assert.deepEqual(a.stats.bootstrap.events, { inserted: 0, changed: 0, unchanged: 38 });
  const run = await syncRunRepo.get(a.runId);
  assert.equal(run.lockId, 'sync:bootstrap');
  assert.equal(run.target, 'bootstrap');
  assert.deepEqual(run.requests.map((q) => q.path), ['/bootstrap-static/', '/fixtures/']);
});

test('invalid chip rules keep the previous valid set (v0.2 §8)', async () => {
  const before = await seasonRepo.get(SEASON, { withProvenance: true });
  world.state.chips = [{ id: 1, name: 'wildcard', number: 1, start_event: 10, stop_event: 5, chip_type: 'transfer' }];
  try {
    const r = await sync.syncBootstrap({ season: SEASON });
    assert.equal(r.status, 'SUCCESS');
    assert.ok(r.warnings.some((w) => w.code === 'CHIP_RULES_INVALID'));
    const after = await seasonRepo.get(SEASON, { withProvenance: true });
    assert.deepEqual(after.chipRules.rules, before.chipRules.rules);
    assert.equal(after.chipRules.provenance.lastChangedByRunId, before.chipRules.provenance.lastChangedByRunId);
    assert.deepEqual(after.chipRules.provenance.sourceRequests, before.chipRules.provenance.sourceRequests);
  } finally {
    world.state.chips = createWorld().state.chips;
  }
});

test('the history helper produces the hypotheses the tests rely on', () => {
  const [a, b] = historyCurrent([{ event: 1, points: 50 }, { event: 2, points: 70, cost: 4 }]);
  assert.equal(b.total_points - a.total_points, 66);
});
