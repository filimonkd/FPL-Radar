import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireGroupRead } from '../middleware/auth.js';
import { notFound } from '../errors.js';
import { objectIdParam, seasonKey } from '../validators/groups.js';
import { gwParam } from '../validators/results.js';

// Injury & news API (Step 18):
//   GET  /api/groups/:groupId/gw/:gw/news?season=   admin / group viewer, read-only
//   POST /api/seasons/:season/players/refresh       admin; re-reads FPL at most every 5 minutes

const newsQuery = z.object({ season: seasonKey });

export function newsRouter({ news, players }) {
  const router = Router();
  router.get('/groups/:groupId/gw/:gw/news', requireGroupRead(), async (req, res) => {
    const g = objectIdParam.safeParse(req.params.groupId);
    const gw = gwParam.safeParse(/^\d+$/.test(req.params.gw) ? Number(req.params.gw) : NaN);
    if (!g.success) throw notFound('group');
    if (!gw.success) throw notFound('gameweek');
    const { season } = newsQuery.parse(req.query);
    res.json({ news: await news.getNews(g.data, season, gw.data) });
  });
  router.post('/seasons/:season/players/refresh', requireAdmin, async (req, res) => {
    const season = seasonKey.safeParse(req.params.season);
    if (!season.success) throw notFound('season');
    res.json({ refresh: await players.refresh(season.data) });
  });
  return router;
}
