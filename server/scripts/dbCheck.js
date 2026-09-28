// npm run db:check — read-only scan of invariants I1–I8 (architecture v0.3 §10).
// Prints the JSON report; exits 1 on any ERROR (or if it cannot connect), else 0.
// Connect as the read-only backup user; it never writes and never takes a lock.
import mongoose from 'mongoose';
import { envSchema } from '../src/config/env.js';
import { runDbCheck } from '../src/ops/dbCheck.js';
import { redact } from '../src/utils/redact.js';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;
const uriCheck = envSchema.shape.MONGODB_URI.safeParse(uri);
const dbCheck = envSchema.shape.MONGODB_DB.safeParse(dbName);
if (!uriCheck.success || !dbCheck.success) {
  console.error('db:check needs MONGODB_URI and MONGODB_DB (e.g. the backup-ro user and fpl_rival).');
  process.exit(1);
}

const client = new mongoose.mongo.MongoClient(uri, {
  readPreference: 'secondaryPreferred',
  serverSelectionTimeoutMS: 10_000,
  appName: 'fpl-rival-dbcheck',
});
let code = 1;
try {
  await client.connect();
  const report = await runDbCheck(client.db(dbName));
  console.log(JSON.stringify(report, null, 2));
  code = report.ok ? 0 : 1;
} catch (err) {
  console.error(`db:check failed: ${redact(err.message)}`);
} finally {
  await client.close().catch(() => {});
}
process.exit(code);
