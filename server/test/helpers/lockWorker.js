// Child process for multi-process lock tests: opens its own connection, waits
// for a shared start instant, races acquire (or runMigrationsLocked), and
// prints one JSON line. Env: TEST_URI, TEST_DB, LOCK_ID, START_AT, MODE, TTL_MS.
import mongoose from 'mongoose';
import { CONNECTION_OPTIONS, configureMongoose } from '../../src/db/connection.js';
import { tryAcquireLease } from '../../src/locks/leaseLock.js';
import { runMigrationsLocked } from '../../src/db/migrations/locked.js';

const { TEST_URI, TEST_DB, LOCK_ID, START_AT, MODE = 'acquire', TTL_MS = '60000' } = process.env;
configureMongoose();
await mongoose.connect(TEST_URI, { ...CONNECTION_OPTIONS, dbName: TEST_DB });
await mongoose.connection.db.admin().ping(); // warm the pool before the race
const wait = Number(START_AT) - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));

let out;
if (MODE === 'migrate') {
  const r = await runMigrationsLocked(mongoose.connection.db, { waitMs: 30_000, pollMs: 50 });
  out = { applied: r.applied, skipped: r.skipped };
} else {
  const lease = await tryAcquireLease(LOCK_ID, { ttlMs: Number(TTL_MS) });
  out = { acquired: Boolean(lease), token: lease?.fencingToken ?? null, owner: lease ? String(lease.owner) : null };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
await mongoose.disconnect();
