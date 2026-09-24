import mongoose from 'mongoose';

// Minimal Step 0 connection used by /api/health. The full §11 option set
// (pool size, bufferCommands, autoIndex, ...) arrives with Step 4.

const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

export async function connectDb(uri, dbName) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

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
