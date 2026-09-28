import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { gunzipSync } from 'node:zlib';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { withTransaction } from '../../src/db/unitOfWork.js';
import { canonicalJson } from '../../src/utils/canonical.js';
import { acquireLease } from '../../src/locks/leaseLock.js';
import { lockKeys } from '../../src/locks/lockKeys.js';
import { LockLostError } from '../../src/locks/errors.js';
import { lockRepo } from '../../src/repositories/lockRepo.js';
import {
  groupRepo, managerRepo, seasonRepo, eventRepo, playerRepo, managerGameweekRepo, managerSeasonRepo, liveRepo, syncRunRepo, rawResponseRepo,
  DuplicateMemberError, NotFoundError,
} from '../../src/repositories/index.js';
import { RUN_RETENTION_MS, REQUEST_LOG_TRUNCATED } from '../../src/repositories/syncRunRepo.js';
import { bodySha256, RAW_TOO_LARGE } from '../../src/repositories/rawResponseRepo.js';
import { MAX_REQUESTS_PER_RUN } from '../../src/models/SyncRun.js';
import { SEASON, GW, OBSERVED_AT, newId, gwRow, eventValue, seasonValue } from '../helpers/repoFixtures.js';

let t;
before(async () => { t = await startTestDb(); await runMigrations(t.db); });
after(async () => { await t.stop(); });

const raw = (coll) => t.db.collection(coll);
const tx = (fn) => withTransaction(fn);
const T0 = new Date('2026-09-22T19:00:00Z');
const ctx = (minutesAfterObserved = 30, runId = newId()) => {
  const startedAt = new Date(OBSERVED_AT.getTime() + minutesAfterObserved * 60_000);
  return { runId, startedAt, at: new Date(startedAt.getTime() + 1000) };
};
// Everything except the confirmation stamps (v0.3 §6: a replay is byte-identical apart from those).
const withoutConfirm = (doc) => {
  const { lastConfirmedByRunId, lastConfirmedAt, ...p } = doc.provenance;
  return canonicalJson({ ...doc, _id: String(doc._id), provenance: { ...p, lastChangedByRunId: String(p.lastChangedByRunId) } });
};

// ── groups: CRUD, member uniqueness, archive ─────────────────────────────

const groupInput = (over = {}) => ({
  name: 'Rivals', slug: `rivals-${Math.random().toString(36).slice(2, 8)}`, memberSource: 'MANUAL', winnerRule: 'NET_POINTS',
  members: [{ entryId: 11, addedAt: T0 }, { entryId: 12, addedAt: T0 }], ...over,
});

test('groupRepo.create stores a group with the default tie-break chain and returns a domain object', async () => {
  const g = await groupRepo.create(groupInput({ name: 'Alpha' }), { at: T0 });
  assert.match(g.id, /^[a-f0-9]{24}$/);
  assert.deepEqual(g.tieBreakRules, ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED']);
  assert.equal(g.isActive, true);
  assert.equal(g.archivedAt, null);
  assert.deepEqual(g.members.map((m) => m.entryId), [11, 12]);
  assert.deepEqual(await groupRepo.getById(g.id), g, 'lean read maps to the same domain object');
  assert.deepEqual(await groupRepo.getBySlug(g.slug), g);
});

test('groupRepo.create rejects duplicate entryIds and duplicate slugs', async () => {
  await assert.rejects(groupRepo.create(groupInput({ members: [{ entryId: 1, addedAt: T0 }, { entryId: 1, addedAt: T0 }] })), DuplicateMemberError);
  const g = await groupRepo.create(groupInput());
  await assert.rejects(groupRepo.create(groupInput({ slug: g.slug })), { code: 11000 });
});

test('groupRepo.updateConfig changes config fields only and validates tie-break rules', async () => {
  const g = await groupRepo.create(groupInput());
  const u = await groupRepo.updateConfig(g.id, { winnerRule: 'GROSS_POINTS', tieBreakRules: ['HIGHER_CAPTAIN_POINTS', 'SHARED'] }, { at: new Date(T0.getTime() + 1) });
  assert.equal(u.winnerRule, 'GROSS_POINTS');
  assert.deepEqual(u.tieBreakRules, ['HIGHER_CAPTAIN_POINTS', 'SHARED']);
  await assert.rejects(groupRepo.updateConfig(g.id, { members: [] }), /not a group config field: members/);
  await assert.rejects(groupRepo.updateConfig(g.id, { isActive: false }), /not a group config field/);
  await assert.rejects(groupRepo.updateConfig(g.id, { tieBreakRules: ['LOWER_ENTRY_ID', 'SHARED'] }), { name: 'ValidationError' });
  await assert.rejects(groupRepo.updateConfig(g.id, { tieBreakRules: ['SHARED', 'FEWER_TRANSFER_COST'] }), { name: 'ValidationError' });
  await assert.rejects(groupRepo.updateConfig(newId(), { name: 'x' }), NotFoundError);
});

test('groupRepo.setMembers needs a transaction, rejects duplicates and keeps addedAt keyed on entryId', async () => {
  const g = await groupRepo.create(groupInput());
  await assert.rejects(groupRepo.setMembers(g.id, [{ entryId: 13 }]), /inside a db\/unitOfWork transaction/);
  await assert.rejects(tx((session) => groupRepo.setMembers(g.id, [{ entryId: 13 }, { entryId: 14 }, { entryId: 13 }], { session })), DuplicateMemberError);
  assert.deepEqual((await groupRepo.getById(g.id)).members.map((m) => m.entryId), [11, 12], 'unchanged after the rejected write');

  const later = new Date(T0.getTime() + 60_000);
  const u = await tx((session) => groupRepo.setMembers(g.id, [{ entryId: 12, isExcluded: true }, { entryId: 15, joinedEvent: 7 }], { session, at: later }));
  assert.deepEqual(u.members.map((m) => [m.entryId, m.isExcluded, m.joinedEvent, m.addedAt.getTime()]), [[12, true, null, T0.getTime()], [15, false, 7, later.getTime()]]);
});

test('concurrent member writes never duplicate an entryId (read-modify-write in transactions)', async () => {
  const g = await groupRepo.create(groupInput({ members: [] }));
  const addIfMissing = (entryId) => tx(async (session) => {
    const cur = await groupRepo.getById(g.id, { session });
    const members = cur.members.some((m) => m.entryId === entryId) ? cur.members : [...cur.members, { entryId }];
    return groupRepo.setMembers(g.id, members, { session });
  });
  await Promise.all([addIfMissing(21), addIfMissing(22), addIfMissing(21), addIfMissing(23), addIfMissing(22)]);
  const ids = (await groupRepo.getById(g.id)).members.map((m) => m.entryId).sort((a, b) => a - b);
  assert.deepEqual(ids, [21, 22, 23]);
  const dupes = await raw('groups').aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(g.id) } }, { $unwind: '$members' },
    { $group: { _id: '$members.entryId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } },
  ]).toArray();
  assert.deepEqual(dupes, [], 'db:check I1 holds');
});

test('archive / unarchive are idempotent single-document writes; list and lookups order by name', async () => {
  const a = await groupRepo.create(groupInput({ name: 'Zulu', members: [{ entryId: 31, addedAt: T0 }] }));
  const b = await groupRepo.create(groupInput({ name: 'Bravo', members: [{ entryId: 31, addedAt: T0 }] }));
  const at = new Date(T0.getTime() + 5000);
  assert.equal(await groupRepo.archive(a.id, { at }), true);
  assert.equal(await groupRepo.archive(a.id, { at }), false);
  const archived = await groupRepo.getById(a.id);
  assert.equal(archived.isActive, false);
  assert.equal(archived.archivedAt.getTime(), at.getTime());
  assert.ok(!(await groupRepo.list()).some((x) => x.id === a.id));
  assert.ok((await groupRepo.list({ includeArchived: true })).some((x) => x.id === a.id));
  assert.deepEqual((await groupRepo.listContainingEntry(31)).map((x) => x.name), ['Bravo', 'Zulu']);
  assert.equal(await groupRepo.unarchive(a.id), true);
  assert.equal(await groupRepo.unarchive(a.id), false);
  assert.equal((await groupRepo.getById(a.id)).archivedAt, null);
  await assert.rejects(groupRepo.archive(newId()), NotFoundError);
  const names = (await groupRepo.list()).map((x) => x.name);
  assert.deepEqual(names, [...names].sort((x, y) => x.localeCompare(y)));
  assert.equal(b.isActive, true);
});

// ── snapshot collections: deterministic ids, content hash, idempotency ──

test('managerGameweekRepo writes deterministic _ids as BSON ints and replays byte-identically', async () => {
  await tx((session) => eventRepo.bulkUpsert([eventValue()], ctx(), { session }));
  const rows = [gwRow(501, { event: 4, T: 240 }), gwRow(501, { event: 5, T: 300 })];
  const r1 = ctx(30);
  const first = await tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 501, rows, r1, { session, sourceRequests: { history: `sha256:${'1'.repeat(64)}` } }));
  assert.deepEqual(first.inserted, ['2026-27:501:4', '2026-27:501:5']);
  const before = await raw('managerGameweeks').find({ entryId: 501 }).sort({ event: 1 }).toArray();
  assert.equal(await raw('managerGameweeks').countDocuments({ entryId: 501, event: { $type: 'int' }, 'points.totalPoints': { $type: 'int' } }), 2);

  const r2 = ctx(40);
  const second = await tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 501, rows, r2, { session, sourceRequests: { history: `sha256:${'1'.repeat(64)}` } }));
  assert.deepEqual(second, { inserted: [], changed: [], unchanged: ['2026-27:501:4', '2026-27:501:5'], settledRowChanges: [] });
  const after = await raw('managerGameweeks').find({ entryId: 501 }).sort({ event: 1 }).toArray();
  assert.equal(after.length, 2, 'no duplicates');
  assert.deepEqual(after.map(withoutConfirm), before.map(withoutConfirm), 'replay leaves everything but confirmation stamps unchanged');
  for (const d of after) {
    assert.equal(String(d.provenance.lastConfirmedByRunId), r2.runId);
    assert.equal(String(d.provenance.lastChangedByRunId), r1.runId);
  }
});

test('a content change rewrites data + lastChanged; a settled row change is reported', async () => {
  const r1 = ctx(30);
  await tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 502, [gwRow(502)], r1, { session }));
  const settledDoc = await managerGameweekRepo.listForEntry(SEASON, 502, { withProvenance: true });
  assert.equal(settledDoc[0].provenance.settled, true, 'run started after DATA_CHECKED was observed');
  const oldHash = settledDoc[0].provenance.contentHash;

  const r2 = ctx(50);
  const out = await tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 502, [gwRow(502, { R: 61, T: 301 })], r2, { session }));
  assert.deepEqual(out.changed, ['2026-27:502:5']);
  assert.equal(out.settledRowChanges.length, 1);
  assert.equal(out.settledRowChanges[0].oldHash, oldHash);
  const [row] = await managerGameweekRepo.listForEntry(SEASON, 502, { withProvenance: true });
  assert.equal(row.points.reportedGwPoints, 61);
  assert.equal(row.provenance.lastChangedByRunId, r2.runId);
  assert.notEqual(row.provenance.contentHash, oldHash);
});

test('settled is false when the run started before DATA_CHECKED was observed', async () => {
  const early = ctx(-10);
  await tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 503, [gwRow(503)], early, { session }));
  const [row] = await managerGameweekRepo.listForEntry(SEASON, 503, { withProvenance: true });
  assert.equal(row.provenance.settled, false);
});

test('invalid rows are rejected by the model before anything is written (picks, net/gross, stray entry)', async () => {
  const bad = gwRow(504);
  bad.picks[1].isCaptain = true; // two captains
  await assert.rejects(tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 504, [gwRow(504, { event: 4 }), bad], ctx(), { session })), /invalid picks/);
  const unreconciledWithNet = gwRow(504, { status: 'MISMATCH' });
  unreconciledWithNet.points.netGwPoints = 60;
  await assert.rejects(tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 504, [unreconciledWithNet], ctx(), { session })), /net\/gross must be null unless reconciled/);
  await assert.rejects(tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 504, [gwRow(505)], ctx(), { session })), /must all belong/);
  assert.equal(await raw('managerGameweeks').countDocuments({ entryId: 504 }), 0, 'the whole T3 write rolled back');
});

test('UNVERIFIED and CONFLICTED rows round trip unchanged through the repository', async () => {
  const rows = [
    gwRow(506, { event: 3, T: 180, semantics: 'UNVERIFIED' }),
    gwRow(506, { event: 4, R: 70, C: 4, T: 246, status: 'SEMANTICS_CONFLICT', semantics: 'CONFLICTED', hypothesis: 'GROSS' }),
  ];
  await tx((session) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 506, rows, ctx(), { session }));
  const back = await managerGameweekRepo.listForEntry(SEASON, 506);
  assert.deepEqual(back.map((r) => [r.event, r.points.pointsSemantics, r.points.reconciliationStatus, r.points.netGwPoints, r.points.grossGwPoints]),
    [[3, 'UNVERIFIED', 'RECONCILED_NO_COST', 60, 60], [4, 'CONFLICTED', 'SEMANTICS_CONFLICT', null, null]]);
  assert.deepEqual(back.map(({ id: _i, ...r }) => r), rows, 'mapper round trip through MongoDB');
});

test('listForEvent returns a GW for a set of entries ordered by entryId', async () => {
  const rs = await managerGameweekRepo.listForEvent(SEASON, GW, [506, 502, 501, 999]);
  assert.deepEqual(rs.map((r) => r.entryId), [501, 502]);
});

test('managers, manager seasons and live data upsert idempotently with deterministic _ids', async () => {
  const r1 = ctx(30);
  const transfers = [{ elementIn: 3, elementInCostTenths: 55, elementOut: 16, elementOutCostTenths: 60, event: 2, time: T0 }];
  await tx(async (session) => {
    await managerRepo.upsertProfiles([{ entryId: 601, playerName: 'A', teamName: 'TA' }, { entryId: 602, playerName: 'B', teamName: 'TB' }], r1, { session, sourceRequests: (p) => ({ entry: `sha256:${String(p.entryId % 10).repeat(64)}` }) });
    await managerSeasonRepo.upsert({ season: SEASON, entryId: 601, chips: [{ name: 'wildcard', event: 3, time: T0 }], transfers: [...transfers, ...transfers] }, r1, { session });
  });
  const again = await tx((session) => managerRepo.upsertProfiles([{ entryId: 601, playerName: 'A', teamName: 'TA' }], ctx(40), { session }));
  assert.deepEqual(again.unchanged, [601]);
  assert.deepEqual((await managerRepo.getMany([602, 601])).map((m) => m.entryId), [601, 602]);
  const m = await managerRepo.get(602, { withProvenance: true });
  assert.deepEqual(m.provenance.sourceRequests, { entry: `sha256:${'2'.repeat(64)}` });
  const ms = await managerSeasonRepo.get(SEASON, 601);
  assert.equal(ms.id, '2026-27:601');
  assert.equal(ms.transfers.length, 1, 'transfers de-duplicated on time + in + out');

  const live = { season: SEASON, gw: GW, elements: [{ elementId: 1, totalPoints: 6, minutes: 90, settled: true }] };
  assert.deepEqual((await liveRepo.replace(live, r1)).inserted, ['2026-27:5']);
  assert.deepEqual((await liveRepo.replace(live, ctx(45))).unchanged, ['2026-27:5']);
  const changed = await liveRepo.replace({ ...live, elements: [{ elementId: 2, totalPoints: 1, minutes: 10, settled: false }] }, ctx(50));
  assert.deepEqual(changed.changed, ['2026-27:5']);
  assert.equal(changed.settledRowChanges.length, 1, 'live doc was settled, its change is reported');
  assert.deepEqual((await liveRepo.get(SEASON, GW)).elements, [{ elementId: 2, totalPoints: 1, minutes: 10, settled: false }], 'elements replaced wholesale');
});

test('players: unordered bulk upsert without a transaction; reads by season ordered by elementId', async () => {
  const players = [3, 1, 2].map((e) => ({ season: SEASON, elementId: e, webName: `P${e}`, teamId: 1, elementType: 2, priceTenths: 45 + e, status: null }));
  const out = await playerRepo.bulkUpsert(players, ctx());
  assert.deepEqual(out.inserted, ['2026-27:3', '2026-27:1', '2026-27:2']);
  assert.deepEqual((await playerRepo.getMany(SEASON, [2, 3])).map((p) => [p.id, p.priceTenths]), [['2026-27:2', 47], ['2026-27:3', 48]]);
  await assert.rejects(playerRepo.bulkUpsert([{ ...players[0], priceTenths: 4.5 }], ctx()), /must be an integer/);
  await assert.rejects(playerRepo.bulkUpsert([players[0], players[0]], ctx()), /duplicate _id/);
});

test('events: T1 bulk upsert, fixtures replaced wholesale, ordered reads', async () => {
  await assert.rejects(eventRepo.bulkUpsert([eventValue({ gw: 6 })], ctx()), /inside a db\/unitOfWork transaction/);
  const r = ctx(30);
  await tx((session) => eventRepo.bulkUpsert([eventValue({ gw: 7, isCurrent: false }), eventValue({ gw: 6, isCurrent: false })], r, { session }));
  await tx((session) => eventRepo.bulkUpsert([eventValue({ gw: 6, isCurrent: false, fixtures: [] })], ctx(35), { session }));
  const e6 = await eventRepo.get(SEASON, 6, { withProvenance: true });
  assert.deepEqual(e6.fixtures, [], 'a postponed fixture leaves its old GW');
  assert.equal(e6.id, '2026-27:6');
  assert.deepEqual((await eventRepo.listBySeason(SEASON)).map((e) => e.gw), [5, 6, 7]);
  assert.equal((await eventRepo.getCurrent(SEASON)).gw, 5);
});

// ── seasons: two hashed blocks and the semantics evidence update ────────

test('seasons: teams and chip rules are hashed separately; pointsSemantics survives T1 writes', async () => {
  const r1 = ctx(30);
  assert.deepEqual(await tx((session) => seasonRepo.replaceTeamsAndChipRules(seasonValue(), r1, { session })), { season: 'inserted', chipRules: 'inserted' });
  assert.deepEqual(await tx((session) => seasonRepo.replaceTeamsAndChipRules(seasonValue(), ctx(35), { session })), { season: 'unchanged', chipRules: 'unchanged' });
  const r3 = ctx(40);
  const newRules = { source: 'CONFIG_FALLBACK', rules: [{ chipName: 'wildcard', startEvent: 2, stopEvent: 19, number: 1, chipType: 'transfer' }] };
  assert.deepEqual(await tx((session) => seasonRepo.replaceTeamsAndChipRules(seasonValue({ chipRules: newRules }), r3, { session })), { season: 'unchanged', chipRules: 'changed' });
  const s = await seasonRepo.get(SEASON, { withProvenance: true });
  assert.deepEqual(s.chipRules.rules, newRules.rules, 'rule set replaced as a whole');
  assert.equal(s.chipRules.source, 'CONFIG_FALLBACK');
  assert.equal(s.chipRules.provenance.lastChangedByRunId, r3.runId);
  assert.equal(s.provenance.lastChangedByRunId, r1.runId);
  assert.equal(s.provenance.lastConfirmedByRunId, r3.runId);
  assert.deepEqual(s.pointsSemantics, { value: 'UNVERIFIED', evidenceRows: 0, conflictRows: 0, firstVerifiedRunId: null });

  await seasonRepo.applySemanticsEvidence(SEASON, { gross: 1, net: 0 }, r3.runId);
  await tx((session) => seasonRepo.replaceTeamsAndChipRules(seasonValue(), ctx(60), { session }));
  assert.equal((await seasonRepo.get(SEASON)).pointsSemantics.value, 'GROSS_BEFORE_HITS', 'T1 never touches pointsSemantics');
});

test('semantics evidence: UNVERIFIED until proven, counts accumulate, any conflict is sticky CONFLICTED', async () => {
  const season = '2027-28';
  const sv = seasonValue({ season });
  await tx((session) => seasonRepo.replaceTeamsAndChipRules(sv, ctx(), { session }));
  const run1 = newId();
  const run2 = newId();
  assert.deepEqual(await seasonRepo.applySemanticsEvidence(season, { gross: 0, net: 0 }, run1), { value: 'UNVERIFIED', evidenceRows: 0, conflictRows: 0, firstVerifiedRunId: null });
  assert.deepEqual(await seasonRepo.applySemanticsEvidence(season, { gross: 2, net: 0 }, run1), { value: 'GROSS_BEFORE_HITS', evidenceRows: 2, conflictRows: 0, firstVerifiedRunId: run1 });
  assert.deepEqual(await seasonRepo.applySemanticsEvidence(season, { gross: 3, net: 0 }, run2), { value: 'GROSS_BEFORE_HITS', evidenceRows: 5, conflictRows: 0, firstVerifiedRunId: run1 });
  assert.deepEqual(await seasonRepo.applySemanticsEvidence(season, { gross: 1, net: 1 }, run2), { value: 'CONFLICTED', evidenceRows: 6, conflictRows: 1, firstVerifiedRunId: run1 });
  assert.deepEqual(await seasonRepo.applySemanticsEvidence(season, { gross: 4, net: 0 }, run2), { value: 'CONFLICTED', evidenceRows: 6, conflictRows: 1, firstVerifiedRunId: run1 });

  const s2 = '2028-29';
  await tx((session) => seasonRepo.replaceTeamsAndChipRules(seasonValue({ season: s2 }), ctx(), { session }));
  assert.deepEqual(await seasonRepo.applySemanticsEvidence(s2, { gross: 1, net: 2 }, run1), { value: 'CONFLICTED', evidenceRows: 0, conflictRows: 3, firstVerifiedRunId: null });
  const s3 = '2029-30';
  await tx((session) => seasonRepo.replaceTeamsAndChipRules(seasonValue({ season: s3 }), ctx(), { session }));
  assert.equal((await seasonRepo.applySemanticsEvidence(s3, { gross: 0, net: 1 }, run1)).value, 'NET_AFTER_HITS');

  await assert.rejects(seasonRepo.applySemanticsEvidence('2030-31', { gross: 1, net: 0 }, run1), NotFoundError);
  await assert.rejects(seasonRepo.applySemanticsEvidence(season, { gross: -1, net: 0 }, run1), /non-negative integer/);
});

// ── sync runs ────────────────────────────────────────────────────────────

test('syncRunRepo: insert RUNNING with 90-day expiry, finish once, never reopen', async () => {
  const startedAt = new Date('2026-09-22T20:00:00Z');
  const id = newId();
  const r = await syncRunRepo.insert({ id, job: 'group-gw', target: 'g1', season: SEASON, event: GW, trigger: 'MANUAL', lockId: 'sync:group:g1', lockFencingToken: 5, startedAt });
  assert.equal(r.id, id, 'the lease owner id is the run id');
  assert.equal(r.status, 'RUNNING');
  assert.equal(r.expireAt.getTime(), startedAt.getTime() + RUN_RETENTION_MS);
  assert.equal(await syncRunRepo.finish(id, { status: 'PARTIAL', failures: [{ entryId: 7, code: 'HTTP_500', message: 'upstream' }], warnings: [{ code: 'SETTLED_ROW_CHANGED', detail: { id: 'x' } }], finishedAt: startedAt }), true);
  assert.equal(await syncRunRepo.finish(id, { status: 'SUCCESS' }), false, 'a finished run stays finished');
  await assert.rejects(syncRunRepo.finish(id, { status: 'RUNNING' }), /finish status/);
  const done = await syncRunRepo.get(id);
  assert.equal(done.status, 'PARTIAL');
  assert.deepEqual(done.failures, [{ entryId: 7, code: 'HTTP_500', message: 'upstream' }]);
  assert.deepEqual(done.warnings, [{ code: 'SETTLED_ROW_CHANGED', detail: { id: 'x' } }]);
  assert.deepEqual(await syncRunRepo.pushRequest(id, { path: '/late/', durationMs: 1 }), { logged: false, truncated: false });
});

test(`syncRunRepo.pushRequest caps the log at ${MAX_REQUESTS_PER_RUN} and records ${REQUEST_LOG_TRUNCATED} once`, async () => {
  const r = await syncRunRepo.insert({ job: 'group-gw', trigger: 'MANUAL', startedAt: T0 });
  for (let i = 0; i < MAX_REQUESTS_PER_RUN; i++) {
    assert.deepEqual(await syncRunRepo.pushRequest(r.id, { path: `/p/${i}/`, httpStatus: 200, bodySha256: `sha256:${'c'.repeat(64)}`, bytes: 1, durationMs: 1 }), { logged: true, truncated: false });
  }
  assert.deepEqual(await syncRunRepo.pushRequest(r.id, { path: '/over/', durationMs: 1 }), { logged: false, truncated: true });
  assert.deepEqual(await syncRunRepo.pushRequest(r.id, { path: '/over2/', durationMs: 1 }), { logged: false, truncated: true });
  const run = await syncRunRepo.get(r.id);
  assert.equal(run.requests.length, MAX_REQUESTS_PER_RUN);
  assert.equal(run.warnings.filter((w) => w.code === REQUEST_LOG_TRUNCATED).length, 1);
});

test('markAbandoned orders by fencing token, not ObjectId; getMany orders by startedAt', async () => {
  const lockId = 'sync:group:abandon-test';
  const hiId = 'ffffffffffffffffffffffff'.slice(0, 24);
  const loId = '000000000000000000000001';
  await syncRunRepo.insert({ id: hiId, job: 'j', trigger: 'MANUAL', lockId, lockFencingToken: 1, startedAt: new Date('2026-09-01T00:00:00Z') });
  await syncRunRepo.insert({ id: loId, job: 'j', trigger: 'MANUAL', lockId, lockFencingToken: 9, startedAt: new Date('2026-09-02T00:00:00Z') });
  const other = await syncRunRepo.insert({ job: 'j', trigger: 'MANUAL', lockId: 'sync:other', lockFencingToken: 1, startedAt: T0 });
  assert.equal(await syncRunRepo.markAbandoned(lockId, 5), 1);
  assert.equal((await syncRunRepo.get(hiId)).status, 'ABANDONED');
  assert.equal((await syncRunRepo.get(loId)).status, 'RUNNING');
  assert.equal((await syncRunRepo.get(other.id)).status, 'RUNNING');
  assert.deepEqual((await syncRunRepo.getMany([loId, hiId])).map((r) => r.id), [hiId, loId], 'business order = startedAt, although hiId > loId');
});

// ── raw responses ────────────────────────────────────────────────────────

test('rawResponseRepo stores gzipped bodies hashed on raw bytes, with per-reason TTL', async () => {
  const run = await syncRunRepo.insert({ job: 'j', trigger: 'FINALIZE', startedAt: T0 });
  const body = JSON.stringify({ current: [{ event: 5, points: 60 }] });
  const out = await rawResponseRepo.insert({ syncRunId: run.id, path: '/entry/1/history/', httpStatus: 200, contentType: 'application/json', body, reason: 'FINAL_EVIDENCE', capturedAt: T0 });
  assert.equal(out.stored, true);
  assert.equal(out.rawResponse.bodySha256, bodySha256(Buffer.from(body)));
  assert.equal(out.rawResponse.expireAt.getTime(), T0.getTime() + 14 * 86_400_000);
  assert.equal((await rawResponseRepo.getBody(out.rawResponse.id)).toString('utf8'), body);
  const stored = await raw('fplRawResponses').findOne({ _id: new mongoose.Types.ObjectId(out.rawResponse.id) });
  assert.equal(gunzipSync(stored.bodyGzip.buffer).toString('utf8'), body, 'stored gzipped');
  const schemaFail = await rawResponseRepo.insert({ syncRunId: run.id, path: '/x/', body: '{}', reason: 'SCHEMA_FAIL', capturedAt: T0 });
  assert.equal(schemaFail.rawResponse.expireAt.getTime(), T0.getTime() + 30 * 86_400_000);
  assert.deepEqual((await rawResponseRepo.listByRun(run.id)).map((r) => r.path), ['/entry/1/history/', '/x/']);

  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);
  const tooLarge = await rawResponseRepo.insert({ syncRunId: run.id, path: '/bootstrap-static/', body: big, reason: 'FINAL_EVIDENCE', capturedAt: T0 });
  assert.deepEqual(tooLarge, { stored: false, code: RAW_TOO_LARGE, bodySha256: bodySha256(big), bytesRaw: big.length });
  assert.equal(await raw('fplRawResponses').countDocuments({ path: '/bootstrap-static/' }), 0);
  await assert.rejects(rawResponseRepo.insert({ syncRunId: run.id, path: '/y/', body: '{}', reason: 'OTHER' }), /unknown raw response reason/);
});

// ── unit of work: T1–T4 methods refuse to run outside a transaction ─────

test('every transactional write refuses a missing or non-transaction session', async () => {
  const id = newId();
  const calls = {
    'groupRepo.setMembers': (o) => groupRepo.setMembers(id, [], o),
    'managerRepo.upsertProfiles': (o) => managerRepo.upsertProfiles([], ctx(), o),
    'seasonRepo.replaceTeamsAndChipRules': (o) => seasonRepo.replaceTeamsAndChipRules(seasonValue(), ctx(), o),
    'eventRepo.bulkUpsert': (o) => eventRepo.bulkUpsert([], ctx(), o),
    'managerGameweekRepo.bulkUpsertSeasonRows': (o) => managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 1, [], ctx(), o),
    'managerSeasonRepo.upsert': (o) => managerSeasonRepo.upsert({ season: SEASON, entryId: 1 }, ctx(), o),
    'syncRunRepo.unsetExpiry': (o) => syncRunRepo.unsetExpiry([], o),
    'rawResponseRepo.unsetEvidenceExpiry': (o) => rawResponseRepo.unsetEvidenceExpiry([], id, o),
  };
  const session = await mongoose.connection.startSession(); // a session, but no transaction
  try {
    for (const [name, call] of Object.entries(calls)) {
      await assert.rejects(call({}), new RegExp(`${name.replace('.', '\\.')} must run inside`), `${name} without session`);
      await assert.rejects(call({ session }), /must run inside/, `${name} outside a transaction`);
    }
  } finally {
    await session.endSession();
  }
});

test('a failed T3 rolls back every repository write in it', async () => {
  await assert.rejects(tx(async (session) => {
    await managerRepo.upsertProfiles([{ entryId: 701, playerName: 'X', teamName: 'Y' }], ctx(), { session });
    await managerSeasonRepo.upsert({ season: SEASON, entryId: 701, chips: [], transfers: [] }, ctx(), { session });
    await managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 701, [gwRow(701)], ctx(), { session });
    throw new Error('member fetch failed mid-way');
  }), /mid-way/);
  assert.equal(await managerRepo.get(701), null);
  assert.equal(await managerSeasonRepo.get(SEASON, 701), null);
  assert.deepEqual(await managerGameweekRepo.listForEntry(SEASON, 701), []);
});

test('a TransientTransactionError retry of T3 yields one net write with one change stamp', async () => {
  let attempts = 0;
  const r = ctx(30);
  const outs = [];
  await tx(async (session) => {
    attempts += 1;
    outs.push(await managerGameweekRepo.bulkUpsertSeasonRows(SEASON, 702, [gwRow(702)], r, { session }));
    if (attempts === 1) {
      const err = new mongoose.mongo.MongoServerError({ message: 'simulated transient error', code: 112 });
      err.addErrorLabel('TransientTransactionError');
      throw err;
    }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(outs.map((o) => o.inserted), [['2026-27:702:5'], ['2026-27:702:5']], 'the retry saw the rolled-back state');
  assert.equal(await raw('managerGameweeks').countDocuments({ entryId: 702 }), 1);
});

test('the lease fence guards repository writes: a stale holder commits nothing', async () => {
  const lockId = lockKeys.group(newId());
  const stale = await acquireLease(lockId, { ttlMs: 60_000 });
  await lockRepo.release(lockId, stale.owner); // lost behind its back (e.g. expiry + takeover)
  const fresh = await acquireLease(lockId, { ttlMs: 60_000 });
  await assert.rejects(tx(async (session) => {
    await stale.fence(session);
    await managerRepo.upsertProfiles([{ entryId: 703, playerName: 'S', teamName: 'S' }], ctx(), { session });
  }), LockLostError);
  assert.equal(await managerRepo.get(703), null);
  await tx(async (session) => {
    await fresh.fence(session);
    await managerRepo.upsertProfiles([{ entryId: 703, playerName: 'F', teamName: 'F' }], ctx(), { session });
  });
  assert.equal((await managerRepo.get(703)).playerName, 'F');
  await fresh.release();
});
