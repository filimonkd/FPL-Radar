import { Group } from '../../models/Group.js';
import { Event } from '../../models/Event.js';
import { ManagerGameweek } from '../../models/ManagerGameweek.js';
import { ManagerSeason } from '../../models/ManagerSeason.js';
import { LiveGameweek } from '../../models/LiveGameweek.js';
import { SyncRun } from '../../models/SyncRun.js';
import { ids } from '../../db/ids.js';
import { groupToDomain } from '../mappers/group.js';
import { eventToDomain } from '../mappers/event.js';
import { managerGameweekToDomain } from '../mappers/managerGameweek.js';
import { managerSeasonToDomain } from '../mappers/managerSeason.js';
import { liveToDomain } from '../mappers/live.js';
import { syncRunToDomain } from '../mappers/syncRun.js';
import { toObjectId } from '../mappers/common.js';
import { NotFoundError } from '../errors.js';

// Shared reads for the input assemblers (v0.3 §10 rule 3). Sequential on
// purpose: operations on one transaction session must not run concurrently.

export async function loadGroupGw(groupId, season, event, session) {
  const s = session ?? null;
  const group = groupToDomain(await Group.findById(toObjectId(groupId, 'groupId')).session(s).lean());
  if (!group) throw new NotFoundError('group', groupId);
  const entryIds = group.members.map((m) => m.entryId);
  const eventDoc = await Event.findById(ids.event(season, event)).session(s).lean();
  const rowDocs = await ManagerGameweek.find({ season, event, entryId: { $in: entryIds } }).sort({ entryId: 1 }).session(s).lean();
  const msDocs = await ManagerSeason.find({ season, entryId: { $in: entryIds } }).sort({ entryId: 1 }).session(s).lean();
  const liveDoc = await LiveGameweek.findById(ids.liveGameweek(season, event)).session(s).lean();
  return {
    group,
    eventDoc: eventToDomain(eventDoc, { withProvenance: true }),
    rows: rowDocs.map((d) => managerGameweekToDomain(d, { withProvenance: true })),
    managerSeasons: msDocs.map((d) => managerSeasonToDomain(d, { withProvenance: true })),
    live: liveToDomain(liveDoc, { withProvenance: true }),
  };
}

export async function loadRuns(runIds, session) {
  if (runIds.length === 0) return new Map();
  const docs = await SyncRun.find({ _id: { $in: runIds.map((id) => toObjectId(id, 'runId')) } }).session(session ?? null).lean();
  return new Map(docs.map((d) => [String(d._id), syncRunToDomain(d)]));
}

/**
 * sources[] (v0.3 §8): one entry per distinct run that last confirmed any input
 * document, with the request hashes those documents were built from. Ordered
 * by run startedAt (business time), then run id for a stable serialization.
 * A run that no longer exists keeps startedAt/status null, which the snapshot
 * schema rejects: a finalized result can never cite a missing run.
 */
export function buildSources(inputDocs, runsById) {
  const byRun = new Map();
  for (const d of inputDocs) {
    const p = d?.provenance;
    if (!p?.lastConfirmedByRunId) continue;
    const set = byRun.get(p.lastConfirmedByRunId) ?? new Set();
    for (const h of Object.values(p.sourceRequests ?? {})) if (h) set.add(h);
    byRun.set(p.lastConfirmedByRunId, set);
  }
  return [...byRun].map(([syncRunId, hashes]) => {
    const run = runsById.get(syncRunId);
    return { syncRunId, startedAt: run?.startedAt ?? null, status: run?.status ?? null, requestHashes: [...hashes].sort() };
  }).sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0) || (a.syncRunId < b.syncRunId ? -1 : a.syncRunId > b.syncRunId ? 1 : 0));
}
