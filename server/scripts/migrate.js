// npm run db:migrate — applies pending migrations (they also run on server boot).
import { loadEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import mongoose from 'mongoose';

const config = loadEnv();
await connectDb(config.MONGODB_URI, config.MONGODB_DB);
try {
  const r = await runMigrations(mongoose.connection.db, { log: console.log });
  console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} already applied (of ${r.total})`);
} finally {
  await disconnectDb();
}
