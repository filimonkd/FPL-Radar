import { Router } from 'express';
import { z } from 'zod';
import { requireSignedIn } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { seasonKey } from '../validators/groups.js';

// Players API (Step 17), read-only:
//   GET /api/seasons/:season/players?event=   admin / any group viewer

const playersQuery = z.object({ event: z.coerce.number().int().min(0).max(38).optional() });

export function playersRouter({ players }) {
  const router = Router();
  router.get('/seasons/:season/players', requireSignedIn, async (req, res) => {
    const season = seasonKey.safeParse(req.params.season);
    if (!season.success) throw notFound('season');
    const { event } = playersQuery.parse(req.query);
    res.json({ players: await players.getPlayers(season.data, event ?? null) });
  });
  return router;
}
