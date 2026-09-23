import { Router } from 'express';

export function healthRouter({ env, getDbStatus }) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const db = await getDbStatus();
    const envCheck = env.valid ? { ok: true } : { ok: false, errors: env.errors };
    const ok = db.ok && envCheck.ok;

    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
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
