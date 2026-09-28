import { Types } from 'mongoose';
import { withTransaction } from '../../src/db/unitOfWork.js';
import { sha256 } from '../../src/utils/canonical.js';
import {
  seasonRepo, eventRepo, managerRepo, managerSeasonRepo, managerGameweekRepo, liveRepo, playerRepo, syncRunRepo, rawResponseRepo, resultRepo,
} from '../../src/repositories/index.js';
import { picks15 } from './docs.js';

// Synthetic sync data written through the repositories exactly as the Step 7
// sync will (T1 → players → T3 per member → live). No real FPL data.

export const SEASON = '2026-27';
export const GW = 5;
export const OBSERVED_AT = new Date('2026-09-22T18:00:00Z'); // DATA_CHECKED observed
export const newId = () => new Types.ObjectId().toHexString();
export const hashOf = (label) => sha256(label);

export const eventValue = (over = {}) => ({
  season: SEASON, gw: GW, deadlineTime: new Date('2026-09-19T10:00:00Z'), isCurrent: true, isNext: false, finished: true, dataChecked: true,
  state: 'DATA_CHECKED', dataCheckedObservedAt: OBSERVED_AT,
  fixtures: [{ id: 41, teamH: 1, teamA: 2, teamHFdr: 3, teamAFdr: 2, kickoffTime: new Date('2026-09-20T14:00:00Z'), started: true, finished: true, finishedProvisional: true, teamHScore: 1, teamAScore: 0 }],
  ...over,
});

export const seasonValue = (over = {}) => ({
  season: SEASON,
  teams: [{ id: 1, name: 'Club A', shortName: 'CLA' }, { id: 2, name: 'Club B', shortName: 'CLB' }],
  unscheduledFixtures: [],
  chipRules: { source: 'FPL_BOOTSTRAP', rules: [{ chipName: 'bboost', startEvent: 1, stopEvent: 19, number: 1, chipType: 'team' }] },
  ...over,
});

/** A GW row. `reconciled` rows carry net/gross; the others keep them null. */
export function gwRow(entryId, { event = GW, R = 60, C = 0, T = 300, net = R, gross = R, status = 'RECONCILED_NO_COST', semantics = 'UNVERIFIED', hypothesis = 'NET', hasPicks = true, captainOffset = 0 } = {}) {
  const picks = picks15().map((p, i) => ({ ...p, isCaptain: i === captainOffset, isViceCaptain: i === (captainOffset + 1) % 11, fplMultiplier: i === captainOffset ? 2 : i < 11 ? 1 : 0 }));
  const reconciled = status === 'RECONCILED' || status === 'RECONCILED_NO_COST';
  return {
    season: SEASON, entryId, event,
    points: {
      reportedGwPoints: R, transferCost: C, netGwPoints: reconciled ? net : null, grossGwPoints: reconciled ? gross : null,
      totalPoints: T, previousTotalPoints: T - (reconciled ? net : R), picksReportedPoints: R, pointsSemantics: semantics,
      reconciliationStatus: status, reconciliationDetail: { delta: reconciled ? net : null, hypothesis, picksPoints: R },
    },
    eventTransfers: C ? 2 : 0, pointsOnBench: 3, overallRank: null, bankTenths: 5, teamValueTenths: 1000, activeChip: null,
    hasPicks, picks: hasPicks ? picks : [], autoSubs: [],
  };
}

export const run = (runDoc, at = new Date(runDoc.startedAt.getTime() + 60_000)) => ({ runId: runDoc.id, startedAt: runDoc.startedAt, at });

/** Inserts a RUNNING run started `minutesAfter` minutes after DATA_CHECKED was observed. */
export async function startRun({ lease = null, trigger = 'FINALIZE', target = null, minutesAfter = 30 } = {}) {
  return syncRunRepo.insert({
    id: lease ? String(lease.owner) : undefined, job: 'group-gw', target, season: SEASON, event: GW, trigger,
    lockId: lease?.lockId ?? null, lockFencingToken: lease?.fencingToken ?? null,
    startedAt: new Date(OBSERVED_AT.getTime() + minutesAfter * 60_000),
  });
}

/** Logs a fetched body on the run, storing it as FINAL_EVIDENCE; returns its hash. */
export async function fetchBody(runDoc, path, body, { reason = 'FINAL_EVIDENCE' } = {}) {
  const stored = await rawResponseRepo.insert({ syncRunId: runDoc.id, path, httpStatus: 200, contentType: 'application/json', body, reason, capturedAt: runDoc.startedAt });
  const hash = stored.stored ? stored.rawResponse.bodySha256 : stored.bodySha256;
  await syncRunRepo.pushRequest(runDoc.id, {
    path, httpStatus: 200, bodySha256: hash, bytes: Buffer.byteLength(body), durationMs: 12, schemaOk: true, fromCache: false,
    rawResponseId: stored.stored ? stored.rawResponse.id : null,
  });
  return { hash, rawResponse: stored.rawResponse ?? null };
}

/**
 * Full synthetic sync for `members` ({ entryId, row }) under `lease` (fenced T1/T3).
 * Returns the run and the request hashes by role.
 */
export async function syncAll({ lease, members, runDoc, live = null }) {
  const ctx = run(runDoc);
  const boot = await fetchBody(runDoc, '/bootstrap-static/', '{"events":[]}', { reason: 'SMOKE' });
  const fixtures = await fetchBody(runDoc, '/fixtures/', '{"fixtures":[]}', { reason: 'SMOKE' });
  await withTransaction(async (session) => {
    await lease.fence(session);
    await seasonRepo.replaceTeamsAndChipRules(seasonValue(), ctx, { session, sourceRequests: { season: { bootstrap: boot.hash }, chipRules: { bootstrap: boot.hash } } });
    await eventRepo.bulkUpsert([eventValue()], ctx, { session, sourceRequests: { bootstrap: boot.hash, fixtures: fixtures.hash } });
  });
  await playerRepo.bulkUpsert(Array.from({ length: 15 }, (_, i) => ({ season: SEASON, elementId: i + 1, webName: `P${i + 1}`, teamId: 1 + (i % 2), elementType: 1 + (i % 4), priceTenths: 50 + i, status: 'a' })), ctx, { sourceRequests: { bootstrap: boot.hash } });

  const hashes = {};
  for (const { entryId, row, profile } of members) {
    const history = await fetchBody(runDoc, `/entry/${entryId}/history/`, JSON.stringify({ entry: entryId, current: [row.points] }));
    const picks = await fetchBody(runDoc, `/entry/${entryId}/event/${GW}/picks/`, JSON.stringify({ entry: entryId, picks: row.picks }));
    hashes[entryId] = { history: history.hash, picks: picks.hash };
    await withTransaction(async (session) => {
      await lease.fence(session);
      await managerRepo.upsertProfiles([profile ?? { entryId, playerName: `Manager ${entryId}`, teamName: `Team ${entryId}` }], ctx, { session, sourceRequests: { entry: history.hash } });
      await managerSeasonRepo.upsert({ season: SEASON, entryId, chips: [], transfers: [] }, ctx, { session, sourceRequests: { history: history.hash } });
      await managerGameweekRepo.bulkUpsertSeasonRows(SEASON, entryId, [row], ctx, { session, sourceRequests: { history: history.hash, picks: picks.hash } });
    });
  }
  const liveBody = await fetchBody(runDoc, `/event/${GW}/live/`, '{"elements":[]}');
  await liveRepo.replace(live ?? { season: SEASON, gw: GW, elements: Array.from({ length: 15 }, (_, i) => ({ elementId: i + 1, totalPoints: i < 11 ? 5 : 1, minutes: 90, settled: true })) }, ctx, { sourceRequests: { live: liveBody.hash } });
  return { hashes, liveHash: liveBody.hash, bootstrapHash: boot.hash };
}

/**
 * The T4 decision transaction (v0.3 §7), driven through the repositories in the
 * specified order. The result service that wraps this lands in Step 9.
 */
export async function decide({ lease, groupId, action, snapshot: snapshotInput, note = null, syncRunId = null, at, beforeAppend = null }) {
  const { season, event } = snapshotInput;
  return withTransaction(async (session) => {
    await lease.fence(session);
    const head = await resultRepo.getPointer(groupId, season, event, { session });
    const prev = head ? await resultRepo.getSnapshot(head.currentSnapshotId, { session }) : null;
    const snapshot = await resultRepo.insertSnapshot(snapshotInput, { session });
    if (beforeAppend) await beforeAppend(session);
    const appended = await resultRepo.appendAction(head, {
      groupId, season, event, action,
      prevStatus: head?.status ?? 'PROVISIONAL',
      newStatus: action === 'OVERRIDE' ? 'OVERRIDDEN' : 'FINAL',
      prevWinnerEntryIds: prev?.declaredWinnerEntryIds ?? [],
      newWinnerEntryIds: snapshot.declaredWinnerEntryIds,
      prevSnapshotId: head?.currentSnapshotId ?? null,
      newSnapshotId: snapshot.id,
      newSnapshotHash: snapshot.contentHash,
      note, syncRunId, createdAt: at,
    }, { session });
    const pointer = await resultRepo.movePointer(head, appended, { session });
    await syncRunRepo.unsetExpiry(snapshot.sources.map((s) => s.syncRunId), { session });
    await rawResponseRepo.unsetEvidenceExpiry(snapshot.sources, snapshot.id, { session });
    return { head, snapshot, action: appended, pointer };
  });
}

/** Snapshot input from a computeGwResult() result and the assembled inputs. */
export function snapshotFrom(groupId, result, inputs, { kind = 'RULE_BASED', declared = result.winners, computedAt, group } = {}) {
  return {
    groupId, season: SEASON, event: inputs.event, kind, winnerRule: group.winnerRule, tieBreakRules: group.tieBreakRules,
    computedWinnerEntryIds: result.winners, declaredWinnerEntryIds: declared, winningScore: result.winningScore,
    tieBreakApplied: result.tieBreakApplied, tieBreakTrace: result.tieBreakTrace, standings: result.rows, inputs: result.inputs,
    inputsHash: result.inputsHash, eventState: inputs.eventState, engineVersion: result.engineVersion, warnings: result.warnings,
    sources: inputs.sources, computedAt,
  };
}
