import { Event } from '../models/Event.js';
import { ids } from '../db/ids.js';
import { eventToDomain, eventToDocument } from './mappers/event.js';
import { upsertSnapshots, settledFor, requestsFor } from './internal/snapshotUpsert.js';
import { requireTransaction } from './internal/session.js';

// events (v0.3 §10): bulk upsert with fixtures + derived state, in T1.

export const eventRepo = {
  async bulkUpsert(events, run, { sourceRequests = {}, session } = {}) {
    requireTransaction(session, 'eventRepo.bulkUpsert');
    const items = events.map((e) => ({
      doc: eventToDocument(e),
      sourceRequests: requestsFor(sourceRequests, e),
      settled: settledFor(run, e.dataCheckedObservedAt),
    }));
    return upsertSnapshots(Event, items, run, { session });
  },

  async get(season, gw, { withProvenance = false, session } = {}) {
    return eventToDomain(await Event.findById(ids.event(season, gw)).session(session ?? null).lean(), { withProvenance });
  },

  async listBySeason(season, { withProvenance = false, session } = {}) {
    const docs = await Event.find({ season }).sort({ gw: 1 }).session(session ?? null).lean();
    return docs.map((d) => eventToDomain(d, { withProvenance }));
  },

  async getCurrent(season, { withProvenance = false, session } = {}) {
    return eventToDomain(await Event.findOne({ season, isCurrent: true }).session(session ?? null).lean(), { withProvenance });
  },
};
