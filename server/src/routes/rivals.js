import { Router } from 'express';
import { z } from 'zod';
import { requireGroupRead } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { objectIdParam, seasonKey } from '../validators/groups.js';
import { gwParam } from '../validators/results.js';

// Rivals API (Step 16), read-only:
//   GET /api/groups/:groupId/gw/:gw/rivals?season=   admin / group viewer

const rivalsQuery = z.object({ season: seasonKey });

export function rivalsRouter({ rivals }) {
  const router = Router();
  router.get('/groups/:groupId/gw/:gw/rivals', requireGroupRead(), async (req, res) => {
    const g = objectIdParam.safeParse(req.params.groupId);
    const gw = gwParam.safeParse(/^\d+$/.test(req.params.gw) ? Number(req.params.gw) : NaN);
    if (!g.success) throw notFound('group');
    if (!gw.success) throw notFound('gameweek');
    const { season } = rivalsQuery.parse(req.query);
    res.json({ rivals: await rivals.getRivals(g.data, season, gw.data) });
  });
  return router;
}
