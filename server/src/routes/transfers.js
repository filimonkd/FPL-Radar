import { Router } from 'express';
import { z } from 'zod';
import { requireGroupRead } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { objectIdParam, seasonKey } from '../validators/groups.js';

// Transfer simulator API (Step 20), read-only, admin / group viewer. Always
// from FPL's current GW and the group's "me" squad:
//   GET /api/groups/:groupId/transfer-plan?season=
//   GET /api/groups/:groupId/transfer-sim?season=&out=&in=&hit=true|false

const planQuery = z.object({ season: seasonKey });
const simQuery = z.object({
  season: seasonKey,
  out: z.coerce.number().int().min(1),
  in: z.coerce.number().int().min(1),
  hit: z.enum(['true', 'false']).optional(),
});

export function transfersRouter({ transfers }) {
  const router = Router();
  const group = (req) => {
    const g = objectIdParam.safeParse(req.params.groupId);
    if (!g.success) throw notFound('group');
    return g.data;
  };
  router.get('/groups/:groupId/transfer-plan', requireGroupRead(), async (req, res) => {
    const { season } = planQuery.parse(req.query);
    res.json({ plan: await transfers.plan(group(req), season) });
  });
  router.get('/groups/:groupId/transfer-sim', requireGroupRead(), async (req, res) => {
    const q = simQuery.parse(req.query);
    res.json({ sim: await transfers.simulate(group(req), q.season, { outId: q.out, inId: q.in, hit: q.hit !== 'false' }) });
  });
  return router;
}
