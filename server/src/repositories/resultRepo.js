import { ResultSnapshot } from '../models/ResultSnapshot.js';
import { GwResult } from '../models/GwResult.js';
import { GwResultAction } from '../models/GwResultAction.js';
import { SyncRun } from '../models/SyncRun.js';
import { Manager } from '../models/Manager.js';
import { FplRawResponse } from '../models/FplRawResponse.js';
import { ids } from '../db/ids.js';
import { nextAction, verifyChain } from '../audit/hashChain.js';
import { deriveEffectiveSquad } from '../analytics/effectiveSquad.js';
import {
  normalizeSnapshot, snapshotContentHashOf, snapshotToDomain, snapshotToDocument,
  normalizeActionFields, actionToDomain, actionToDocument, pointerToDomain,
} from './mappers/result.js';
import { memberToEngine } from './mappers/group.js';
import { toEngineGwRow } from './mappers/managerGameweek.js';
import { liveToEngineMap } from './mappers/live.js';
import { syncRunToDomain } from './mappers/syncRun.js';
import { managerToDomain } from './mappers/manager.js';
import { rawResponseToDomain } from './mappers/rawResponse.js';
import { toObjectId, omitKeys } from './mappers/common.js';
import { loadGroupGw, loadRuns, buildSources } from './internal/assemble.js';
import { requireTransaction } from './internal/session.js';
import { ConcurrentDecisionError, NotFoundError } from './errors.js';

// Results and audit (architecture v0.3 §7, §8, §10).
// Write surface: insertSnapshot, appendAction, movePointer — all inside the
// caller's T4 transaction. There is no update or delete for resultSnapshots or
// gwResultActions; gwResults is the only mutable document, moved under an
// optimistic headSeq guard.
//
// T4, in order (the caller holds the group lease and runs withTransaction):
//   1. lease.fence(session); head = getPointer(…, { session })
//   2. snapshot = insertSnapshot(…)            3. action = appendAction(head, …)
//   4. movePointer(head, action, …)            5. syncRunRepo.unsetExpiry +
//                                                 rawResponseRepo.unsetEvidenceExpiry

const DUPLICATE_KEY = 11000;
const scopeOf = (groupId, season, event) => ({ groupId: toObjectId(groupId, 'groupId'), season, event });

export const resultRepo = {
  // ── T4 writes ───────────────────────────────────────────────────────────

  /** Inserts an immutable snapshot; contentHash is computed here over the canonical snapshot. */
  async insertSnapshot(snapshot, { session } = {}) {
    requireTransaction(session, 'resultRepo.insertSnapshot');
    const normalized = normalizeSnapshot(snapshot);
    const contentHash = snapshotContentHashOf(normalized);
    const [created] = await ResultSnapshot.create([snapshotToDocument(normalized, contentHash)], { session });
    return snapshotToDomain(created.toObject());
  },

  /**
   * Appends the next action of a (group, season, event) chain: seq = headSeq + 1,
   * prevHash = headHash, hash over the canonical action (v0.3 §7 layers 4–5).
   * A concurrent append for the same seq violates linear_chain_unique and
   * surfaces as ConcurrentDecisionError (409 CONCURRENT_DECISION).
   * @param {object|null} head  the pointer read in step 1 (null before the first decision)
   */
  async appendAction(head, fields, { session } = {}) {
    requireTransaction(session, 'resultRepo.appendAction');
    const normalized = normalizeActionFields(fields);
    const id = ids.gwResult(normalized.groupId, normalized.season, normalized.event);
    if (head && head.id !== id) throw new TypeError(`head ${head.id} does not belong to ${id}`);
    if (normalized.prevSnapshotId !== (head?.currentSnapshotId ?? null)) {
      throw new TypeError(`prevSnapshotId must be the head's currentSnapshotId (${head?.currentSnapshotId ?? null})`);
    }
    const action = nextAction(head ? { headSeq: head.headSeq, headHash: head.headHash } : null, normalized);
    try {
      const [created] = await GwResultAction.create([actionToDocument(action)], { session });
      return actionToDomain(created.toObject());
    } catch (err) {
      if (err?.code === DUPLICATE_KEY) throw new ConcurrentDecisionError(id, `seq ${action.seq} already exists`);
      throw err;
    }
  },

  /**
   * Moves the gwResults pointer to the appended action (v0.3 §7 T4 step 4):
   * filter { _id, headSeq: expected }, or { _id } with $setOnInsert for the
   * first decision. Matching nothing → ConcurrentDecisionError.
   */
  async movePointer(head, action, { status, session } = {}) {
    requireTransaction(session, 'resultRepo.movePointer');
    const id = ids.gwResult(action.groupId, action.season, action.event);
    const expectedSeq = (head?.headSeq ?? 0) + 1;
    if (action.seq !== expectedSeq) throw new TypeError(`action seq ${action.seq} does not follow head seq ${head?.headSeq ?? 0}`);
    const fields = {
      status: status ?? action.newStatus,
      currentSnapshotId: toObjectId(action.newSnapshotId, 'newSnapshotId'),
      headSeq: action.seq,
      headHash: action.hash,
      updatedAt: action.createdAt,
    };
    if (!head) {
      const r = await GwResult.updateOne(
        { _id: id },
        { $setOnInsert: { groupId: toObjectId(action.groupId, 'groupId'), season: action.season, event: action.event, ...fields } },
        { upsert: true, session, runValidators: true },
      );
      if (r.upsertedCount !== 1) throw new ConcurrentDecisionError(id, 'a first decision already exists');
    } else {
      const r = await GwResult.updateOne({ _id: id, headSeq: head.headSeq }, { $set: fields }, { session, runValidators: true });
      if (r.matchedCount !== 1) throw new ConcurrentDecisionError(id, `head moved past seq ${head.headSeq}`);
    }
    return pointerToDomain(await GwResult.findById(id).session(session).lean());
  },

  // ── reads ───────────────────────────────────────────────────────────────

  async getPointer(groupId, season, event, { session } = {}) {
    return pointerToDomain(await GwResult.findById(ids.gwResult(String(groupId), season, event)).session(session ?? null).lean());
  },

  /** A group's decided GWs in a season, latest event first (index group_season_events). */
  async listPointers(groupId, season, { session } = {}) {
    const docs = await GwResult.find({ groupId: toObjectId(groupId, 'groupId'), season }).sort({ event: -1 }).session(session ?? null).lean();
    return docs.map(pointerToDomain);
  },

  async getSnapshot(snapshotId, { session } = {}) {
    return snapshotToDomain(await ResultSnapshot.findById(toObjectId(snapshotId, 'snapshotId')).session(session ?? null).lean());
  },

  async getCurrentSnapshot(groupId, season, event, { session } = {}) {
    const pointer = await this.getPointer(groupId, season, event, { session });
    return pointer ? this.getSnapshot(pointer.currentSnapshotId, { session }) : null;
  },

  /** Every snapshot of a GW, most recently computed first (index group_gw_recent). */
  async listSnapshots(groupId, season, event, { session } = {}) {
    const docs = await ResultSnapshot.find(scopeOf(groupId, season, event)).sort({ computedAt: -1 }).session(session ?? null).lean();
    return docs.map(snapshotToDomain);
  },

  /** The GW's decision history in chain order (seq), never ObjectId order. */
  async listActions(groupId, season, event, { session } = {}) {
    const docs = await GwResultAction.find(scopeOf(groupId, season, event)).sort({ seq: 1 }).session(session ?? null).lean();
    return docs.map(actionToDomain);
  },

  /** A group's latest decisions across GWs (index group_recent). */
  async listRecentActions(groupId, { limit = 20, session } = {}) {
    const docs = await GwResultAction.find({ groupId: toObjectId(groupId, 'groupId') }).sort({ createdAt: -1, seq: -1 })
      .limit(limit).session(session ?? null).lean();
    return docs.map(actionToDomain);
  },

  /** Walks the chain (v0.3 §7 verification): { valid, brokenAtSeq?, reason? }. */
  async verifyChain(groupId, season, event, { session } = {}) {
    const actions = await this.listActions(groupId, season, event, { session });
    const pointer = await this.getPointer(groupId, season, event, { session });
    if (actions.length === 0 && !pointer) return { valid: true };
    const snapIds = [...new Set(actions.map((a) => a.newSnapshotId))];
    const snaps = await ResultSnapshot.find({ _id: { $in: snapIds.map((id) => toObjectId(id, 'snapshotId')) } }).session(session ?? null).lean();
    const snapshotsById = new Map(snaps.map((d) => { const s = snapshotToDomain(d); return [s.id, omitKeys(s, ['id'])]; }));
    if (snapshotsById.size === 0) snapshotsById.set('\0none', {}); // force the SNAPSHOT_MISSING check
    return verifyChain(actions.map((a) => omitKeys(a, ['id'])), { snapshotsById, pointer });
  },

  // ── assemblers ──────────────────────────────────────────────────────────

  /**
   * Input assembler (v0.3 §10 rule 3): everything computeGwResult and canFinalize
   * need, plus the snapshot's sources[] (v0.3 §8).
   * @returns {Promise<{ group, event, eventState, members, gwRows, effectiveSquads, managers, freshness, sources, gate }>}
   *   group: { winnerRule, tieBreakRules, myEntryId } as computeGwResult takes it;
   *   freshness: per member { entryId, syncRunId, syncRunStartedAt, syncRunStatus } from the
   *     lastConfirmedByRunId of its GW row (or, without one, its managerSeasons doc);
   *   gate: { groupActive, dataCheckedObservedAt, resultStatus } for canFinalize.
   */
  async loadResultInputs(groupId, season, event, { session } = {}) {
    const { group, eventDoc, rows, managerSeasons, live } = await loadGroupGw(groupId, season, event, session);
    const entryIds = group.members.map((m) => m.entryId);
    const managerDocs = (await Manager.find({ _id: { $in: entryIds } }).sort({ _id: 1 }).session(session ?? null).lean())
      .map((d) => managerToDomain(d, { withProvenance: true }));
    const pointer = await this.getPointer(group.id, season, event, { session });

    const rowByEntry = new Map(rows.map((r) => [r.entryId, r]));
    const msByEntry = new Map(managerSeasons.map((m) => [m.entryId, m]));
    const confirmingDoc = (entryId) => rowByEntry.get(entryId) ?? msByEntry.get(entryId) ?? null;

    const inputDocs = [eventDoc, live, ...rows, ...managerSeasons, ...managerDocs];
    const runIds = [...new Set(inputDocs.map((d) => d?.provenance?.lastConfirmedByRunId).filter(Boolean))];
    const runs = await loadRuns(runIds, session);

    const liveMap = liveToEngineMap(live);
    const effectiveSquads = new Map();
    for (const r of rows) {
      if (!r.hasPicks) continue;
      effectiveSquads.set(r.entryId, deriveEffectiveSquad({
        picks: r.picks, activeChip: r.activeChip, autoSubs: r.autoSubs, live: liveMap, grossGwPoints: r.points.grossGwPoints,
      }));
    }

    return {
      group: { winnerRule: group.winnerRule, tieBreakRules: group.tieBreakRules, myEntryId: group.myEntryId },
      event,
      eventState: eventDoc?.state ?? null,
      // synced: FPL returned this entry's history in some successful T3 (its managerSeasons doc exists).
      members: group.members.map((m) => memberToEngine(m, msByEntry.has(m.entryId))),
      gwRows: rows.map(toEngineGwRow),
      effectiveSquads,
      managers: new Map(managerDocs.map((m) => [m.entryId, { entryId: m.entryId, playerName: m.playerName, teamName: m.teamName }])),
      freshness: group.members.map(({ entryId }) => {
        const runId = confirmingDoc(entryId)?.provenance?.lastConfirmedByRunId ?? null;
        const run = runId ? runs.get(runId) : null;
        return { entryId, syncRunId: runId, syncRunStartedAt: run?.startedAt ?? null, syncRunStatus: run?.status ?? null };
      }).sort((a, b) => a.entryId - b.entryId),
      sources: buildSources(inputDocs, runs),
      gate: { groupActive: group.isActive, dataCheckedObservedAt: eventDoc?.dataCheckedObservedAt ?? null, resultStatus: pointer?.status ?? null },
    };
  },

  /**
   * Provenance trace (v0.3 §8): gwResults → resultSnapshots.sources[] → syncRuns
   * (requests[].bodySha256 / rawResponseId) → fplRawResponses. Bodies excluded.
   */
  async loadTrace(snapshotId, { session } = {}) {
    const snapshot = await this.getSnapshot(snapshotId, { session });
    if (!snapshot) throw new NotFoundError('snapshot', snapshotId);
    const runIds = snapshot.sources.map((s) => s.syncRunId);
    const runDocs = await SyncRun.find({ _id: { $in: runIds.map((id) => toObjectId(id, 'runId')) } }).session(session ?? null).lean();
    const runsById = new Map(runDocs.map((d) => [String(d._id), syncRunToDomain(d)]));
    const clauses = snapshot.sources.filter((s) => s.requestHashes.length)
      .map((s) => ({ syncRunId: toObjectId(s.syncRunId, 'runId'), bodySha256: { $in: s.requestHashes } }));
    const rawDocs = clauses.length
      ? await FplRawResponse.find({ $or: clauses }, { bodyGzip: 0 }).sort({ capturedAt: 1, path: 1 }).session(session ?? null).lean()
      : [];
    return {
      snapshot,
      sources: snapshot.sources.map((s) => {
        const run = runsById.get(s.syncRunId) ?? null;
        const requests = run ? run.requests.filter((q) => s.requestHashes.includes(q.bodySha256)) : [];
        return { ...s, run, requests };
      }),
      rawResponses: rawDocs.map(rawResponseToDomain),
    };
  },
};
