import { Router } from 'express';
import { z } from 'zod';
import { requireGroupRead } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { objectIdParam, seasonKey } from '../validators/groups.js';
import { gwParam } from '../validators/results.js';
import { FINDER_SORTS, POSITIONS } from '../analytics/finder.js';

// Differential & value finder API (Step 19), read-only:
//   GET /api/groups/:groupId/gw/:gw/finder?season=&position=&maxPrice=&maxOwnership=&maxGroupOwners=&fit=&sort=&limit=
//   admin / group viewer. maxPrice in £m (6.5), maxOwnership in % (10).

const finderQuery = z.object({
  season: seasonKey,
  position: z.enum(POSITIONS).optional(),
  maxPrice: z.coerce.number().min(3).max(20).optional(),
  maxOwnership: z.coerce.number().min(0).max(100).optional(),
  maxGroupOwners: z.coerce.number().int().min(0).max(1000).optional(),
  fit: z.enum(['true', 'false']).optional(),
  sort: z.enum(FINDER_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function finderRouter({ finder }) {
  const router = Router();
  router.get('/groups/:groupId/gw/:gw/finder', requireGroupRead(), async (req, res) => {
    const g = objectIdParam.safeParse(req.params.groupId);
    const gw = gwParam.safeParse(/^\d+$/.test(req.params.gw) ? Number(req.params.gw) : NaN);
    if (!g.success) throw notFound('group');
    if (!gw.success) throw notFound('gameweek');
    const q = finderQuery.parse(req.query);
    const filters = {
      ...(q.position ? { position: q.position } : {}),
      ...(q.maxPrice != null ? { maxPriceTenths: Math.round(q.maxPrice * 10) } : {}),
      ...(q.maxOwnership != null ? { maxSelectedByTenths: Math.round(q.maxOwnership * 10) } : {}),
      ...(q.maxGroupOwners != null ? { maxGroupOwners: q.maxGroupOwners } : {}),
      ...(q.fit === 'true' ? { fitOnly: true } : {}),
    };
    res.json({ finder: await finder.find(g.data, q.season, gw.data, { filters, sort: q.sort ?? 'value', limit: q.limit ?? 50 }) });
  });
  return router;
}
