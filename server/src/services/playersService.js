import {
  playerRepo as defaultPlayerRepo, liveRepo as defaultLiveRepo, eventRepo as defaultEventRepo, seasonRepo as defaultSeasonRepo, NotFoundError,
} from '../repositories/index.js';
import { buildPlayersView } from './playersModel.js';

// Player reads (Step 17): the shared player data behind the news tracker,
// differential finder, transfer simulator and wildcard planner. Read-only; it
// is season-wide FPL data, not group data.

export function createPlayersService({ repos = {} } = {}) {
  const playerRepo = repos.playerRepo ?? defaultPlayerRepo;
  const liveRepo = repos.liveRepo ?? defaultLiveRepo;
  const eventRepo = repos.eventRepo ?? defaultEventRepo;
  const seasonRepo = repos.seasonRepo ?? defaultSeasonRepo;

  return {
    /** @param {number|null} event  defaults to the current GW (0 before the season starts) */
    async getPlayers(season, event = null) {
      const [seasonDoc, events, players, live] = await Promise.all([
        seasonRepo.get(season), eventRepo.listBySeason(season), playerRepo.listBySeason(season), liveRepo.listBySeason(season),
      ]);
      if (!seasonDoc) throw new NotFoundError('season', season);
      const gw = event ?? events.find((e) => e.isCurrent)?.gw ?? 0;
      return buildPlayersView({ season, event: gw, events, teams: seasonDoc.teams, players, live });
    },
  };
}
