import { ManagerGameweek } from '../models/ManagerGameweek.js';
import { Event } from '../models/Event.js';
import { managerGameweekToDomain, managerGameweekToDocument } from './mappers/managerGameweek.js';
import { upsertSnapshots, settledFor, requestsFor } from './internal/snapshotUpsert.js';
import { requireTransaction } from './internal/session.js';

// managerGameweeks (v0.3 §10): bulk upsert of one entry's whole season (T3),
// so reconciliation results are never mixed (v0.3 §6 rule 5). settled is
// computed here from the run's startedAt and each GW's dataCheckedObservedAt.

export const managerGameweekRepo = {
  async bulkUpsertSeasonRows(season, entryId, rows, run, { sourceRequests = {}, session } = {}) {
    requireTransaction(session, 'managerGameweekRepo.bulkUpsertSeasonRows');
    const stray = rows.filter((r) => r.season !== season || r.entryId !== entryId);
    if (stray.length) throw new TypeError(`rows must all belong to ${season} / entry ${entryId}`);
    const events = await Event.find({ season, gw: { $in: rows.map((r) => r.event) } }, { gw: 1, dataCheckedObservedAt: 1 })
      .session(session).lean();
    const observedAt = new Map(events.map((e) => [e.gw, e.dataCheckedObservedAt ?? null]));
    const items = rows.map((r) => ({
      doc: managerGameweekToDocument(r),
      sourceRequests: requestsFor(sourceRequests, r),
      settled: settledFor(run, observedAt.get(r.event) ?? null),
    }));
    return upsertSnapshots(ManagerGameweek, items, run, { session });
  },

  /** A GW's rows for a set of entries (index season_event_entry), ordered by entryId. */
  async listForEvent(season, event, entryIds, { withProvenance = false, session } = {}) {
    const docs = await ManagerGameweek.find({ season, event, entryId: { $in: entryIds } }).sort({ entryId: 1 }).session(session ?? null).lean();
    return docs.map((d) => managerGameweekToDomain(d, { withProvenance }));
  },

  /** One entry's season series (index season_entry_event), ordered by event. */
  async listForEntry(season, entryId, { withProvenance = false, session } = {}) {
    const docs = await ManagerGameweek.find({ season, entryId }).sort({ event: 1 }).session(session ?? null).lean();
    return docs.map((d) => managerGameweekToDomain(d, { withProvenance }));
  },
};
