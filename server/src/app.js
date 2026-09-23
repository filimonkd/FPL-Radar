import express from 'express';
import { healthRouter } from './routes/health.js';

export function createApp({ env, getDbStatus }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());

  app.use('/api/health', healthRouter({ env, getDbStatus }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
