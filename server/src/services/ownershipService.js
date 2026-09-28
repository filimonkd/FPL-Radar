import { ownershipRepo as defaultOwnershipRepo, groupRepo as defaultGroupRepo, NotFoundError } from '../repositories/index.js';
import { ownershipInputs, buildOwnershipView, transferInputs, buildTransferView } from './ownershipModel.js';

// Ownership / captaincy / transfer reads (architecture v0.2 §7, §14; v0.3 §10).
// Load through repositories → pure view → response. Computed on read, never
// stored (v0.2 §9); nothing here writes, and finalized snapshots are untouched.

export function createOwnershipService({ repos = {} } = {}) {
  const ownershipRepo = repos.ownershipRepo ?? defaultOwnershipRepo;
  const groupRepo = repos.groupRepo ?? defaultGroupRepo;

  async function requireGroup(groupId) {
    const g = await groupRepo.getById(groupId);
    if (!g) throw new NotFoundError('group', groupId);
    return g;
  }

  return {
    /** Picked vs effective ownership + captaincy for a group GW, with its input references. */
    async getOwnership(groupId, season, event, { view } = {}) {
      await requireGroup(groupId);
      const loaded = await ownershipRepo.loadSquads(groupId, season, event);
      return { groupId, season, ...buildOwnershipView(ownershipInputs(loaded, event), { view }), sources: loaded.sources };
    },

    /** Transfer activity of the group's eligible managers in a GW. */
    async getTransfers(groupId, season, event) {
      await requireGroup(groupId);
      const loaded = await ownershipRepo.loadTransfers(groupId, season, event);
      return { groupId, season, ...buildTransferView(transferInputs(loaded, event)), sources: loaded.sources };
    },
  };
}
