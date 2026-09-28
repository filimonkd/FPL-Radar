import { randomBytes } from 'node:crypto';
import { withTransaction } from '../db/unitOfWork.js';
import { groupRepo as defaultGroupRepo, DuplicateMemberError, NotFoundError } from '../repositories/index.js';
import { GroupArchivedError } from '../sync/index.js';
import { newShareToken } from '../auth/tokens.js';
import { AppError } from '../errors.js';
import { slugify } from '../validators/groups.js';

// Group management (architecture v0.2 §5, §10, §15 step 6; v0.3 §10).
// Services orchestrate: repositories for persistence, db/unitOfWork for
// multi-read / conditional writes, the sync service for anything that calls FPL
// (group creation and manual members, under a logged run and the group lease).
// Authorization is decided by the routes' guards before a service is called;
// the service only shapes what each principal may see.

const DUPLICATE_KEY = 11000;

/** What a principal may see of a group: viewers never see the share token. */
export function groupDto(group, principal) {
  const { shareToken, ...rest } = group;
  return principal?.role === 'admin' ? { ...rest, shareToken } : rest;
}

const fail = (status, code, message, details) => new AppError(status, code, message, details);

export function createGroupService({ sync, groups = defaultGroupRepo, clock = () => new Date() }) {
  async function load(groupId, { session } = {}) {
    const g = await groups.getById(groupId, { session });
    if (!g) throw new NotFoundError('group', groupId);
    return g;
  }

  async function loadWritable(groupId, opts) {
    const g = await load(groupId, opts);
    if (!g.isActive) throw new GroupArchivedError(groupId); // archived = read-only (v0.2 §5)
    return g;
  }

  function assertNoDuplicates(entryIds, existing = []) {
    const seen = new Set(existing);
    const dupes = new Set();
    for (const id of entryIds) (seen.has(id) ? dupes : seen).add(id);
    if (dupes.size) throw new DuplicateMemberError([...dupes].sort((a, b) => a - b));
  }

  return {
    async list({ includeArchived = false } = {}) {
      return groups.list({ includeArchived });
    },

    get: (groupId) => load(groupId),

    /** Anonymous standings access for the create form: OK | AUTH_REQUIRED | EMPTY | NOT_FOUND (v0.2 §10). */
    async previewLeague(fplLeagueId) {
      const { access, league, members } = await sync.leagueAccess(fplLeagueId);
      const configured = await groups.getByLeagueId(fplLeagueId);
      return { fplLeagueId, access, league, members, configuredGroupId: configured?.id ?? null };
    },

    /** Checks entry IDs on /entry/{id}/ for manual members: { valid: [{ entryId, playerName, teamName }], invalid: [] }. */
    async validateEntries(entryIds) {
      const { valid, invalid } = await sync.lookupEntries(entryIds);
      return { valid: valid.map(({ entryId, playerName, teamName }) => ({ entryId, playerName, teamName })), invalid };
    },

    /**
     * Creates a group. A league ID already used by any group (active or archived)
     * → 409 LEAGUE_ALREADY_CONFIGURED with that group's id (v0.2 §5).
     */
    async create(input) {
      const slug = input.slug ?? slugify(input.name);
      if (!slug) throw fail(400, 'VALIDATION_FAILED', 'name must contain letters or digits to derive a slug', { issues: [{ path: 'slug', message: 'empty' }] });
      if (input.entryIds) assertNoDuplicates(input.entryIds);
      if (input.fplLeagueId != null) {
        const existing = await groups.getByLeagueId(input.fplLeagueId);
        if (existing) throw fail(409, 'LEAGUE_ALREADY_CONFIGURED', `league ${input.fplLeagueId} already has a group`, { groupId: existing.id, archived: !existing.isActive });
      }
      if (await groups.getBySlug(slug)) throw fail(409, 'SLUG_TAKEN', `slug ${slug} is taken`);
      const group = {
        name: input.name,
        slug,
        memberSource: input.memberSource,
        fplLeagueId: input.fplLeagueId ?? null,
        winnerRule: input.winnerRule,
        myEntryId: input.myEntryId ?? null,
        ...(input.tieBreakRules ? { tieBreakRules: input.tieBreakRules } : {}),
      };
      // The id is chosen up front so the group lease exists before the group does.
      return sync.registerGroup({ id: randomBytes(12).toString('hex'), group, entryIds: input.entryIds ?? [] });
    },

    /** Config edits (name, winner rule, tie-breaks, myEntryId, switch to MANUAL), read-check-write in one transaction. */
    async updateConfig(groupId, patch) {
      return withTransaction(async (session) => {
        const g = await loadWritable(groupId, { session });
        if (patch.myEntryId != null && !g.members.some((m) => m.entryId === patch.myEntryId)) {
          throw fail(422, 'MY_ENTRY_NOT_MEMBER', `myEntryId ${patch.myEntryId} is not a member of this group`);
        }
        return groups.updateConfig(groupId, patch, { session, at: clock() });
      });
    },

    /** Adds manual members (checked against FPL); duplicates of current members → 409 DUPLICATE_MEMBER. */
    async addMembers(groupId, entryIds) {
      assertNoDuplicates(entryIds);
      const g = await loadWritable(groupId);
      assertNoDuplicates(entryIds, g.members.map((m) => m.entryId));
      return sync.addMembers(groupId, entryIds);
    },

    /** Exclusion / joinedEvent: members are never removed (v0.2 §10). */
    async updateMember(groupId, entryId, patch) {
      return withTransaction(async (session) => {
        const g = await loadWritable(groupId, { session });
        if (!g.members.some((m) => m.entryId === entryId)) throw fail(404, 'MEMBER_NOT_FOUND', `entry ${entryId} is not a member of this group`);
        const members = g.members.map((m) => (m.entryId === entryId ? { ...m, ...patch } : m));
        return groups.setMembers(groupId, members, { session, at: clock() });
      });
    },

    async archive(groupId) {
      await load(groupId);
      await groups.archive(groupId, { at: clock() });
      return load(groupId);
    },

    async unarchive(groupId) {
      await load(groupId);
      await groups.unarchive(groupId, { at: clock() });
      return load(groupId);
    },

    /** Issues a new read-only share token (the previous one stops working). */
    async rotateShareToken(groupId) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await withTransaction(async (session) => {
            await loadWritable(groupId, { session });
            return groups.updateConfig(groupId, { shareToken: newShareToken() }, { session, at: clock() });
          });
        } catch (err) {
          if (err?.code !== DUPLICATE_KEY || attempt >= 2) throw err; // 256-bit collision: practically never
        }
      }
    },

    async revokeShareToken(groupId) {
      return withTransaction(async (session) => {
        await loadWritable(groupId, { session });
        return groups.updateConfig(groupId, { shareToken: null }, { session, at: clock() });
      });
    },

    /** Starts a group GW sync (409 SYNC_IN_PROGRESS / GROUP_ARCHIVED from the sync service). */
    async sync(groupId, { season, event }) {
      await load(groupId);
      return sync.syncGroupGameweek({ groupId, season, event, trigger: 'MANUAL' });
    },
  };
}
