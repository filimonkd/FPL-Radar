import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireGroupRead, requireSignedIn } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { objectIdParam, seasonKey } from '../validators/groups.js';

// Chips page and Status page API (v0.2 §8; v0.3 §15 step 11). Read-only.
//   GET /api/groups/:groupId/chips?season=&event=   admin / group viewer
//   GET /api/seasons/:season/events                 any signed-in principal (public FPL state)
//   GET /api/status?season=                         admin
//   GET /api/status/runs/:runId                     admin (full request log)

const chipsQuery = z.object({ season: seasonKey, event: z.coerce.number().int().min(1).max(38).optional() });
const statusQuery = z.object({ season: seasonKey, limit: z.coerce.number().int().min(1).max(100).optional() });

export function statusRouter({ status }) {
  const router = Router();

  router.get('/groups/:groupId/chips', requireGroupRead(), async (req, res) => {
    const g = objectIdParam.safeParse(req.params.groupId);
    if (!g.success) throw notFound('group');
    const { season, event } = chipsQuery.parse(req.query);
    res.json({ chips: await status.getChips(g.data, season, event ?? null) });
  });

  router.get('/seasons/:season/events', requireSignedIn, async (req, res) => {
    const s = seasonKey.safeParse(req.params.season);
    if (!s.success) throw notFound('season');
    res.json(await status.getEvents(s.data));
  });

  router.get('/status', requireAdmin, async (req, res) => {
    const { season, limit } = statusQuery.parse(req.query);
    res.json({ status: await status.getStatus(season, { limit }) });
  });

  router.get('/status/runs/:runId', requireAdmin, async (req, res) => {
    const r = objectIdParam.safeParse(req.params.runId);
    if (!r.success) throw notFound('run');
    res.json({ run: await status.getRun(r.data) });
  });

  return router;
}

