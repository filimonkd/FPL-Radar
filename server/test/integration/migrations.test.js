import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from '../helpers/memoryReplSet.js';
import { runMigrations, MIGRATIONS, checksumOf, MigrationChecksumError } from '../../src/db/migrations/index.js';
import { VALIDATORS, up as up001 } from '../../src/db/migrations/001_collections_validators.js';
import { INDEXES, up as up002 } from '../../src/db/migrations/002_indexes.js';

let t;
before(async () => { t = await startTestDb(); });
after(async () => { await t.stop(); });

const COLLECTIONS = ['groups', 'managers', 'seasons', 'events', 'players', 'managerGameweeks', 'managerSeasons', 'liveGameweeks',
  'syncRuns', 'fplRawResponses', 'resultSnapshots', 'gwResults', 'gwResultActions', 'locks', '_migrations'];

// Everything a migration can change: collection options (validators) and indexes.
async function schemaState(db) {
  const colls = (await db.listCollections().toArray()).sort((a, b) => a.name.localeCompare(b.name));
  const state = {};
  for (const c of colls) {
    const indexes = (await db.collection(c.name).listIndexes().toArray())
      .map(({ v, ...ix }) => ix)
      .sort((a, b) => a.name.localeCompare(b.name));
    state[c.name] = { options: c.options, indexes };
  }
  return state;
}

test('first run applies 001 and 002 on an empty database', async () => {
  const r = await runMigrations(t.db);
  assert.deepEqual(r.applied, ['001_collections_validators', '002_indexes']);
  assert.deepEqual(r.skipped, []);
  const records = await t.db.collection('_migrations').find().sort({ _id: 1 }).toArray();
  assert.deepEqual(records.map((m) => [m._id, m.checksum]), MIGRATIONS.map((m) => [m.name, checksumOf(m.name)]));
});

test('creates exactly the 15 v0.3 collections, each with a strict $jsonSchema validator', async () => {
  const colls = await t.db.listCollections().toArray();
  assert.deepEqual(colls.map((c) => c.name).sort(), [...COLLECTIONS].sort());
  assert.deepEqual(Object.keys(VALIDATORS).sort(), [...COLLECTIONS].sort());
  for (const c of colls) {
    assert.ok(c.options.validator?.$jsonSchema, `${c.name} has a validator`);
    assert.equal(c.options.validationLevel, 'strict', c.name);
    assert.equal(c.options.validationAction, 'error', c.name);
  }
});

test('creates exactly the 23 §13 secondary indexes (plus _id on every collection)', async () => {
  const state = await schemaState(t.db);
  let secondary = 0;
  for (const name of COLLECTIONS) {
    const names = state[name].indexes.map((i) => i.name);
    assert.ok(names.includes('_id_'), name);
    const expected = INDEXES[name].map((i) => i.name).sort();
    assert.deepEqual(names.filter((n) => n !== '_id_').sort(), expected, name);
    secondary += expected.length;
  }
  assert.equal(secondary, 23);
  const ix = (coll, n) => state[coll].indexes.find((i) => i.name === n);
  assert.deepEqual(ix('groups', 'fplLeagueId_unique_when_set').partialFilterExpression, { fplLeagueId: { $type: 'number' } });
  assert.equal(ix('gwResultActions', 'linear_chain_unique').unique, true);
  assert.equal(ix('locks', 'ttl_dead_leases').expireAfterSeconds, 86400);
  assert.equal(ix('syncRuns', 'ttl_expireAt').expireAfterSeconds, 0);
});

test('second run applies nothing and changes nothing', async () => {
  const before = await schemaState(t.db);
  const r = await runMigrations(t.db);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped, ['001_collections_validators', '002_indexes']);
  assert.deepEqual(await schemaState(t.db), before);
});

test('each up() is itself idempotent when re-executed directly', async () => {
  const before = await schemaState(t.db);
  await up001(t.db);
  await up002(t.db);
  assert.deepEqual(await schemaState(t.db), before);
});

test('001 reinstalls validators on existing collections (collMod path)', async () => {
  await t.db.command({ collMod: 'events', validator: {}, validationLevel: 'off' });
  await up001(t.db);
  const events = (await t.db.listCollections({ name: 'events' }).toArray())[0];
  assert.equal(events.options.validationLevel, 'strict');
  assert.ok(events.options.validator.$jsonSchema);
});

test('a migration edited after it was applied is refused', async () => {
  const tampered = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, checksum: `sha256:${'f'.repeat(64)}` } : m));
  await assert.rejects(runMigrations(t.db, { migrations: tampered }), MigrationChecksumError);
});
