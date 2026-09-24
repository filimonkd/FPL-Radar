import express from 'express';
import { healthRouter } from './routes/health.js';

export function createApp({ config, version, getDbStatus }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter({ config, version, getDbStatus }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
