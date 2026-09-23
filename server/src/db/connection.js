import mongoose from 'mongoose';

const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

export async function connectDb(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
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
