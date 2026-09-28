import { LiveGameweek } from '../models/LiveGameweek.js';
import { Event } from '../models/Event.js';
import { ids } from '../db/ids.js';
import { liveToDomain, liveToDocument } from './mappers/live.js';
import { upsertSnapshots, settledFor } from './internal/snapshotUpsert.js';

// liveGameweeks (v0.3 §10): replace one document (single-document write, no
// transaction). elements[] is replaced wholesale behind the content hash.

export const liveRepo = {
  async replace(value, run, { sourceRequests = {}, session } = {}) {
    const event = await Event.findById(ids.event(value.season, value.gw), { dataCheckedObservedAt: 1 }).session(session ?? null).lean();
    const settled = settledFor(run, event?.dataCheckedObservedAt ?? null);
    return upsertSnapshots(LiveGameweek, [{ doc: liveToDocument(value), sourceRequests, settled }], run, { session });
  },

  async get(season, gw, { withProvenance = false, session } = {}) {
    return liveToDomain(await LiveGameweek.findById(ids.liveGameweek(season, gw)).session(session ?? null).lean(), { withProvenance });
  },
};
