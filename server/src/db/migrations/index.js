import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../utils/canonical.js';
import * as m001 from './001_collections_validators.js';
import * as m002 from './002_indexes.js';

// Migration runner (architecture v0.3 §11): numbered JS files with up(db),
// recorded in _migrations with a checksum and skipped once applied. A
// migration whose file changed after it was applied is refused.
// Boot and the CLI call runMigrationsLocked (./locked.js), which holds the
// 'migrate' lease; the runner itself stays safe without it because every
// migration is idempotent and the _migrations _id prevents a double record.

const file = (name) => fileURLToPath(new URL(`./${name}.js`, import.meta.url));

// Checksum of the migration source; line endings normalized so Windows and
// POSIX checkouts agree.
export const checksumOf = (name) => sha256(readFileSync(file(name), 'utf8').replace(/\r\n/g, '\n'));

export const MIGRATIONS = Object.freeze([
  { name: '001_collections_validators', up: m001.up },
  { name: '002_indexes', up: m002.up },
]);

export class MigrationChecksumError extends Error {
  constructor(name, recorded, current) {
    super(`migration ${name} changed after it was applied (recorded ${recorded}, now ${current})`);
    this.name = 'MigrationChecksumError';
  }
}

const DUPLICATE_KEY = 11000;

/** @param {import('mongodb').Db} db */
export async function runMigrations(db, { migrations = MIGRATIONS, now = () => new Date(), log = () => {} } = {}) {
  const applied = [];
  const skipped = [];
  for (const m of migrations) {
    const checksum = m.checksum ?? checksumOf(m.name);
    const record = await db.collection('_migrations').findOne({ _id: m.name });
    if (record) {
      if (record.checksum !== checksum) throw new MigrationChecksumError(m.name, record.checksum, checksum);
      skipped.push(m.name);
      continue;
    }
    await m.up(db);
    try {
      await db.collection('_migrations').insertOne({ _id: m.name, checksum, appliedAt: now() });
      applied.push(m.name);
      log(`migration ${m.name} applied`);
    } catch (err) {
      if (err.code !== DUPLICATE_KEY) throw err; // applied concurrently by another process
      skipped.push(m.name);
    }
  }
  return { applied, skipped, total: migrations.length };
}

/** Applied vs expected migrations, for GET /api/health (v0.3 §11 "migrations: n"). Read-only. */
export async function migrationStatus(db, { migrations = MIGRATIONS } = {}) {
  const records = await db.collection('_migrations').find({}, { projection: { _id: 1 } }).toArray();
  const applied = new Set(records.map((r) => r._id));
  const pending = migrations.map((m) => m.name).filter((n) => !applied.has(n));
  return { ok: pending.length === 0, applied: migrations.length - pending.length, expected: migrations.length, pending };
}
