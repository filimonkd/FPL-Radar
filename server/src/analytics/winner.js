import { contentHash } from '../utils/canonical.js';
import { ENGINE_VERSION } from './version.js';
import { EventState, WinnerRule, isReconciled } from './constants.js';
import { selectEligible } from './eligibility.js';
import { competitionRanks, resolvePositions } from './ranking.js';
import { SHARED, TIE_BREAKERS, hasData } from './tieBreakers.js';

// GW winner computation (architecture v0.2 §2, §6, §14 winner.js). Pure.
//
// BLOCKED when any member who would otherwise be eligible is not synced or not
// reconciled: winners = [], but the rows are still returned with reported points.
// The entryId fallback only orders the table; it never picks a winner.

const byName = (managers) => (a, b) => {
  const na = managers.get(a)?.playerName ?? '';
  const nb = managers.get(b)?.playerName ?? '';
  return na.localeCompare(nb) || a - b;
};

/**
 * @param {{
 *   group: { winnerRule: string, tieBreakRules: string[], myEntryId: number|null },
 *   event: number, eventState: string,
 *   members: { entryId: number, isExcluded?: boolean, joinedEvent?: number|null, synced?: boolean }[],
 *   gwRows: (object & { entryId: number, pointsOnBench?: number, activeChip?: string|null, overallRank?: number|null })[],
 *   effectiveSquads?: Map<number, { captainPoints?: number|null }>,
 *   managers?: Map<number, { entryId: number, playerName?: string, teamName?: string }>,
 * }} input
 */
export function computeGwResult({ group, event, eventState, members, gwRows, effectiveSquads = new Map(), managers = new Map() }) {
  const rowByEntry = new Map(gwRows.filter((r) => r.event === event).map((r) => [r.entryId, r]));
  const { eligible, ineligible } = selectEligible(members, rowByEntry, event);
  const warnings = [];
  if (eventState !== EventState.DATA_CHECKED) warnings.push({ code: 'PROVISIONAL_EVENT_STATE', eventState });

  const blockedBy = eligible
    .filter((id) => !rowByEntry.has(id) || !isReconciled(rowByEntry.get(id).reconciliationStatus))
    .map((id) => ({ entryId: id, reconciliationStatus: rowByEntry.get(id)?.reconciliationStatus ?? 'NOT_SYNCED' }));
  const status = blockedBy.length ? 'BLOCKED' : 'PROVISIONAL';

  const scoreOf = (row) => (group.winnerRule === WinnerRule.GROSS_POINTS ? row.grossGwPoints : row.netGwPoints);
  const tieRow = (id) => {
    const r = rowByEntry.get(id);
    const squad = effectiveSquads.get(id);
    return {
      entryId: id,
      score: scoreOf(r),
      grossGwPoints: r.grossGwPoints,
      transferCost: r.transferCost,
      captainPoints: squad?.captainPoints ?? null,
      pointsOnBench: r.pointsOnBench ?? null,
      activeChip: r.activeChip === undefined ? undefined : r.activeChip,
      totalPoints: r.totalPoints ?? null,
      overallRank: r.overallRank ?? null,
    };
  };

  let winners = [];
  let winningScore = null;
  let tieBreakApplied = null;
  const tieBreakTrace = [];
  const ranks = new Map();
  const positions = new Map();

  if (status === 'PROVISIONAL' && eligible.length > 0) {
    const scored = eligible.map(tieRow);
    for (const [id, rank] of competitionRanks(scored)) ranks.set(id, rank);
    for (const p of resolvePositions(scored, group.tieBreakRules)) positions.set(p.entryId, p);

    let candidates = scored.filter((r) => ranks.get(r.entryId) === 1);
    winningScore = candidates[0].score;
    for (const rule of group.tieBreakRules) {
      if (candidates.length === 1) break;
      if (rule === SHARED) {
        tieBreakApplied = SHARED;
        tieBreakTrace.push({ rule, remaining: candidates.map((c) => c.entryId) });
        break;
      }
      const missing = !hasData(rule, candidates);
      const next = TIE_BREAKERS[rule](candidates);
      tieBreakTrace.push({
        rule,
        remaining: next.map((c) => c.entryId),
        ...(missing ? { note: 'TIE_BREAK_DATA_MISSING' } : {}),
      });
      if (missing) warnings.push({ code: 'TIE_BREAK_DATA_MISSING', rule });
      if (next.length < candidates.length) tieBreakApplied = rule;
      candidates = next;
    }
    if (candidates.length > 1 && tieBreakApplied !== SHARED) tieBreakApplied = SHARED;
    winners = candidates.map((c) => c.entryId).sort((a, b) => a - b);
  }

  const winnerSet = new Set(winners);
  const ineligibleReason = new Map(ineligible.map((i) => [i.entryId, i.reason]));
  const rows = members.map(({ entryId }) => {
    const r = rowByEntry.get(entryId);
    const m = managers.get(entryId);
    const rank = ranks.get(entryId) ?? null;
    return {
      entryId,
      playerName: m?.playerName ?? null,
      teamName: m?.teamName ?? null,
      reportedGwPoints: r?.reportedGwPoints ?? null,
      grossGwPoints: r?.grossGwPoints ?? null,
      netGwPoints: r?.netGwPoints ?? null,
      transferCost: r?.transferCost ?? null,
      score: r && isReconciled(r.reconciliationStatus) ? scoreOf(r) : null,
      reconciliationStatus: r?.reconciliationStatus ?? (ineligibleReason.has(entryId) ? null : 'NOT_SYNCED'),
      competitionRank: rank,
      resolvedPosition: positions.get(entryId)?.resolvedPosition ?? null,
      positionDecidedBy: positions.get(entryId)?.positionDecidedBy ?? null,
      tiedWith: rank === null ? [] : [...ranks].filter(([id, rk]) => rk === rank && id !== entryId).map(([id]) => id).sort((a, b) => a - b),
      ineligibleReason: ineligibleReason.get(entryId) ?? null,
      isWinner: winnerSet.has(entryId),
      isMe: group.myEntryId === entryId,
    };
  });
  // Positioned rows by resolvedPosition, then unpositioned rows by name.
  const ordering = byName(managers);
  rows.sort((a, b) =>
    a.resolvedPosition !== null && b.resolvedPosition !== null ? a.resolvedPosition - b.resolvedPosition
      : a.resolvedPosition !== null ? -1
        : b.resolvedPosition !== null ? 1
          : ordering(a.entryId, b.entryId));

  const inputs = {
    group,
    event,
    eventState,
    members: [...members].sort((a, b) => a.entryId - b.entryId),
    gwRows: [...rowByEntry.values()].sort((a, b) => a.entryId - b.entryId),
    effectiveSquads: [...effectiveSquads].sort(([a], [b]) => a - b).map(([entryId, s]) => ({ entryId, captainPoints: s.captainPoints ?? null })),
  };

  return {
    status,
    blockedBy,
    winners,
    winningScore,
    tieBreakApplied,
    tieBreakTrace,
    rows,
    inputs,
    inputsHash: contentHash(inputs),
    engineVersion: ENGINE_VERSION,
    warnings,
  };
}
