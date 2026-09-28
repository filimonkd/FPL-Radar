import { Manager } from '../models/Manager.js';
import { managerToDomain, managerToDocument } from './mappers/manager.js';
import { upsertSnapshots, requestsFor } from './internal/snapshotUpsert.js';
import { requireTransaction } from './internal/session.js';

// managers (v0.3 §10): upsert profile, inside T2 (member sync) or T3 (per-member sync).

export const managerRepo = {
  /** Content-hash upsert of FPL profiles (v0.3 §6). */
  async upsertProfiles(profiles, run, { sourceRequests = {}, session } = {}) {
    requireTransaction(session, 'managerRepo.upsertProfiles');
    return upsertSnapshots(Manager, profiles.map((p) => ({ doc: managerToDocument(p), sourceRequests: requestsFor(sourceRequests, p) })), run, { session });
  },

  async get(entryId, { withProvenance = false, session } = {}) {
    return managerToDomain(await Manager.findById(entryId).session(session ?? null).lean(), { withProvenance });
  },

  async getMany(entryIds, { withProvenance = false, session } = {}) {
    const docs = await Manager.find({ _id: { $in: entryIds } }).sort({ _id: 1 }).session(session ?? null).lean();
    return docs.map((d) => managerToDomain(d, { withProvenance }));
  },
};
