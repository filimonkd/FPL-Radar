import { Router } from 'express';
import { requireAdmin, requireGroupRead } from '../middleware/auth.js';
import { groupDto } from '../services/groupService.js';
import { notFound } from '../errors.js';
import {
  objectIdParam, fplId, createGroupBody, updateGroupBody, addMembersBody, updateMemberBody, validateEntriesBody, syncBody, listQuery,
} from '../validators/groups.js';

// Group API (architecture v0.2 §5, §10, §15). No DELETE routes: archive instead.
//
//   GET    /api/groups?includeArchived=true        admin
//   POST   /api/groups                             admin   create (league or manual)
//   GET    /api/groups/:groupId                    admin, or that group's share-token viewer
//   PATCH  /api/groups/:groupId                    admin   config
//   POST   /api/groups/:groupId/archive|unarchive  admin
//   POST   /api/groups/:groupId/members            admin   { entryIds }  manual members
//   PATCH  /api/groups/:groupId/members/:entryId   admin   { isExcluded?, joinedEvent? }
//   POST   /api/groups/:groupId/share-token        admin   issue / rotate
//   POST   /api/groups/:groupId/share-token/revoke admin
//   POST   /api/groups/:groupId/sync               admin   { season, event }
//   GET    /api/leagues/:leagueId/preview          admin   OK | AUTH_REQUIRED | EMPTY | NOT_FOUND
//   POST   /api/entries/validate                   admin   { entryIds }

const groupId = (req) => {
  const r = objectIdParam.safeParse(req.params.groupId);
  if (!r.success) throw notFound('group'); // malformed ids are just unknown groups
  return r.data;
};

const intParam = (value, what) => {
  const r = fplId.safeParse(/^\d+$/.test(value) ? Number(value) : NaN);
  if (!r.success) throw notFound(what);
  return r.data;
};

export function groupsRouter({ groups }) {
  const router = Router();
  const admin = (p) => groupDto(p, { role: 'admin' });

  router.get('/groups', requireAdmin, async (req, res) => {
    const q = listQuery.parse(req.query);
    const list = await groups.list({ includeArchived: q.includeArchived === 'true' });
    res.json({ groups: list.map(admin) });
  });

  router.post('/groups', requireAdmin, async (req, res) => {
    const created = await groups.create(createGroupBody.parse(req.body ?? {}));
    res.status(201).json({ group: admin(created) });
  });

  router.get('/groups/:groupId', requireGroupRead(), async (req, res) => {
    res.json({ group: groupDto(await groups.get(groupId(req)), req.principal) });
  });

  router.patch('/groups/:groupId', requireAdmin, async (req, res) => {
    const id = groupId(req);
    res.json({ group: admin(await groups.updateConfig(id, updateGroupBody.parse(req.body ?? {}))) });
  });

  router.post('/groups/:groupId/archive', requireAdmin, async (req, res) => {
    res.json({ group: admin(await groups.archive(groupId(req))) });
  });

  router.post('/groups/:groupId/unarchive', requireAdmin, async (req, res) => {
    res.json({ group: admin(await groups.unarchive(groupId(req))) });
  });

  router.post('/groups/:groupId/members', requireAdmin, async (req, res) => {
    const id = groupId(req);
    const { entryIds } = addMembersBody.parse(req.body ?? {});
    res.json({ group: admin(await groups.addMembers(id, entryIds)) });
  });

  router.patch('/groups/:groupId/members/:entryId', requireAdmin, async (req, res) => {
    const id = groupId(req);
    const entryId = intParam(req.params.entryId, 'member');
    res.json({ group: admin(await groups.updateMember(id, entryId, updateMemberBody.parse(req.body ?? {}))) });
  });

  router.post('/groups/:groupId/share-token', requireAdmin, async (req, res) => {
    const g = await groups.rotateShareToken(groupId(req));
    res.json({ shareToken: g.shareToken });
  });

  router.post('/groups/:groupId/share-token/revoke', requireAdmin, async (req, res) => {
    await groups.revokeShareToken(groupId(req));
    res.status(204).end();
  });

  router.post('/groups/:groupId/sync', requireAdmin, async (req, res) => {
    const id = groupId(req);
    res.json({ run: await groups.sync(id, syncBody.parse(req.body ?? {})) });
  });

  router.get('/leagues/:leagueId/preview', requireAdmin, async (req, res) => {
    res.json(await groups.previewLeague(intParam(req.params.leagueId, 'league')));
  });

  router.post('/entries/validate', requireAdmin, async (req, res) => {
    res.json(await groups.validateEntries(validateEntriesBody.parse(req.body ?? {}).entryIds));
  });

  return router;
}
