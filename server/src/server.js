import { loadEnv } from './config/env.js';
import { connectDb, disconnectDb, getDbStatus } from './db/connection.js';
import { createApp } from './app.js';
import { version } from './version.js';
import { runMigrationsLocked } from './db/migrations/locked.js';
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

const app = createApp({ config, version, getDbStatus });
const server = app.listen(config.PORT, () => {
  console.log(`Server listening on http://localhost:${config.PORT}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function redactUri(uri) {
  return uri.replace(/\/\/[^@/]+@/, '//***@');
}
