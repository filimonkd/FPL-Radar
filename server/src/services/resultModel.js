import { computeGwResult, canFinalize, selectEligible, isReconciled } from '../analytics/index.js';
import { canonicalJson } from '../utils/canonical.js';

// Pure result-model helpers for the result service (architecture v0.2 §2–§4,
// §14–§15; v0.3 §7–§8). No I/O: the service loads inputs through repositories
// and persists through resultRepo. Every decision (eligibility, ranking,
// tie-breaks, winners, the finalize gate) is made by the unchanged analytics
// engine; this module only feeds it and records what it decided.

/**
 * The finalize gate (v0.2 §3) for already-assembled inputs.
 *
 * canFinalize is called unchanged. Two service rules narrow what it sees:
 *   1. FINALIZE-run confirmation: when `finalizeRunId` is given, an eligible
 *      member counts as fresh only if its data was confirmed by that run. Any
 *      other confirmation (e.g. an older SUCCESS run, when this member failed in
 *      the finalize sync) is passed as having no successful run → STALE_SYNC.
 *   2. Semantics consistency (v0.2 §2): a reconciled hit row (C > 0) needs the
 *      season's semantics to be verified and equal to the row's. CONFLICTED
 *      marks every hit row SEMANTICS_CONFLICT, and UNVERIFIED can only remain
 *      while no hit row has reconciled; rows with C = 0 are semantics-independent.
 *      If the season changed during the finalize sync itself, the stored rows
 *      still carry the old verdict, so this re-check blocks instead of trusting them.
 *
 * @param {ReturnType<import('../repositories/resultRepo.js').resultRepo['loadResultInputs']> extends Promise<infer T> ? T : never} inputs
 * @param {{ resultStatus: string|null, finalizeRunId?: string|null, seasonSemantics: string }} ctx
 */
export function evaluateFinalizeGate(inputs, { resultStatus, finalizeRunId = null, seasonSemantics }) {
  const rowByEntry = new Map(inputs.gwRows.map((r) => [r.entryId, r]));
  const { eligible, ineligible } = selectEligible(inputs.members, rowByEntry, inputs.event);
  const freshness = new Map(inputs.freshness.map((f) => [f.entryId, f]));
  const notConfirmedByFinalizeRun = [];
  const eligibleRows = eligible.map((entryId) => {
    const f = freshness.get(entryId) ?? { syncRunId: null, syncRunStartedAt: null, syncRunStatus: null };
    const confirmed = !finalizeRunId || f.syncRunId === finalizeRunId;
    if (!confirmed) notConfirmedByFinalizeRun.push(entryId);
    return {
      entryId,
      reconciliationStatus: rowByEntry.get(entryId)?.reconciliationStatus ?? null,
      syncRunStartedAt: confirmed ? f.syncRunStartedAt : null,
      syncRunStatus: confirmed ? f.syncRunStatus : null,
    };
  });
  const gate = canFinalize({
    groupActive: inputs.gate.groupActive,
    eventState: inputs.eventState,
    resultStatus,
    dataCheckedObservedAt: inputs.gate.dataCheckedObservedAt,
    eligibleRows,
  });

  const semanticsReasons = [];
  const hitRows = eligible.map((id) => rowByEntry.get(id)).filter((r) => r && r.transferCost > 0 && isReconciled(r.reconciliationStatus));
  if (hitRows.length) {
    if (seasonSemantics === 'CONFLICTED') semanticsReasons.push('SEMANTICS_CONFLICTED');
    else if (seasonSemantics === 'UNVERIFIED') semanticsReasons.push('SEMANTICS_UNVERIFIED');
    else if (hitRows.some((r) => r.pointsSemantics !== seasonSemantics)) semanticsReasons.push('SEMANTICS_MISMATCH');
  }
  const reasons = [...gate.reasons, ...semanticsReasons];
  return {
    allowed: reasons.length === 0,
    reasons,
    details: {
      eligible,
      ineligible,
      notConfirmedByFinalizeRun,
      unreconciled: eligibleRows.filter((r) => !isReconciled(r.reconciliationStatus)).map((r) => ({ entryId: r.entryId, reconciliationStatus: r.reconciliationStatus })),
      seasonSemantics,
    },
  };
}

/** computeGwResult on assembled inputs (managers included, so standings carry names). */
export const computeResult = (inputs) => computeGwResult({
  group: inputs.group,
  event: inputs.event,
  eventState: inputs.eventState,
  members: inputs.members,
  gwRows: inputs.gwRows,
  effectiveSquads: inputs.effectiveSquads,
  managers: inputs.managers,
});

/**
 * The stored decision trace (snapshot.tieBreakTrace): who was eligible, who
 * shared the top score, what each tie-break rule left, which rule decided, and
 * whether the result is a single winner, SHARED, or none (BLOCKED). Built only
 * from the engine's output; entryId never decides anything here.
 */
export function explainDecision(result) {
  const byId = (a, b) => a - b;
  const eligible = result.rows.filter((r) => r.ineligibleReason === null).map((r) => r.entryId).sort(byId);
  const ineligible = result.rows.filter((r) => r.ineligibleReason !== null).map((r) => ({ entryId: r.entryId, reason: r.ineligibleReason })).sort((a, b) => a.entryId - b.entryId);
  const topScoreTied = result.rows.filter((r) => r.competitionRank === 1).map((r) => r.entryId).sort(byId);
  return {
    status: result.status,
    eligible,
    ineligible,
    blockedBy: result.blockedBy,
    winningScore: result.winningScore,
    topScoreTied,
    steps: result.tieBreakTrace,
    decidedBy: result.tieBreakApplied,
    outcome: result.winners.length === 0 ? 'NONE' : result.winners.length === 1 ? 'SINGLE' : 'SHARED',
    winners: result.winners,
  };
}

const managersList = (managers) => [...managers.values()]
  .map((m) => ({ entryId: m.entryId, playerName: m.playerName ?? null, teamName: m.teamName ?? null }))
  .sort((a, b) => a.entryId - b.entryId);

/**
 * resultSnapshots document content (v0.3 §8): standings, the exact engine inputs
 * (plus the manager names passed to it), inputsHash, engine version, trace,
 * warnings and the embedded sources[]. Canonicalization and hashing happen in
 * resultRepo.insertSnapshot (shared canonical.js / hashChain.js).
 */
export function buildSnapshotInput({ groupId, season, inputs, result, kind = 'RULE_BASED', declaredWinnerEntryIds = result.winners, computedAt }) {
  return {
    groupId,
    season,
    event: inputs.event,
    kind,
    winnerRule: inputs.group.winnerRule,
    tieBreakRules: inputs.group.tieBreakRules,
    computedWinnerEntryIds: result.winners,
    declaredWinnerEntryIds,
    winningScore: result.winningScore,
    tieBreakApplied: result.tieBreakApplied,
    tieBreakTrace: explainDecision(result),
    standings: result.rows,
    inputs: { ...result.inputs, managers: managersList(inputs.managers) },
    inputsHash: result.inputsHash,
    eventState: inputs.eventState,
    engineVersion: result.engineVersion,
    warnings: result.warnings,
    sources: inputs.sources,
    computedAt,
  };
}

/** Rebuilds the engine inputs stored in a snapshot (canonical form) and recomputes. */
export function recomputeFromSnapshot(snapshot) {
  const i = snapshot.inputs;
  return computeGwResult({
    group: i.group,
    event: i.event,
    eventState: i.eventState,
    members: i.members,
    gwRows: i.gwRows,
    effectiveSquads: new Map(i.effectiveSquads.map((s) => [s.entryId, { captainPoints: s.captainPoints }])),
    managers: new Map((i.managers ?? []).map((m) => [m.entryId, m])),
  });
}

/**
 * Reproducibility check (v0.2 §9 tamper check): recompute from the stored
 * inputs and compare. An engine-version difference is reported, never "fixed".
 */
export function verifySnapshotReproduces(snapshot, { engineVersion }) {
  const r = recomputeFromSnapshot(snapshot);
  const mismatches = [];
  const same = (a, b) => canonicalJson(a) === canonicalJson(b);
  if (r.inputsHash !== snapshot.inputsHash) mismatches.push('INPUTS_HASH');
  if (!same(r.winners, snapshot.computedWinnerEntryIds)) mismatches.push('WINNERS');
  if ((r.winningScore ?? null) !== (snapshot.winningScore ?? null)) mismatches.push('WINNING_SCORE');
  if ((r.tieBreakApplied ?? null) !== (snapshot.tieBreakApplied ?? null)) mismatches.push('TIE_BREAK_APPLIED');
  if (!same(explainDecision(r), snapshot.tieBreakTrace)) mismatches.push('TRACE');
  if (!same(r.rows, snapshot.standings)) mismatches.push('STANDINGS');
  return {
    reproducible: mismatches.length === 0,
    mismatches,
    storedEngineVersion: snapshot.engineVersion,
    currentEngineVersion: engineVersion,
    engineChanged: snapshot.engineVersion !== engineVersion,
  };
}

/** Row-level diff for a recompute preview: changed winners and changed rank / score rows. */
export function diffResults(previous, next) {
  const key = (r) => canonicalJson([r.score ?? null, r.competitionRank ?? null, r.resolvedPosition ?? null, r.isWinner ?? false, r.reconciliationStatus ?? null]);
  const prev = new Map((previous?.standings ?? []).map((r) => [r.entryId, key(r)]));
  const changedEntryIds = next.rows.filter((r) => prev.get(r.entryId) !== key(r)).map((r) => r.entryId).sort((a, b) => a - b);
  const oldWinners = previous?.declaredWinnerEntryIds ?? [];
  return {
    oldWinners,
    newWinners: next.winners,
    winnersChanged: canonicalJson([...oldWinners].sort((a, b) => a - b)) !== canonicalJson(next.winners),
    changedEntryIds,
  };
}
