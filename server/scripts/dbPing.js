// npm run db:ping — verifies the local MongoDB is the rs0 replica set on server 8.0.x.
import mongoose from 'mongoose';
import { envSchema } from '../src/config/env.js';
import { envSourceHint, describeValue } from '../src/config/envSource.js';

const uri = process.env.MONGODB_URI;
const hint = envSourceHint('MONGODB_URI');
if (!uri) {
  console.error('MONGODB_URI is required (copy .env.example to .env).');
  process.exit(1);
}
const check = envSchema.shape.MONGODB_URI.safeParse(uri);
if (!check.success) {
  console.error(`MONGODB_URI ${check.error.issues[0].message}; the value in use ${describeValue(uri)}.`);
  if (hint) console.error(hint);
  process.exit(1);
}

const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
let code = 1;
try {
  await client.connect();
  const admin = client.db('admin');
  const hello = await admin.command({ hello: 1 });
  const { version } = await admin.command({ buildInfo: 1 });
  const report = { setName: hello.setName ?? null, isWritablePrimary: hello.isWritablePrimary, version };
  console.log(JSON.stringify(report));
  code = report.setName === 'rs0' && version.startsWith('8.0.') ? 0 : 1;
  if (code) console.error('Expected setName "rs0" and server version 8.0.x');
} catch (err) {
  console.error(`db:ping failed: ${err.message}`);
} finally {
  await client.close().catch(() => {});
}
process.exit(code);
