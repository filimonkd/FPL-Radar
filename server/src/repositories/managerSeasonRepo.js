import { ManagerSeason } from '../models/ManagerSeason.js';
import { ids } from '../db/ids.js';
import { managerSeasonToDomain, managerSeasonToDocument } from './mappers/managerSeason.js';
import { upsertSnapshots } from './internal/snapshotUpsert.js';
import { requireTransaction } from './internal/session.js';

// managerSeasons (v0.3 §10): upsert chips + transfers (T3), lists replaced wholesale.

export const managerSeasonRepo = {
  async upsert(value, run, { sourceRequests = {}, session } = {}) {
    requireTransaction(session, 'managerSeasonRepo.upsert');
    return upsertSnapshots(ManagerSeason, [{ doc: managerSeasonToDocument(value), sourceRequests }], run, { session });
  },

  async get(season, entryId, { withProvenance = false, session } = {}) {
    return managerSeasonToDomain(await ManagerSeason.findById(ids.managerSeason(season, entryId)).session(session ?? null).lean(), { withProvenance });
  },

  async getMany(season, entryIds, { withProvenance = false, session } = {}) {
    const docs = await ManagerSeason.find({ season, entryId: { $in: entryIds } }).sort({ entryId: 1 }).session(session ?? null).lean();
    return docs.map((d) => managerSeasonToDomain(d, { withProvenance }));
  },
};
