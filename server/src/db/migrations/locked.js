import { runMigrations } from './index.js';
import { withLease } from '../../locks/leaseLock.js';
import { lockKeys } from '../../locks/lockKeys.js';

// Boot/CLI entry point (architecture v0.3 §11): migrations run under the
// 'migrate' lease so two instances booting together apply them once. The
// second instance waits for the lease, then finds everything already applied.
// On a fresh database the lease document is created before migration 001
// installs the locks validator; 001 then collMods the existing collection.
export async function runMigrationsLocked(db, { waitMs = 60_000, ttlMs = 120_000, heartbeatMs = 30_000, ...opts } = {}) {
  return withLease(lockKeys.migrate(), () => runMigrations(db, opts), { waitMs, ttlMs, heartbeatMs });
}
