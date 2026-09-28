// npm run db:migrate — applies pending migrations under the 'migrate' lease
// (they also run on server boot).
import { loadEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connection.js';
import { runMigrationsLocked } from '../src/db/migrations/locked.js';
import mongoose from 'mongoose';

const config = loadEnv();
await connectDb(config.MONGODB_URI, config.MONGODB_DB);
try {
  const r = await runMigrationsLocked(mongoose.connection.db, { log: console.log });
  console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} already applied (of ${r.total})`);
} finally {
  await disconnectDb();
}
