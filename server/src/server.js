import { loadEnv } from './config/env.js';
import { connectDb, disconnectDb, getDbStatus, getMigrationStatus } from './db/connection.js';
import { createApp } from './app.js';
import { version } from './version.js';
import { runMigrationsLocked } from './db/migrations/locked.js';
import { createFplClient } from './fpl/index.js';
import { createSyncService } from './sync/index.js';
import { createGroupService } from './services/groupService.js';
import { createResultService } from './services/resultService.js';
import { createOwnershipService } from './services/ownershipService.js';
import { createStatusService } from './services/statusService.js';
import { createRivalsService } from './services/rivalsService.js';
import { createPlayersService } from './services/playersService.js';
import { createNewsService } from './services/newsService.js';
import { createFinderService } from './services/finderService.js';
import { createTransferService } from './services/transferService.js';
import { createShutdown } from './shutdown.js';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { redact, redactError } from './utils/redact.js';

const config = loadEnv();

try {
  await connectDb(config.MONGODB_URI, config.MONGODB_DB);
} catch (err) {
  console.error(
    `Cannot connect to MongoDB at ${redact(config.MONGODB_URI)}: ${redact(err.cause?.message ?? err.message)}\n` +
      (config.NODE_ENV === 'production'
        ? '  Check that the Atlas Network Access list holds every Render Outbound IP range (docs/DEPLOYMENT.md §3), the cluster is not paused, and MONGODB_URI uses the app user.'
        : '  Is the database running? Start it with `npm run db:up` (Docker must be running), then check with `npm run db:ping`.'),
  );
  process.exit(1);
}
console.log(`MongoDB connected (db: ${config.MONGODB_DB})`);

// Boot-time migrations under the 'migrate' lease (v0.3 §11).
let migrations;
try {
  migrations = await runMigrationsLocked(mongoose.connection.db, { log: console.log });
} catch (err) {
  console.error(`Boot migrations failed: ${redactError(err)}`);
  await disconnectDb().catch(() => {});
  process.exit(1);
}
console.log(`Migrations: ${migrations.applied.length} applied, ${migrations.skipped.length} already applied`);
if (!config.ADMIN_PASSWORD_HASH) console.warn('ADMIN_PASSWORD_HASH is not set: admin login is disabled (create one with `npm run auth:hash`).');

const fplClient = createFplClient({ baseUrl: config.FPL_API_BASE_URL });
const sync = createSyncService({ client: fplClient });
const groups = createGroupService({ sync });
const results = createResultService({ sync });
const ownership = createOwnershipService();
const status = createStatusService();
const rivals = createRivalsService({ ownership, status });
const players = createPlayersService({ sync });
const news = createNewsService({ players });
const finder = createFinderService({ players });
const transfers = createTransferService({ players });

const app = createApp({
  config,
  version,
  getDbStatus,
  getMigrationStatus,
  getRuntime: () => ({ shuttingDown: sync.shuttingDown, activeRuns: sync.activeRuns.length }),
  services: { groups, results, ownership, status, rivals, players, news, finder, transfers },
  log: console.error,
  // The built client (npm run build → client/dist), served from the API's origin.
  clientDir: fileURLToPath(new URL('../../client/dist/', import.meta.url)),
});
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

// Last resort: log redacted and exit non-zero so Render restarts the instance;
// any lease this process held expires on its own (v0.3 §5 crash recovery).
process.on('unhandledRejection', (err) => {
  console.error(`unhandledRejection: ${redactError(err)}`);
  process.exit(1);
});