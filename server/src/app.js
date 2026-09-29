import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { groupsRouter } from './routes/groups.js';
import { resultsRouter } from './routes/results.js';
import { ownershipRouter } from './routes/ownership.js';
import { statusRouter } from './routes/status.js';
import { rivalsRouter } from './routes/rivals.js';
import { internalRouter } from './routes/internal.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';
import { groupRepo } from './repositories/index.js';

/**
 * @param {{ config, version, getDbStatus, getMigrationStatus?, getRuntime?, services?: { groups, results?, ownership?, status?, rivals? },
 *           loginLimit?, log?, clientDir? }} deps
 *   Without `services` only the health route is mounted (used by the health unit test).
 *   `clientDir`: the built client (client/dist). Production serves it from this
 *   same origin (v0.3 §11 "Express + built client"), so the SPA calls /api
 *   relatively and no CORS is configured: cross-origin browsers get no
 *   Access-Control-Allow-* headers and the admin cookie is SameSite=Strict.
 */
export function createApp({ config, version, getDbStatus, getMigrationStatus, getRuntime, services, loginLimit, log, clientDir }) {
  const app = express();

  app.disable('x-powered-by');
  if (config?.NODE_ENV === 'production') app.set('trust proxy', 1); // Render terminates TLS one hop in front
  app.use(helmet()); // CSP 'self', HSTS, nosniff, frame-ancestors 'none' …
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter({ config, version, getDbStatus, getMigrationStatus, getRuntime }));
  app.use('/api/internal', internalRouter({ tickSecret: config?.TICK_SECRET }));

  if (services) {
    app.use('/api', cookieParser(), authenticate({ jwtSecret: config.JWT_SECRET, groups: groupRepo }));
    app.use('/api/auth', authRouter({ config, loginLimit }));
    app.use('/api', groupsRouter({ groups: services.groups }));
    if (services.results) app.use('/api', resultsRouter({ results: services.results }));
    if (services.ownership) app.use('/api', ownershipRouter({ ownership: services.ownership }));
    if (services.status) app.use('/api', statusRouter({ status: services.status }));
    if (services.rivals) app.use('/api', rivalsRouter({ rivals: services.rivals }));
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  if (clientDir && existsSync(join(clientDir, 'index.html'))) {
    // Vite's hashed assets never change under a name; index.html always revalidates.
    app.use('/assets', express.static(join(clientDir, 'assets'), { immutable: true, maxAge: '1y', index: false }));
    app.use('/assets', (_req, res) => res.status(404).end()); // a missing asset is never the SPA shell
    app.use(express.static(clientDir, { index: false, maxAge: 0 }));
    app.get('/{*splat}', (_req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(join(clientDir, 'index.html'));
    });
  }

  app.use(errorHandler({ log }));

  return app;
}
