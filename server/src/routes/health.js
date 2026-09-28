import { Router } from 'express';
import { envSchema } from '../config/env.js';

// GET /api/health (v0.3 §11): Render's health check. 200 { status: 'ok' } only
// when the DB answers a ping, every migration is applied, the config validates
// and the process is not shutting down; otherwise 503 'degraded'. Recovery is
// automatic: each request re-evaluates every check. No secrets or identifiers
// are reported, only states and counts.
export function healthRouter({ config, version, getDbStatus, getMigrationStatus, getRuntime }) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const db = await getDbStatus();
    const envResult = envSchema.safeParse(config);
    const envCheck = envResult.success
      ? { ok: true }
      : { ok: false, errors: envResult.error.issues.map((i) => i.path.join('.')) };
    const checks = {
      process: { ok: true, pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
      mongodb: db,
      env: envCheck,
    };
    if (getMigrationStatus) checks.migrations = db.ok ? await getMigrationStatus() : { ok: false, state: 'unknown' };
    if (getRuntime) {
      const { shuttingDown = false, activeRuns = 0 } = getRuntime();
      checks.runtime = { ok: !shuttingDown, shuttingDown, activeRuns, lockHeld: activeRuns > 0 };
    }
    const ok = Object.values(checks).every((c) => c.ok);

    res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      version,
      env: config?.NODE_ENV,
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  return router;
}
