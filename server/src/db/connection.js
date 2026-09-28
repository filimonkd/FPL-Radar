import mongoose from 'mongoose';

// One Mongoose connection per process (architecture v0.3 §11).
// Indexes and validators come only from migrations (autoIndex/autoCreate off),
// commands fail fast when the DB is down (bufferCommands off), unknown fields
// are errors (strict: 'throw' on every schema), and queries get a default
// maxTimeMS of 5 s (db/queryDefaults.js, attached by models/shared.js).

export const CONNECTION_OPTIONS = Object.freeze({
  maxPoolSize: 10,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  retryWrites: true,
  retryReads: true,
  w: 'majority',
  appName: 'fpl-rival-dashboard',
  autoIndex: false,
  autoCreate: false,
});

export { DEFAULT_MAX_TIME_MS } from './queryDefaults.js';

let configured = false;
export function configureMongoose() {
  if (configured) return;
  mongoose.set('strictQuery', true);
  mongoose.set('bufferCommands', false);
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  configured = true;
}

export async function connectDb(uri, dbName) {
  configureMongoose();
  await mongoose.connect(uri, { ...CONNECTION_OPTIONS, dbName });
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

// Reports the live state of the MongoDB connection, including a round-trip ping.
export async function getDbStatus() {
  const { readyState } = mongoose.connection;
  const state = READY_STATES[readyState] ?? 'unknown';
  if (readyState !== 1) return { ok: false, state };

  try {
    await mongoose.connection.db.admin().ping();
    return { ok: true, state };
  } catch (err) {
    return { ok: false, state, error: err.message };
  }
}
