import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

// POST /api/internal/tick (architecture v0.3 §11): the cron-job.org pinger that
// keeps the Render free instance warm during GW windows. It only proves the
// process is awake; it starts no sync and touches no data. Authenticated by the
// X-Tick-Secret header (constant-time compare); without TICK_SECRET the route
// does not exist.

const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();

export function internalRouter({ tickSecret }) {
  const router = Router();
  if (!tickSecret) return router; // falls through to the /api 404
  const expected = digest(tickSecret);

  router.post('/tick', (req, res) => {
    const given = req.get('x-tick-secret');
    if (!given || !timingSafeEqual(digest(given), expected)) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'invalid tick secret' } });
    }
    res.set('Cache-Control', 'no-store').status(204).end();
  });
  return router;
}
