import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/app.js';
import { createSyncService } from '../../src/sync/index.js';
import { createGroupService } from '../../src/services/groupService.js';
import { createResultService } from '../../src/services/resultService.js';
import { signAdminToken } from '../../src/auth/tokens.js';
import { tryAcquireLease } from '../../src/locks/leaseLock.js';
import { lockKeys } from '../../src/locks/lockKeys.js';
import { LockLostError } from '../../src/locks/errors.js';
import { lockRepo } from '../../src/repositories/lockRepo.js';
import { groupRepo, resultRepo, syncRunRepo } from '../../src/repositories/index.js';
import { createWorld, worldClient, tickingClock, GW } from '../helpers/fplWorld.js';

// Step 9: finalize / result API end to end (v0.2 §3–§4, §15; v0.3 §5, §7–§9),
// on the replica-set test database with a synthetic FPL API.

const SEASON = '2026-27';
const JWT_SECRET = 'r'.repeat(48);
let t;
let server;
let base;
let world;
let sync;
let results;
const admin = signAdminToken(JWT_SECRET);

before(async () => {
  t = await startTestDb();
  await runMigrations(t.db);
  world = createWorld();
  sync = createSyncService({ client: worldClient(world), clock: tickingClock(), heartbeatMs: 60_000 });
  results = createResultService({ sync });
  const config = { NODE_ENV: 'test', PORT: 4000, MONGODB_URI: t.uri, MONGODB_DB: t.dbName, JWT_SECRET, FPL_API_BASE_URL: 'https://fpl.test/api' };
  const app = createApp({ config, version: 'test', getDbStatus: async () => ({ ok: true }), services: { groups: createGroupService({ sync }), results }, log: () => {} });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await t.stop();
});

const raw = (coll) => t.db.collection(coll);
const oid = (id) => new mongoose.Types.ObjectId(id);

async function api(method, path, { body, token = admin, share } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (share) { headers['x-share-token'] = share; delete headers.authorization; }
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const gwPath = (g, p = '') => `/api/groups/${g.id}/gw/${GW}${p}`;
const finalize = (g) => api('POST', gwPath(g, '/finalize'), { body: { season: SEASON } });
const counts = async () => ({
  snapshots: await raw('resultSnapshots').countDocuments(),
  actions: await raw('gwResultActions').countDocuments(),
  pointers: await raw('gwResults').countDocuments(),
});
const newGroup = (slug, entries = [101, 102, 103]) => groupRepo.create({ name: slug, slug, memberSource: 'MANUAL', winnerRule: 'NET_POINTS', members: entries.map((entryId) => ({ entryId })) });

let g1;
let final1;

// ── gates ───────────────────────────────────────────────────────────────

test('the first finalize ever cannot pass: DATA_CHECKED is first observed during its own sync', async () => {
  g1 = await newGroup('group-one');
  const before = await counts();
  const r = await finalize(g1);
  assert.deepEqual([r.status, r.body.error.code], [409, 'FINALIZE_BLOCKED'], JSON.stringify(r.body));
  assert.ok(r.body.error.details.reasons.includes('STALE_SYNC'));
  assert.equal(r.body.error.details.run.status, 'SUCCESS');
  assert.deepEqual(await counts(), before, 'a refused gate writes no decision');
  const run = await syncRunRepo.get(r.body.error.details.run.id);
  assert.equal(run.trigger, 'FINALIZE');
  assert.ok(run.expireAt instanceof Date, 'an unreferenced run keeps its expiry');
});

test('preview (GET result) computes PROVISIONAL without any mutation', async () => {
  const dump = async () => {
    const out = {};
    for (const c of ['resultSnapshots', 'gwResultActions', 'gwResults', 'seasons', 'managerGameweeks', 'syncRuns', 'fplRawResponses', 'locks']) out[c] = JSON.stringify(await raw(c).find().sort({ _id: 1 }).toArray());
    return out;
  };
  const before = await dump();
  const r = await api('GET', `${gwPath(g1, '/result')}?season=${SEASON}`);
  assert.equal(r.status, 200);
  const res = r.body.result;
  assert.deepEqual([res.status, res.winners, res.currentSnapshotId, res.eventState], ['PROVISIONAL', [103], null, 'DATA_CHECKED']);
  // The only run so far started before DATA_CHECKED was observed: the preview says so too.
  assert.deepEqual(res.finalizeGate, { allowed: false, reasons: ['STALE_SYNC'] });
  assert.deepEqual(res.tieBreakTrace.eligible, [101, 102, 103]);
  assert.deepEqual(await dump(), before, 'nothing written, not even semantics or confirmations');
});

// ── finalize (T4) ──────────────────────────────────────────────────────

test('finalize commits snapshot, GENESIS action and pointer in one T4, and retains its evidence', async () => {
  const before = await counts();
  const r = await finalize(g1);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  final1 = r.body;
  assert.deepEqual(await counts(), { snapshots: before.snapshots + 1, actions: before.actions + 1, pointers: before.pointers + 1 });
  const { snapshot, action, pointer, run } = final1;
  assert.equal(run.status, 'SUCCESS');
  assert.deepEqual([snapshot.kind, snapshot.declaredWinnerEntryIds, snapshot.computedWinnerEntryIds], ['RULE_BASED', [103], [103]]);
  assert.deepEqual([action.seq, action.prevHash, action.action, action.prevStatus, action.newStatus, action.syncRunId], [1, 'GENESIS', 'FINALIZE', 'PROVISIONAL', 'FINAL', run.id]);
  assert.deepEqual([pointer.status, pointer.headSeq, pointer.currentSnapshotId, pointer.headHash], ['FINAL', 1, snapshot.id, action.hash]);
  // Every input came from the finalize run itself.
  assert.deepEqual(snapshot.sources.map((s) => [s.syncRunId, s.status]), [[run.id, 'SUCCESS']]);
  assert.equal((await raw('syncRuns').findOne({ _id: oid(run.id) })).expireAt, undefined);
  const evidence = await raw('fplRawResponses').find({ syncRunId: oid(run.id), reason: 'FINAL_EVIDENCE' }).toArray();
  assert.equal(evidence.length, 3 * 3 + 1, 'history, picks, transfers per member + live');
  assert.ok(evidence.every((e) => e.expireAt === undefined && e.retainedBySnapshotIds.map(String).includes(snapshot.id)));
});

test('the snapshot stores reconciled gross/net inputs, eligibility, ranking and the decision trace', async () => {
  const s = (await api('GET', `/api/result-snapshots/${final1.snapshot.id}`)).body.snapshot;
  const rows = await raw('managerGameweeks').find({ season: SEASON, event: GW }).sort({ entryId: 1 }).toArray();
  for (const stored of rows) {
    const input = s.inputs.gwRows.find((x) => x.entryId === stored.entryId);
    assert.deepEqual([input.netGwPoints, input.grossGwPoints, input.reconciliationStatus, input.pointsSemantics],
      [stored.points.netGwPoints, stored.points.grossGwPoints, stored.points.reconciliationStatus, stored.points.pointsSemantics]);
  }
  assert.deepEqual(s.tieBreakTrace, { status: 'PROVISIONAL', eligible: [101, 102, 103], ineligible: [], blockedBy: [], winningScore: 61, topScoreTied: [103], steps: [], decidedBy: null, outcome: 'SINGLE', winners: [103] });
  assert.deepEqual(s.standings.map((x) => [x.entryId, x.competitionRank, x.isWinner]), [[103, 1, true], [102, 2, false], [101, 3, false]]);
  assert.equal(s.inputs.managers.length, 3);
});

test('a repeated finalize with identical inputs is idempotent: same decision, no new writes', async () => {
  const before = await counts();
  const r = await finalize(g1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replayed, true);
  assert.equal(r.body.snapshot.id, final1.snapshot.id);
  assert.equal(r.body.pointer.headSeq, 1);
  assert.deepEqual(await counts(), before);
});

test('the result reads back from the immutable snapshot and reproduces from its stored inputs', async () => {
  const r = (await api('GET', `${gwPath(g1, '/result')}?season=${SEASON}`)).body.result;
  assert.deepEqual([r.status, r.winners, r.currentSnapshotId, r.finalizeGate.reasons], ['FINAL', [103], final1.snapshot.id, ['ALREADY_FINAL']]);
  const v = (await api('GET', `/api/result-snapshots/${final1.snapshot.id}/verify`)).body;
  assert.deepEqual([v.contentHashValid, v.reproducible, v.mismatches, v.engineChanged], [true, true, [], false]);
  assert.deepEqual((await api('GET', `${gwPath(g1, '/actions/verify')}?season=${SEASON}`)).body, { valid: true });
});

test('provenance: the trace links the snapshot to its run, request log and raw evidence', async () => {
  const tr = (await api('GET', `/api/result-snapshots/${final1.snapshot.id}/trace`)).body;
  assert.equal(tr.sources.length, 1);
  const [src] = tr.sources;
  assert.equal(src.run.id, final1.run.id);
  assert.equal(src.requests.length, src.requestHashes.length);
  assert.ok(src.requests.every((q) => src.requestHashes.includes(q.bodySha256)));
  const history = src.requests.find((q) => q.path === '/entry/103/history/');
  assert.ok(tr.rawResponses.some((x) => x.id === history.rawResponseId && x.bodySha256 === history.bodySha256));
});

test('later FPL changes never touch the finalized snapshot', async () => {
  const snapBefore = await raw('resultSnapshots').findOne({ _id: oid(final1.snapshot.id) });
  world.state.entries[103].rows[4].points -= 20; // 103 would now lose
  const s = await sync.syncGroupGameweek({ groupId: g1.id, season: SEASON, event: GW });
  assert.equal(s.status, 'SUCCESS');
  assert.deepEqual(await raw('resultSnapshots').findOne({ _id: oid(final1.snapshot.id) }), snapBefore);
  const r = (await api('GET', `${gwPath(g1, '/result')}?season=${SEASON}`)).body.result;
  assert.deepEqual([r.status, r.winners], ['FINAL', [103]], 'the declared result stands until recompute/override');
  const again = await finalize(g1);
  assert.deepEqual([again.status, again.body.error.code, again.body.error.details.reasons], [409, 'FINALIZE_BLOCKED', ['ALREADY_FINAL']], 'changed inputs → recompute, not a silent re-finalize');
  world.state.entries[103].rows[4].points += 20;
});

// ── override / recompute ───────────────────────────────────────────────

test('override appends seq 2 with a note; recompute previews, needs a note to change winners, then commits seq 3', async () => {
  world.state.entries[103].rows[4].points -= 20;
  await sync.syncGroupGameweek({ groupId: g1.id, season: SEASON, event: GW });
  const noNote = await api('POST', gwPath(g1, '/override'), { body: { season: SEASON, winners: [101] } });
  assert.equal(noNote.status, 400);
  const outsider = await api('POST', gwPath(g1, '/override'), { body: { season: SEASON, winners: [999], note: 'league chair ruling' } });
  assert.deepEqual([outsider.status, outsider.body.error.code], [422, 'WINNERS_NOT_MEMBERS']);
  const o = await api('POST', gwPath(g1, '/override'), { body: { season: SEASON, winners: [101], note: 'league chair ruling' } });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.deepEqual([o.body.action.seq, o.body.action.newStatus, o.body.pointer.status, o.body.snapshot.kind], [2, 'OVERRIDDEN', 'OVERRIDDEN', 'OVERRIDE']);
  assert.deepEqual([o.body.snapshot.declaredWinnerEntryIds, o.body.snapshot.computedWinnerEntryIds], [[101], [102]]);

  const before = await counts();
  const dry = await api('POST', gwPath(g1, '/recompute'), { body: { season: SEASON, dryRun: true } });
  assert.equal(dry.status, 200);
  assert.deepEqual([dry.body.diff.oldWinners, dry.body.diff.newWinners, dry.body.diff.winnersChanged], [[101], [102], true]);
  assert.deepEqual(await counts(), before, 'dry run writes nothing');
  const bare = await api('POST', gwPath(g1, '/recompute'), { body: { season: SEASON } });
  assert.deepEqual([bare.status, bare.body.error.code], [400, 'NOTE_REQUIRED']);
  assert.deepEqual(await counts(), before);
  const c = await api('POST', gwPath(g1, '/recompute'), { body: { season: SEASON, note: 'FPL bonus correction' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([c.body.action.seq, c.body.pointer.status, c.body.snapshot.declaredWinnerEntryIds], [3, 'FINAL', [102]]);
  const actions = (await api('GET', `${gwPath(g1, '/actions')}?season=${SEASON}`)).body.actions;
  assert.deepEqual(actions.map((a) => [a.seq, a.action]), [[1, 'FINALIZE'], [2, 'OVERRIDE'], [3, 'RECOMPUTE']]);
  assert.deepEqual((await api('GET', `${gwPath(g1, '/actions/verify')}?season=${SEASON}`)).body, { valid: true });
  world.state.entries[103].rows[4].points += 20;
});

// ── the finalize run must confirm every member ─────────────────────────

test('one member failing in the finalize sync blocks it, although an older SUCCESS run covers them', async () => {
  const g2 = await newGroup('group-two');
  await sync.syncGroupGameweek({ groupId: g2.id, season: SEASON, event: GW }); // a fresh, successful older run
  const preview = (await api('GET', `${gwPath(g2, '/result')}?season=${SEASON}`)).body.result;
  assert.deepEqual(preview.finalizeGate, { allowed: true, reasons: [] }, 'on its own the older run looks fresh');
  world.overrides.set('/entry/102/history/', new Response('{"detail":"oops"}', { status: 500 }));
  try {
    const before = await counts();
    const r = await finalize(g2);
    assert.deepEqual([r.status, r.body.error.code], [409, 'FINALIZE_BLOCKED']);
    const d = r.body.error.details;
    assert.deepEqual([d.run.status, d.notConfirmedByFinalizeRun], ['PARTIAL', [102]]);
    assert.ok(d.reasons.includes('FINALIZE_SYNC_NOT_SUCCESS') && d.reasons.includes('STALE_SYNC'));
    assert.deepEqual(await counts(), before);
    assert.equal(await resultRepo.getPointer(g2.id, SEASON, GW), null);
  } finally {
    world.overrides.clear();
  }
  const ok = await finalize(g2);
  assert.equal(ok.status, 201, 'once every member syncs in the finalize run it passes');
});

// ── concurrency and fencing ────────────────────────────────────────────

test('two simultaneous finalizations: one decision, the other refused (409 SYNC_IN_PROGRESS)', async () => {
  const g3 = await newGroup('group-three');
  await sync.syncGroupGameweek({ groupId: g3.id, season: SEASON, event: GW });
  let open;
  const gate = new Promise((r) => { open = r; });
  world.overrides.set('/bootstrap-static/', async () => { await gate; return undefined; });
  const first = finalize(g3);
  await new Promise((r) => setTimeout(r, 150));
  const second = await finalize(g3);
  world.overrides.clear();
  open();
  const done = await first;
  assert.deepEqual([done.status, second.status, second.body.error.code], [201, 409, 'SYNC_IN_PROGRESS']);
  const actions = await resultRepo.listActions(g3.id, SEASON, GW);
  assert.deepEqual(actions.map((a) => a.seq), [1]);
  assert.equal((await finalize(g3)).body.replayed, true, 'a later retry is an idempotent replay');
  assert.equal((await resultRepo.listActions(g3.id, SEASON, GW)).length, 1);
});

test('a stale lease holder cannot commit a decision (direct T4)', async () => {
  const g4 = await newGroup('group-four');
  const lockId = lockKeys.group(g4.id);
  const stale = await tryAcquireLease(lockId, { ttlMs: 60_000 });
  await lockRepo.release(lockId, stale.owner);
  const fresh = await tryAcquireLease(lockId, { ttlMs: 60_000 });
  const before = await counts();
  await assert.rejects(results.runT4({
    lease: stale, groupId: g4.id, season: SEASON, event: GW, action: 'FINALIZE',
    plan: async () => { throw new Error('the plan must never run after a lost fence'); },
  }), LockLostError);
  assert.deepEqual(await counts(), before);
  await fresh.release();
});

test('a finalize whose lease is taken over mid-sync commits nothing', async () => {
  const g5 = await newGroup('group-five');
  const lockId = lockKeys.group(g5.id);
  let takeover = null;
  world.overrides.set('/entry/103/transfers/', async () => {
    const held = await lockRepo.get(lockId);
    await lockRepo.release(lockId, held.owner);
    takeover = await tryAcquireLease(lockId, { ttlMs: 60_000 });
    await syncRunRepo.markAbandoned(lockId, takeover.fencingToken);
    return undefined;
  });
  try {
    const before = await counts();
    const r = await finalize(g5);
    assert.deepEqual([r.status, r.body.error.code], [503, 'LOCK_LOST'], JSON.stringify(r.body));
    assert.deepEqual(await counts(), before);
    assert.equal(await resultRepo.getPointer(g5.id, SEASON, GW), null);
  } finally {
    world.overrides.clear();
    await takeover?.release();
  }
});

test('T4 rolls back completely when any step fails', async () => {
  const g6 = await newGroup('group-six');
  await sync.syncGroupGameweek({ groupId: g6.id, season: SEASON, event: GW });
  const failing = createResultService({ sync, repos: { resultRepo: { ...resultRepo, movePointer: async () => { throw new Error('injected after insertSnapshot + appendAction'); } } } });
  const before = await counts();
  const expiring = await raw('syncRuns').countDocuments({ expireAt: { $exists: true } });
  await assert.rejects(failing.finalize(g6.id, SEASON, GW), /injected/);
  assert.deepEqual(await counts(), before, 'no snapshot, no action, no pointer');
  assert.equal(await raw('syncRuns').countDocuments({ expireAt: { $exists: true } }), expiring + 1, 'no retention applied (only the new run added)');
  assert.equal(await raw('fplRawResponses').countDocuments({ retainedBySnapshotIds: { $size: 0 }, reason: 'FINAL_EVIDENCE', expireAt: { $exists: false } }), 0);
});

test('an immutable snapshot rejects every mutation path; the chain still verifies', async () => {
  const { ResultSnapshot, GwResultAction, ImmutableCollectionError } = await import('../../src/models/index.js');
  await assert.rejects(ResultSnapshot.updateOne({ _id: final1.snapshot.id }, { $set: { declaredWinnerEntryIds: [101] } }), ImmutableCollectionError);
  await assert.rejects(GwResultAction.deleteOne({ _id: final1.action.id }), ImmutableCollectionError);
  assert.deepEqual(await resultRepo.verifyChain(g1.id, SEASON, GW), { valid: true });
});

// ── semantics gates ───────────────────────────────────────────────────

async function worldGroup(year, entries, mutate) {
  const w = createWorld({ seasonStartYear: year, entries });
  mutate(w);
  const s = createSyncService({ client: worldClient(w), clock: tickingClock(new Date(Date.UTC(year, 8, 22, 19))), heartbeatMs: 60_000 });
  const rs = createResultService({ sync: s });
  const g = await newGroup(`sem-${year}`, entries);
  return { w, s, rs, g, season: `${year}-${String((year + 1) % 100).padStart(2, '0')}` };
}

test('CONFLICTED semantics block finalization of hit rows', async () => {
  const { rs, g, season } = await worldGroup(2027, [201, 202], (w) => {
    w.state.entries[201].rows[4] = { event: 5, points: 70, cost: 4 }; // proves GROSS
    w.state.entries[202].rows[4] = { event: 5, points: 64, cost: 4, net: true }; // proves NET
  });
  const first = await rs.finalize(g.id, season, GW).catch((e) => e);
  assert.equal(first.code, 'FINALIZE_BLOCKED');
  assert.ok(first.details.reasons.includes('SEMANTICS_CONFLICTED'), JSON.stringify(first.details.reasons));
  assert.equal(first.details.seasonSemantics, 'CONFLICTED');
  const second = await rs.finalize(g.id, season, GW).catch((e) => e);
  assert.equal(second.code, 'FINALIZE_BLOCKED');
  assert.ok(second.details.reasons.includes('RECONCILIATION_FAILED'), 'now every hit row is SEMANTICS_CONFLICT');
  assert.deepEqual(second.details.unreconciled.map((u) => u.reconciliationStatus), ['SEMANTICS_CONFLICT', 'SEMANTICS_CONFLICT']);
  assert.equal(await resultRepo.getPointer(g.id, season, GW), null);
});

test('cost-free rows are not blocked by the semantics guard, even in a CONFLICTED season', async () => {
  // The conflicting hits are in GW3; the finalized GW5 has only C = 0 rows (v0.2 §2: semantics irrelevant).
  const { rs, s, g, season } = await worldGroup(2029, [401, 402], (w) => {
    w.state.entries[401].rows[2] = { event: 3, points: 70, cost: 4 }; // proves GROSS
    w.state.entries[402].rows[2] = { event: 3, points: 64, cost: 4, net: true }; // proves NET
  });
  await s.syncGroupGameweek({ groupId: g.id, season, event: GW });
  const r = await rs.finalize(g.id, season, GW);
  assert.equal(r.pointer.status, 'FINAL');
  const snap = await resultRepo.getSnapshot(r.snapshot.id);
  assert.deepEqual(snap.inputs.gwRows.map((x) => [x.transferCost, x.reconciliationStatus]), [[0, 'RECONCILED_NO_COST'], [0, 'RECONCILED_NO_COST']]);
  const gw3 = await raw('managerGameweeks').find({ season, event: 3 }).sort({ entryId: 1 }).toArray();
  assert.deepEqual(gw3.map((x) => x.points.reconciliationStatus), ['SEMANTICS_CONFLICT', 'SEMANTICS_CONFLICT'], 'the season really is CONFLICTED');
  assert.equal((await raw('seasons').findOne({ _id: season })).pointsSemantics.value, 'CONFLICTED');
});

test('UNVERIFIED semantics block a hit row that proves nothing', async () => {
  const { rs, s, g, season } = await worldGroup(2028, [301, 302], (w) => {
    w.state.entries[301].rows[4] = { event: 5, points: 70, cost: 4, delta: 68 }; // neither H_gross nor H_net
  });
  await s.syncGroupGameweek({ groupId: g.id, season, event: GW });
  const r = await rs.finalize(g.id, season, GW).catch((e) => e);
  assert.equal(r.code, 'FINALIZE_BLOCKED');
  assert.deepEqual(r.details.reasons, ['RECONCILIATION_FAILED']);
  assert.equal(r.details.seasonSemantics, 'UNVERIFIED');
  assert.deepEqual(r.details.unreconciled, [{ entryId: 301, reconciliationStatus: 'MISMATCH' }]);
});

// ── API auth / authorization regression ─────────────────────────────────

test('result routes: 401 anonymous, 403 viewer writes, 404 across groups, validation errors', async () => {
  const share = (await api('POST', `/api/groups/${g1.id}/share-token`)).body.shareToken;
  const other = await newGroup('group-other');
  assert.equal((await api('GET', `${gwPath(g1, '/result')}?season=${SEASON}`, { token: null })).status, 401);
  assert.equal((await api('POST', gwPath(g1, '/finalize'), { token: null, body: { season: SEASON } })).status, 401);
  assert.equal((await api('GET', `/api/result-snapshots/${final1.snapshot.id}`, { token: null })).status, 401);

  assert.equal((await api('GET', `${gwPath(g1, '/result')}?season=${SEASON}`, { share })).status, 200);
  assert.equal((await api('GET', `${gwPath(g1, '/result')}?season=${SEASON}`, { share })).body.result.finalizeGate, undefined);
  assert.equal((await api('GET', `${gwPath(g1, '/actions')}?season=${SEASON}`, { share })).status, 200);
  assert.equal((await api('GET', `/api/result-snapshots/${final1.snapshot.id}`, { share })).status, 200);
  for (const [m, p, body] of [['POST', gwPath(g1, '/finalize'), { season: SEASON }], ['POST', gwPath(g1, '/override'), { season: SEASON, winners: [101], note: 'nope nope' }], ['POST', gwPath(g1, '/recompute'), { season: SEASON, dryRun: true }]]) {
    assert.equal((await api(m, p, { share, body })).status, 403, p);
  }
  assert.equal((await api('GET', `${gwPath(other, '/result')}?season=${SEASON}`, { share })).status, 404);
  const otherFinal = (await raw('resultSnapshots').findOne({ groupId: { $ne: oid(g1.id) } }))._id;
  assert.equal((await api('GET', `/api/result-snapshots/${otherFinal}`, { share })).status, 404, "another group's snapshot is not confirmed");

  for (const p of [`/api/groups/${g1.id}/gw/0/result`, `/api/groups/${g1.id}/gw/39/result`, `/api/groups/${g1.id}/gw/x/result`, `/api/groups/nope/gw/5/result`, `/api/groups/${'f'.repeat(24)}/gw/5/result`]) {
    assert.equal((await api('GET', `${p}?season=${SEASON}`)).status, 404, p);
  }
  assert.equal((await api('GET', `/api/result-snapshots/${'f'.repeat(24)}`)).status, 404);
  assert.equal((await api('GET', gwPath(g1, '/result'))).status, 400, 'season is required');
  assert.equal((await api('POST', gwPath(g1, '/finalize'), { body: { season: '2026' } })).status, 400);
  await api('POST', `/api/groups/${other.id}/archive`);
  const archived = await api('POST', gwPath(other, '/finalize'), { body: { season: SEASON } });
  assert.deepEqual([archived.status, archived.body.error.code], [409, 'GROUP_ARCHIVED']);
  assert.equal((await api('GET', `${gwPath(other, '/result')}?season=${SEASON}`)).status, 200, 'archived groups stay readable');
});
