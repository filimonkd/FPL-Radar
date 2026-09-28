import { loadEnv } from './config/env.js';
import { connectDb, disconnectDb, getDbStatus } from './db/connection.js';
import { createApp } from './app.js';
import { version } from './version.js';
import { runMigrationsLocked } from './db/migrations/locked.js';
import { createFplClient } from './fpl/index.js';
import { createSyncService } from './sync/index.js';
import { createGroupService } from './services/groupService.js';
import { createResultService } from './services/resultService.js';
import { createOwnershipService } from './services/ownershipService.js';
import { createShutdown } from './shutdown.js';
import mongoose from 'mongoose';

const config = loadEnv();

try {
  await connectDb(config.MONGODB_URI, config.MONGODB_DB);
} catch (err) {
  console.error(
    `Cannot connect to MongoDB at ${redactUri(config.MONGODB_URI)}: ${err.cause?.message ?? err.message}\n` +
      '  Is the database running? Start it with `npm run db:up` (Docker must be running), then check with `npm run db:ping`.',
  );
  process.exit(1);
}
console.log(`MongoDB connected (db: ${config.MONGODB_DB})`);

// Boot-time migrations under the 'migrate' lease (v0.3 §11).
const migrations = await runMigrationsLocked(mongoose.connection.db, { log: console.log });
console.log(`Migrations: ${migrations.applied.length} applied, ${migrations.skipped.length} already applied`);
if (!config.ADMIN_PASSWORD_HASH) console.warn('ADMIN_PASSWORD_HASH is not set: admin login is disabled (create one with `npm run auth:hash`).');

const fplClient = createFplClient({ baseUrl: config.FPL_API_BASE_URL });
const sync = createSyncService({ client: fplClient });
const groups = createGroupService({ sync });
const results = createResultService({ sync });
const ownership = createOwnershipService();

const app = createApp({ config, version, getDbStatus, services: { groups, results, ownership } });
const server = app.listen(config.PORT, () => {
  console.log(`Server listening on http://localhost:${config.PORT}`);
});

// SIGTERM / SIGINT (v0.3 §11): stop accepting requests, abandon and release the
// runs this process holds, disconnect. Idempotent; a second signal is ignored.
const shutdown = createShutdown({
  server,
  sync,
  disconnect: disconnectDb,
  closeClient: () => fplClient.close(),
  log: console.log,
  exit: (code) => process.exit(code),
});
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function redactUri(uri) {
  return uri.replace(/\/\/[^@/]+@/, '//***@');
}
