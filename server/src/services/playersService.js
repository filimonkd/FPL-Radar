import {
  playerRepo as defaultPlayerRepo, liveRepo as defaultLiveRepo, eventRepo as defaultEventRepo, seasonRepo as defaultSeasonRepo, NotFoundError,
} from '../repositories/index.js';
import { buildPlayersView } from './playersModel.js';

// Player reads (Step 17): the shared player data behind the news tracker,
// differential finder, transfer simulator and wildcard planner. Read-only; it
// is season-wide FPL data, not group data.
//
// refresh (Step 18): an admin opening the news asks for fresh FPL news. At
// most one bootstrap read per REFRESH_TTL_MS; otherwise the stored data is
// already fresh enough and nothing is requested.

export const REFRESH_TTL_MS = 5 * 60_000;

export function createPlayersService({ repos = {}, sync = null, clock = () => new Date() } = {}) {
  const playerRepo = repos.playerRepo ?? defaultPlayerRepo;
  const liveRepo = repos.liveRepo ?? defaultLiveRepo;
  const eventRepo = repos.eventRepo ?? defaultEventRepo;
  const seasonRepo = repos.seasonRepo ?? defaultSeasonRepo;

  return {
    /** @param {number|null} event  defaults to the current GW (0 before the season starts) */
    async getPlayers(season, event = null) {
      const [seasonDoc, events, players, live, asOf] = await Promise.all([
        seasonRepo.get(season), eventRepo.listBySeason(season), playerRepo.listBySeason(season), liveRepo.listBySeason(season), playerRepo.getLastConfirmedAt(season),
      ]);
      if (!seasonDoc) throw new NotFoundError('season', season);
      const gw = event ?? events.find((e) => e.isCurrent)?.gw ?? 0;
      return { ...buildPlayersView({ season, event: gw, events, teams: seasonDoc.teams, players, live }), asOf };
    },

    /**
     * Re-read FPL's player data unless it was read in the last 5 minutes.
     * @returns {Promise<{ refreshed: boolean, reason: 'FRESH'|'BUSY'|null, status: string|null, runId: string|null, failures: object[], asOf: Date|null }>}
     */
    async refresh(season) {
      if (!sync) throw new Error('players refresh needs the sync service');
      const before = await playerRepo.getLastConfirmedAt(season);
      if (before && clock().getTime() - new Date(before).getTime() < REFRESH_TTL_MS) {
        return { refreshed: false, reason: 'FRESH', status: null, runId: null, failures: [], asOf: before };
      }
      let run;
      try {
        run = await sync.syncBootstrap({ season, trigger: 'MANUAL' });
      } catch (err) {
        if (err?.code === 'SYNC_IN_PROGRESS') return { refreshed: false, reason: 'BUSY', status: null, runId: null, failures: [], asOf: before };
        throw err;
      }
      return {
        refreshed: run.status === 'SUCCESS' || run.status === 'PARTIAL',
        reason: null,
        status: run.status,
        runId: run.runId,
        failures: run.failures.map((f) => ({ code: f.code ?? null, message: f.message ?? null })),
        asOf: await playerRepo.getLastConfirmedAt(season),
      };
    },
  };
}
