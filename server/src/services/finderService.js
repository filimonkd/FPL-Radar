import { ownershipRepo as defaultOwnershipRepo, groupRepo as defaultGroupRepo, NotFoundError } from '../repositories/index.js';
import { findPlayers } from '../analytics/finder.js';
import { createPlayersService } from './playersService.js';
import { latestSquads } from './groupSquads.js';

// Differential & value finder reads (Step 19): every FPL player filtered and
// sorted against the group's latest squads. Read-only.

export function createFinderService({ repos = {}, players } = {}) {
  const ownershipRepo = repos.ownershipRepo ?? defaultOwnershipRepo;
  const groupRepo = repos.groupRepo ?? defaultGroupRepo;
  const playersService = players ?? createPlayersService({ repos });

  return {
    /**
     * @param {{ filters?: object, sort?: string, limit?: number }} query
     */
    async find(groupId, season, event, { filters = {}, sort = 'value', limit = 50 } = {}) {
      const g = await groupRepo.getById(groupId);
      if (!g) throw new NotFoundError('group', groupId);
      const [loaded, view] = await Promise.all([ownershipRepo.loadRivalInputs(groupId, season, event), playersService.getPlayers(season, event)]);
      const squads = latestSquads(loaded.squads);
      const out = findPlayers({ players: view.players, squads, myEntryId: g.myEntryId ?? null, filters, sort, limit });
      const short = new Map(view.teams.map((t) => [t.id, t.shortName]));
      return {
        groupId, groupName: g.name, season, event, asOf: view.asOf, filters, sort, limit,
        total: out.total,
        groupOf: out.groupOf,
        rows: out.rows.map((r) => ({ ...r, fixtures: { ...r.fixtures, fixtures: r.fixtures.fixtures.map((f) => ({ ...f, opponentShort: short.get(f.opponent) ?? null })) } })),
      };
    },
  };
}
