import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { withTransaction, TRANSACTION_OPTIONS } from '../../src/db/unitOfWork.js';
import * as M from '../../src/models/index.js';
import { docs } from '../helpers/docs.js';

let t;
before(async () => { t = await startTestDb(); await runMigrations(t.db); });
after(async () => { await t.stop(); });

test('uses the v0.3 §5 transaction settings', () => {
  assert.deepEqual(TRANSACTION_OPTIONS, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 10_000 });
});

test('commits a multi-document write atomically and returns the callback result', async () => {
  const result = await withTransaction(async (session) => {
    await M.Manager.create([docs.manager({ entryId: 1 })], { session });
    await M.ManagerSeason.create([docs.managerSeason({ entryId: 1 })], { session });
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(await M.Manager.countDocuments({ _id: 1 }), 1);
  assert.equal(await M.ManagerSeason.countDocuments({ entryId: 1 }), 1);
});

test('rolls back every write when the callback throws', async () => {
  await assert.rejects(withTransaction(async (session) => {
    await M.Manager.create([docs.manager({ entryId: 2 })], { session });
    await M.ManagerSeason.create([docs.managerSeason({ entryId: 2 })], { session });
    throw new Error('boom');
  }), /boom/);
  assert.equal(await M.Manager.countDocuments({ _id: 2 }), 0);
  assert.equal(await M.ManagerSeason.countDocuments({ entryId: 2 }), 0);
});

test('a validation failure inside the transaction rolls back earlier writes', async () => {
  await assert.rejects(withTransaction(async (session) => {
    await M.Manager.create([docs.manager({ entryId: 3 })], { session });
    await M.ManagerGameweek.create([docs.managerGameweek({ entryId: 3, hasPicks: false })], { session }); // invalid
  }), /hasPicks/);
  assert.equal(await M.Manager.countDocuments({ _id: 3 }), 0);
});

test('TransientTransactionError is retried once and yields a single net write', async () => {
  let attempts = 0;
  await withTransaction(async (session) => {
    attempts += 1;
    // Idempotent upsert on a deterministic _id, as v0.3 §5 requires.
    await M.Manager.updateOne({ _id: 4 }, { $set: { entryId: 4, playerName: 'M4', teamName: 'T4', provenance: docs.manager().provenance } }, { upsert: true, session });
    if (attempts === 1) {
      const err = new mongoose.mongo.MongoServerError({ message: 'simulated transient error', code: 112 });
      err.addErrorLabel('TransientTransactionError');
      throw err;
    }
  });
  assert.equal(attempts, 2);
  assert.equal(await M.Manager.countDocuments({ _id: 4 }), 1);
});

test('uncommitted writes are invisible outside the transaction (snapshot isolation)', async () => {
  let seenOutside;
  await withTransaction(async (session) => {
    await M.Manager.create([docs.manager({ entryId: 5 })], { session });
    seenOutside = await M.Manager.countDocuments({ _id: 5 }); // no session
  });
  assert.equal(seenOutside, 0);
  assert.equal(await M.Manager.countDocuments({ _id: 5 }), 1);
});
