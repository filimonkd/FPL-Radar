import { ownershipRepo as defaultOwnershipRepo, groupRepo as defaultGroupRepo, NotFoundError } from '../repositories/index.js';
import { buildNewsFeed } from '../analytics/news.js';
import { createPlayersService } from './playersService.js';

// Injury & news reads (Step 18): FPL's news and the Step 17 flags for the
// players any group member owns (each member's latest known 15 up to the GW).
// Read-only; the news itself is season-wide and as fresh as the last
// bootstrap read (`asOf`).

export function createNewsService({ repos = {}, players } = {}) {
  const ownershipRepo = repos.ownershipRepo ?? defaultOwnershipRepo;
  const groupRepo = repos.groupRepo ?? defaultGroupRepo;
  const playersService = players ?? createPlayersService({ repos });

  return {
    async getNews(groupId, season, event) {
      const g = await groupRepo.getById(groupId);
      if (!g) throw new NotFoundError('group', groupId);
      const [loaded, view] = await Promise.all([ownershipRepo.loadRivalInputs(groupId, season, event), playersService.getPlayers(season)]);
      const latest = new Map();
      for (const q of loaded.squads) {
        if (!latest.has(q.entryId) || latest.get(q.entryId).event < q.event) latest.set(q.entryId, q);
      }
      const squads = [...latest.values()].map((q) => ({ entryId: q.entryId, event: q.event, elementIds: q.picks.map((p) => p.elementId) }));
      const feed = buildNewsFeed({ players: view.players, squads, myEntryId: g.myEntryId ?? null });
      const managers = loaded.managers.map((m) => ({ entryId: m.entryId, playerName: m.playerName, teamName: m.teamName }));
      return {
        groupId, season, event, asOf: view.asOf, myEntryId: g.myEntryId ?? null,
        squads: squads.map((q) => ({ entryId: q.entryId, event: q.event })).sort((a, b) => a.entryId - b.entryId),
        managers, ...feed,
      };
    },
  };
}
