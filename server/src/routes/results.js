import { Router } from 'express';
import { requireAdmin, requireGroupRead } from '../middleware/auth.js';
import { notFound, unauthorized } from '../errors.js';
import { objectIdParam } from '../validators/groups.js';
import { seasonQuery, finalizeBody, overrideBody, recomputeBody, gwParam } from '../validators/results.js';

// Results API (architecture v0.2 §4, §9, §15; v0.3 §7).
//
//   GET  /api/groups/:groupId/gw/:gw/result?season=        admin / group viewer  (read or preview)
//   POST /api/groups/:groupId/gw/:gw/finalize { season }    admin
//   POST /api/groups/:groupId/gw/:gw/override { season, winners, note }  admin
//   POST /api/groups/:groupId/gw/:gw/recompute { season, dryRun, note? } admin
//   GET  /api/groups/:groupId/gw/:gw/actions?season=        admin / group viewer
//   GET  /api/groups/:groupId/gw/:gw/actions/verify?season= admin / group viewer
//   GET  /api/result-snapshots/:snapshotId                  admin / that group's viewer
//   GET  /api/result-snapshots/:snapshotId/verify           admin / that group's viewer
//   GET  /api/result-snapshots/:snapshotId/trace            admin / that group's viewer

const params = (req) => {
  const g = objectIdParam.safeParse(req.params.groupId);
  const gw = gwParam.safeParse(/^\d+$/.test(req.params.gw) ? Number(req.params.gw) : NaN);
  if (!g.success) throw notFound('group');
  if (!gw.success) throw notFound('gameweek');
  return { groupId: g.data, event: gw.data };
};

const snapshotId = (req) => {
  const r = objectIdParam.safeParse(req.params.snapshotId);
  if (!r.success) throw notFound('snapshot');
  return r.data;
};

function requireSignedIn(req, _res, next) {
  if (!req.principal || req.principal.role === 'anonymous') return next(unauthorized());
  return next();
}

export function resultsRouter({ results }) {
  const router = Router();
  const gw = '/groups/:groupId/gw/:gw';

  router.get(`${gw}/result`, requireGroupRead(), async (req, res) => {
    const { groupId, event } = params(req);
    const { season } = seasonQuery.parse(req.query);
    const result = await results.getResult(groupId, season, event);
    if (req.principal.role !== 'admin') delete result.finalizeGate;
    res.json({ result });
  });

  router.post(`${gw}/finalize`, requireAdmin, async (req, res) => {
    const { groupId, event } = params(req);
    const { season } = finalizeBody.parse(req.body ?? {});
    const out = await results.finalize(groupId, season, event);
    res.status(out.replayed ? 200 : 201).json(out);
  });

  router.post(`${gw}/override`, requireAdmin, async (req, res) => {
    const { groupId, event } = params(req);
    const { season, winners, note } = overrideBody.parse(req.body ?? {});
    res.status(201).json(await results.override(groupId, season, event, { winners, note }));
  });

  router.post(`${gw}/recompute`, requireAdmin, async (req, res) => {
    const { groupId, event } = params(req);
    const { season, dryRun, note } = recomputeBody.parse(req.body ?? {});
    const out = await results.recompute(groupId, season, event, { dryRun, note: note ?? null });
    res.status(dryRun ? 200 : 201).json(out);
  });

  router.get(`${gw}/actions`, requireGroupRead(), async (req, res) => {
    const { groupId, event } = params(req);
    const { season } = seasonQuery.parse(req.query);
    res.json({ actions: await results.listActions(groupId, season, event) });
  });

  router.get(`${gw}/actions/verify`, requireGroupRead(), async (req, res) => {
    const { groupId, event } = params(req);
    const { season } = seasonQuery.parse(req.query);
    res.json(await results.verifyChain(groupId, season, event));
  });

  router.get('/result-snapshots/:snapshotId', requireSignedIn, async (req, res) => {
    res.json({ snapshot: await results.getSnapshot(snapshotId(req), req.principal) });
  });

  router.get('/result-snapshots/:snapshotId/verify', requireSignedIn, async (req, res) => {
    res.json(await results.verifySnapshot(snapshotId(req), req.principal));
  });

  router.get('/result-snapshots/:snapshotId/trace', requireSignedIn, async (req, res) => {
    res.json(await results.trace(snapshotId(req), req.principal));
  });

  return router;
}
