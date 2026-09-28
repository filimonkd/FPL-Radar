import express from 'express';
import cookieParser from 'cookie-parser';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { groupsRouter } from './routes/groups.js';
import { resultsRouter } from './routes/results.js';
import { ownershipRouter } from './routes/ownership.js';
import { statusRouter } from './routes/status.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';
import { groupRepo } from './repositories/index.js';

/**
 * @param {{ config, version, getDbStatus, services?: { groups, results?, ownership?, status? }, loginLimit?, log? }} deps
 *   Without `services` only the health route is mounted (used by the health unit test).
 */
export function createApp({ config, version, getDbStatus, services, loginLimit, log }) {
  const app = express();

  app.disable('x-powered-by');
  if (config?.NODE_ENV === 'production') app.set('trust proxy', 1); // Render terminates TLS in front
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter({ config, version, getDbStatus }));

  if (services) {
    app.use('/api', cookieParser(), authenticate({ jwtSecret: config.JWT_SECRET, groups: groupRepo }));
    app.use('/api/auth', authRouter({ config, loginLimit }));
    app.use('/api', groupsRouter({ groups: services.groups }));
    if (services.results) app.use('/api', resultsRouter({ results: services.results }));
    if (services.ownership) app.use('/api', ownershipRouter({ ownership: services.ownership }));
    if (services.status) app.use('/api', statusRouter({ status: services.status }));
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  app.use(errorHandler({ log }));

  return app;
}
