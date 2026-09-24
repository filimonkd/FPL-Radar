import { Router } from 'express';
import { envSchema } from '../config/env.js';

export function healthRouter({ config, version, getDbStatus }) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const db = await getDbStatus();
    const envResult = envSchema.safeParse(config);
    const envCheck = envResult.success
      ? { ok: true }
      : { ok: false, errors: envResult.error.issues.map((i) => i.path.join('.')) };
    const ok = db.ok && envCheck.ok;

    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      version,
      env: config?.NODE_ENV,
      timestamp: new Date().toISOString(),
      checks: {
        process: { ok: true, pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
        mongodb: db,
        env: envCheck,
      },
    });
  });

  return router;
}
