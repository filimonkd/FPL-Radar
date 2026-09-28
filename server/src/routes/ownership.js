import { Router } from 'express';
import { z } from 'zod';
import { requireGroupRead } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { objectIdParam, seasonKey } from '../validators/groups.js';
import { gwParam } from '../validators/results.js';

// Ownership API (architecture v0.2 §7, §14), read-only:
//   GET /api/groups/:groupId/gw/:gw/ownership?season=&view=picked|effective   admin / group viewer
//   GET /api/groups/:groupId/gw/:gw/transfers?season=                         admin / group viewer

const ownershipQuery = z.object({ season: seasonKey, view: z.enum(['picked', 'effective']).optional() });
const transfersQuery = z.object({ season: seasonKey });

const params = (req) => {
  const g = objectIdParam.safeParse(req.params.groupId);
  const gw = gwParam.safeParse(/^\d+$/.test(req.params.gw) ? Number(req.params.gw) : NaN);
  if (!g.success) throw notFound('group');
  if (!gw.success) throw notFound('gameweek');
  return { groupId: g.data, event: gw.data };
};

export function ownershipRouter({ ownership }) {
  const router = Router();

  router.get('/groups/:groupId/gw/:gw/ownership', requireGroupRead(), async (req, res) => {
    const { groupId, event } = params(req);
    const { season, view } = ownershipQuery.parse(req.query);
    res.json({ ownership: await ownership.getOwnership(groupId, season, event, { view }) });
  });

  router.get('/groups/:groupId/gw/:gw/transfers', requireGroupRead(), async (req, res) => {
    const { groupId, event } = params(req);
    const { season } = transfersQuery.parse(req.query);
    res.json({ transfers: await ownership.getTransfers(groupId, season, event) });
  });

  return router;
}
