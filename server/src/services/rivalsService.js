import { ownershipRepo as defaultOwnershipRepo, groupRepo as defaultGroupRepo, NotFoundError } from '../repositories/index.js';
import { rivalsInputs, buildRivalsView, chipsLeftOf } from './rivalsModel.js';
import { createOwnershipService } from './ownershipService.js';
import { createStatusService } from './statusService.js';

// Rival analytics reads (Step 16): leaderboard + podium, spy vs me, strategy
// lab and rival radar for one group GW. Computed on read from synced data;
// nothing is written and finalized results are untouched.

export function createRivalsService({ repos = {}, ownership, status } = {}) {
  const ownershipRepo = repos.ownershipRepo ?? defaultOwnershipRepo;
  const groupRepo = repos.groupRepo ?? defaultGroupRepo;
  const ownershipService = ownership ?? createOwnershipService({ repos });
  const statusService = status ?? createStatusService({ repos });

  return {
    async getRivals(groupId, season, event) {
      const g = await groupRepo.getById(groupId);
      if (!g) throw new NotFoundError('group', groupId);
      const [loaded, transfers, chips] = await Promise.all([
        ownershipRepo.loadRivalInputs(groupId, season, event),
        ownershipService.getTransfers(groupId, season, event),
        statusService.getChips(groupId, season, event),
      ]);
      const inputs = rivalsInputs(loaded, event, { transfersIn: transfers.playersIn, chipsLeft: chipsLeftOf(chips) });
      return { groupId, season, eventState: loaded.eventState, ...buildRivalsView(inputs), sources: loaded.sources };
    },
  };
}
