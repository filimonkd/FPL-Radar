import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import * as M from '../../src/models/index.js';
import { ids } from '../../src/db/ids.js';
import { docs, GROUP_ID, picks15 } from '../helpers/docs.js';

let t;
before(async () => { t = await startTestDb(); await runMigrations(t.db); });
after(async () => { await t.stop(); });

const DOCUMENT_VALIDATION_FAILED = 121;
const raw = (coll) => t.db.collection(coll);

// model, doc factory, expected deterministic _id (null = ObjectId)
const CASES = [
  ['Group', docs.group, null],
  ['Manager', docs.manager, 100001],
  ['Season', docs.season, '2026-27'],
  ['Event', docs.event, '2026-27:5'],
  ['Player', docs.player, '2026-27:351'],
  ['ManagerGameweek', docs.managerGameweek, '2026-27:100001:5'],
  ['ManagerSeason', docs.managerSeason, '2026-27:100001'],
  ['LiveGameweek', docs.liveGameweek, '2026-27:5'],
  ['SyncRun', docs.syncRun, null],
  ['FplRawResponse', docs.rawResponse, null],
  ['ResultSnapshot', docs.resultSnapshot, null],
  ['GwResult', docs.gwResult, `${GROUP_ID}:2026-27:5`],
  ['GwResultAction', docs.gwResultAction, null],
  ['Lock', docs.lock, `sync:group:${GROUP_ID}`],
  ['Migration', docs.migration, '999_test'],
];

test('validator round trip: every model saves through Mongoose and the DB validator, and reads back', async () => {
  for (const [name, make, expectedId] of CASES) {
    const saved = await M[name].create(make());
    if (expectedId !== null) assert.equal(saved._id, expectedId, `${name} deterministic _id`);
    const back = await M[name].findById(saved._id).lean();
    assert.ok(back, `${name} reads back`);
  }
});

test('integers are stored as BSON int, prices as integer tenths', async () => {
  assert.equal(await raw('managerGameweeks').countDocuments({ event: { $type: 'int' }, 'points.netGwPoints': { $type: 'int' }, bankTenths: { $type: 'int' } }), 1);
  assert.equal(await raw('players').countDocuments({ priceTenths: { $type: 'int' } }), 1);
  assert.equal(await raw('managers').countDocuments({ _id: { $type: 'int' } }), 1);
});

test('deterministic ids match db/ids.js and a mismatching _id is rejected', async () => {
  assert.equal((await M.Event.create(docs.event({ gw: 6 })))._id, ids.event('2026-27', 6));
  await assert.rejects(M.Event.create(docs.event({ _id: '2026-27:9', gw: 7 })), /_id 2026-27:9 != 2026-27:7/);
  await assert.rejects(M.ManagerGameweek.create(docs.managerGameweek({ _id: '2026-27:1:1', event: 8 })), /!= 2026-27:100001:8/);
});

test('points semantics: season defaults to UNVERIFIED; CONFLICTED is storable; nothing assumes gross/net', async () => {
  await raw('seasons').deleteMany({});
  const s = await M.Season.create(docs.season());
  assert.equal(s.pointsSemantics.value, 'UNVERIFIED');
  assert.equal((await raw('seasons').findOne({ _id: '2026-27' })).pointsSemantics.value, 'UNVERIFIED');
  await raw('seasons').updateOne({ _id: '2026-27' }, { $set: { 'pointsSemantics.value': 'CONFLICTED', 'pointsSemantics.conflictRows': 1 } });
  assert.equal((await M.Season.findById('2026-27').lean()).pointsSemantics.value, 'CONFLICTED');
  const unverifiedRow = docs.managerGameweek({ event: 9 });
  unverifiedRow.points = { ...unverifiedRow.points, pointsSemantics: 'UNVERIFIED', transferCost: 0, reportedGwPoints: 60, netGwPoints: 60, grossGwPoints: 60, reconciliationStatus: 'RECONCILED_NO_COST' };
  await M.ManagerGameweek.create(unverifiedRow);
});

test('tieBreakRules: default is the v0.2 chain; only documented rules persist; SHARED must be last', async () => {
  const g = await M.Group.create(docs.group({ slug: 'defaults', fplLeagueId: 900101 }));
  assert.deepEqual([...g.tieBreakRules], ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED']);
  await assert.rejects(M.Group.create(docs.group({ slug: 'inferred', fplLeagueId: 900102, tieBreakRules: ['BETTER_OVERALL_RANK', 'SHARED'] })), /tieBreakRules/);
  await assert.rejects(M.Group.create(docs.group({ slug: 'no-shared', fplLeagueId: 900103, tieBreakRules: ['FEWER_TRANSFER_COST'] })), /SHARED/);
  // DB layer: an inferred rule is rejected even when Mongoose is bypassed.
  await assert.rejects(raw('groups').insertOne({ ...docs.group({ slug: 'raw-inferred', fplLeagueId: 900104 }), tieBreakRules: ['FEWER_POINTS_ON_BENCH', 'SHARED'], isActive: true }), (e) => e.code === DOCUMENT_VALIDATION_FAILED);
});

test('Mongoose rejects invalid documents', async () => {
  const cases = [
    [M.Group, docs.group({ slug: 'x1', fplLeagueId: null }), /fplLeagueId required/],
    [M.Group, docs.group({ slug: 'x2', fplLeagueId: 900201, members: [{ entryId: 1, addedAt: new Date() }, { entryId: 1, addedAt: new Date() }] }), /duplicate member/],
    [M.Group, docs.group({ slug: 'x3', fplLeagueId: 900202, unknownField: 1 }), /not in schema|strict/i],
    [M.Event, docs.event({ gw: 11, state: 'FINALIZED' }), /state/],
    [M.ManagerGameweek, docs.managerGameweek({ event: 20, picks: picks15().slice(0, 14) }), /expected 15 picks/],
    [M.ManagerGameweek, docs.managerGameweek({ event: 21, picks: picks15().map((p) => ({ ...p, isCaptain: true })) }), /expected 1 captain/],
    [M.ManagerGameweek, docs.managerGameweek({ event: 22, hasPicks: false }), /picks present but hasPicks=false/],
    [M.ManagerGameweek, (() => { const d = docs.managerGameweek({ event: 23 }); d.points = { ...d.points, reconciliationStatus: 'MISMATCH' }; return d; })(), /net\/gross must be null unless reconciled/],
    [M.ManagerGameweek, (() => { const d = docs.managerGameweek({ event: 24 }); d.points = { ...d.points, netGwPoints: null }; return d; })(), /net\/gross must be null unless reconciled/],
    [M.Player, docs.player({ elementId: 2, priceTenths: 7.5 }), /integer/],
    [M.GwResultAction, docs.gwResultAction({ seq: 2, action: 'OVERRIDE', note: '  ', prevHash: `sha256:${'c'.repeat(64)}` }), /override requires a note/],
    [M.GwResultAction, docs.gwResultAction({ seq: 2, prevHash: 'GENESIS' }), /prevHash/],
    [M.SyncRun, docs.syncRun({ status: 'DONE' }), /status/],
  ];
  for (const [model, doc, re] of cases) await assert.rejects(model.create(doc), re, `${model.modelName}: ${re}`);
});

test('the DB validator rejects invalid documents that bypass Mongoose', async () => {
  const rejects = async (coll, doc, label) =>
    assert.rejects(raw(coll).insertOne(doc), (e) => e.code === DOCUMENT_VALIDATION_FAILED, label);
  const mgw = (points, extra = {}) => ({ _id: '2026-27:100009:5', season: '2026-27', entryId: 100009, event: 5, hasPicks: false, picks: [], provenance: docs.managerGameweek().provenance, points: { reportedGwPoints: 70, transferCost: 4, totalPoints: 331, pointsSemantics: 'UNVERIFIED', ...points }, ...extra });
  await rejects('managerGameweeks', mgw({ reconciliationStatus: 'RECONCILED', netGwPoints: null, grossGwPoints: null }), 'reconciled needs net/gross');
  await rejects('managerGameweeks', mgw({ reconciliationStatus: 'MISMATCH', netGwPoints: 66, grossGwPoints: 70 }), 'unreconciled must be null');
  await rejects('managerGameweeks', mgw({ reconciliationStatus: 'RECONCILED', netGwPoints: 66, grossGwPoints: 70, pointsSemantics: 'GROSS' }), 'semantics enum');
  await rejects('managerGameweeks', mgw({ reconciliationStatus: 'INCOMPLETE', netGwPoints: null, grossGwPoints: null }, { hasPicks: true, picks: [] }), 'hasPicks needs 15');
  const { _id, ...group } = { ...docs.group({ slug: 'raw-league', fplLeagueId: undefined }), isActive: true, tieBreakRules: ['SHARED'] };
  delete group.fplLeagueId;
  await rejects('groups', group, 'league id required unless MANUAL');
  await raw('groups').insertOne({ ...group, slug: 'raw-manual', memberSource: 'MANUAL' }); // allowed for MANUAL
  await rejects('gwResultActions', { ...docs.gwResultAction({ seq: 7, action: 'OVERRIDE' }), note: null }, 'override needs note');
  await rejects('events', { ...docs.event({ gw: 30 }), _id: '2026-27:30', state: 'DONE' }, 'event state enum');
  await rejects('seasons', { ...docs.season({ season: '2027-28' }), _id: '2027-28', pointsSemantics: { value: 'GROSS', evidenceRows: 0, conflictRows: 0 } }, 'season semantics enum');
  await rejects('fplRawResponses', docs.rawResponse({ bytesRaw: 3_000_000 }), 'raw body over 2 MB');
  await rejects('syncRuns', docs.syncRun({ requests: Array.from({ length: 301 }, () => ({ path: '/x', durationMs: 1 })) }), 'request log cap');
});

test('append-only: snapshots and actions reject every update/delete path; inserts work', async () => {
  const snap = await M.ResultSnapshot.findOne();
  const action = await M.GwResultAction.findOne();
  for (const [Model, id] of [[M.ResultSnapshot, snap._id], [M.GwResultAction, action._id]]) {
    const attempts = [
      () => Model.updateOne({ _id: id }, { $set: { season: '2027-28' } }),
      () => Model.updateMany({}, { $set: { season: '2027-28' } }),
      () => Model.findOneAndUpdate({ _id: id }, { $set: { season: '2027-28' } }),
      () => Model.replaceOne({ _id: id }, {}),
      () => Model.findOneAndReplace({ _id: id }, {}),
      () => Model.deleteOne({ _id: id }),
      () => Model.deleteMany({}),
      () => Model.findOneAndDelete({ _id: id }),
      () => Model.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: { season: '2027-28' } } } }]),
      async () => { const d = await Model.findById(id); d.season = '2027-28'; await d.save(); },
      async () => { const d = await Model.findById(id); await d.deleteOne(); },
    ];
    for (const attempt of attempts) await assert.rejects(attempt(), { name: 'ImmutableCollectionError' }, Model.modelName);
    assert.equal(await Model.countDocuments({ season: '2027-28' }), 0);
  }
  await M.GwResultAction.bulkWrite([{ insertOne: { document: docs.gwResultAction({ seq: 2, prevHash: `sha256:${'d'.repeat(64)}` }) } }]);
});

test('queries get the default maxTimeMS (5 s) unless they set their own', async () => {
  const q = M.Event.find({});
  await q.exec();
  assert.equal(q.getOptions().maxTimeMS, 5000);
  const own = M.Event.find({}).maxTimeMS(1234);
  await own.exec();
  assert.equal(own.getOptions().maxTimeMS, 1234);
  assert.equal(mongoose.get('bufferCommands'), false);
});
