import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { CONNECTION_OPTIONS, configureMongoose } from '../../src/db/connection.js';

// Integration test database (architecture v0.3 §11): a 1-node wiredTiger
// MongoMemoryReplSet on MongoDB 8.0.x (pinned in server/package.json
// config.mongodbMemoryServer.version), because transactions need a replica set.
// Set MONGODB_TEST_URI to use an existing replica set instead (e.g. the
// docker-compose rs0 when the mongod binary cannot be downloaded).
// Each test file gets its own throwaway database, dropped on stop().

export async function startTestDb() {
  let replSet = null;
  let uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    uri = replSet.getUri();
  }
  const dbName = `fpl_rival_test_${randomUUID().slice(0, 8)}`;
  configureMongoose();
  await mongoose.connect(uri, { ...CONNECTION_OPTIONS, dbName, serverSelectionTimeoutMS: 15_000 });
  return {
    db: mongoose.connection.db,
    dbName,
    async stop() {
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect();
      await replSet?.stop();
    },
  };
}
