import { snapshotHash, actionHash } from '../../audit/hashChain.js';
import { canonicalMixed, idString, toObjectId, omitKeys } from './common.js';

// resultSnapshots / gwResultActions / gwResults ↔ domain (v0.3 §7, §8).
//
// Hashes are computed over the domain form (ids as hex strings, Dates, Mixed
// payloads canonical), which is exactly what toDomain returns when the stored
// document is read back, so verify recomputes the same hashes.

const sourceToDomain = (s) => ({
  syncRunId: idString(s.syncRunId),
  startedAt: s.startedAt ?? null,
  status: s.status ?? null,
  requestHashes: [...(s.requestHashes ?? [])],
});

/**
 * The immutable snapshot fields, normalized (defaults filled, Mixed payloads
 * canonical). No id, no contentHash.
 */
export function normalizeSnapshot(s) {
  return {
    groupId: idString(s.groupId),
    season: s.season,
    event: s.event,
    kind: s.kind,
    winnerRule: s.winnerRule,
    tieBreakRules: [...s.tieBreakRules],
    computedWinnerEntryIds: [...s.computedWinnerEntryIds],
    declaredWinnerEntryIds: [...s.declaredWinnerEntryIds],
    winningScore: s.winningScore ?? null,
    tieBreakApplied: s.tieBreakApplied ?? null,
    tieBreakTrace: canonicalMixed(s.tieBreakTrace),
    standings: canonicalMixed(s.standings),
    inputs: canonicalMixed(s.inputs),
    inputsHash: s.inputsHash,
    eventState: s.eventState,
    engineVersion: s.engineVersion,
    warnings: canonicalMixed(s.warnings ?? []),
    sources: (s.sources ?? []).map(sourceToDomain),
    computedAt: s.computedAt,
  };
}

/** snapshot.contentHash over a normalized domain snapshot (id/contentHash ignored). */
export const snapshotContentHashOf = (snapshot) => snapshotHash(omitKeys(snapshot, ['id', 'contentHash']));

export function snapshotToDomain(doc) {
  if (!doc) return null;
  return { id: idString(doc._id), ...normalizeSnapshot(doc), contentHash: doc.contentHash };
}

export function snapshotToDocument(normalized, contentHash) {
  return {
    ...normalized,
    groupId: toObjectId(normalized.groupId, 'groupId'),
    sources: normalized.sources.map((s) => ({ ...s, syncRunId: toObjectId(s.syncRunId, 'sources.syncRunId') })),
    contentHash,
  };
}

// ── actions ──────────────────────────────────────────────────────────────

/** Action fields (without seq, prevHash, hash), defaults filled — the hash covers all of them. */
export function normalizeActionFields(a) {
  return {
    groupId: idString(a.groupId),
    season: a.season,
    event: a.event,
    action: a.action,
    prevStatus: a.prevStatus,
    newStatus: a.newStatus,
    prevWinnerEntryIds: [...a.prevWinnerEntryIds],
    newWinnerEntryIds: [...a.newWinnerEntryIds],
    prevSnapshotId: idString(a.prevSnapshotId),
    newSnapshotId: idString(a.newSnapshotId),
    newSnapshotHash: a.newSnapshotHash,
    note: a.note ?? null,
    syncRunId: idString(a.syncRunId),
    actor: a.actor ?? 'admin',
    createdAt: a.createdAt,
  };
}

export function actionToDomain(doc) {
  if (!doc) return null;
  return {
    id: idString(doc._id),
    ...normalizeActionFields(doc),
    seq: doc.seq,
    prevHash: doc.prevHash,
    hash: doc.hash,
  };
}

export const actionHashOf = (action) => actionHash(omitKeys(action, ['id']));

export function actionToDocument(a) {
  return {
    ...a,
    groupId: toObjectId(a.groupId, 'groupId'),
    prevSnapshotId: toObjectId(a.prevSnapshotId, 'prevSnapshotId'),
    newSnapshotId: toObjectId(a.newSnapshotId, 'newSnapshotId'),
    syncRunId: toObjectId(a.syncRunId, 'syncRunId'),
  };
}

// ── pointer ──────────────────────────────────────────────────────────────

export function pointerToDomain(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    groupId: idString(doc.groupId),
    season: doc.season,
    event: doc.event,
    status: doc.status,
    currentSnapshotId: idString(doc.currentSnapshotId),
    headSeq: doc.headSeq,
    headHash: doc.headHash,
    updatedAt: doc.updatedAt,
  };
}
