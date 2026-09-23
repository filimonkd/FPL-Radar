import { env } from './config/env.js';
import { connectDb, disconnectDb, getDbStatus } from './db/connection.js';
import { createApp } from './app.js';

if (!env.valid) {
  console.error('Invalid environment:\n  - ' + env.errors.join('\n  - '));
  process.exit(1);
}

const { port, mongodbUri } = env.config;

await connectDb(mongodbUri);
console.log('MongoDB connected');

const app = createApp({ env, getDbStatus });
const server = app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close();
  await disconnectDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
