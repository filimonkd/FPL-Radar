// Tie-break rules (architecture v0.2 §6, §14). Pure.
//
// Each rule narrows a set of tied candidates to those best on one field and
// returns the input unchanged when it cannot separate them. A rule whose data
// is null for any candidate is skipped (TIE_BREAK_DATA_MISSING).
//
// The v0.1 §10 rule catalogue was not available; the rules below are defined
// from the TieBreakRow fields v0.2 §14 declares, with the direction in the name.
// 'SHARED' is a terminator, not a rule: it stops the chain and shares the win.

export const SHARED = 'SHARED';

/** @typedef {{ entryId: number, score: number, grossGwPoints: number|null, transferCost: number|null,
 *   captainPoints: number|null, pointsOnBench: number|null, activeChip: string|null,
 *   totalPoints: number|null, overallRank: number|null }} TieBreakRow */

// value(row) → comparable number (higher wins) or null when the data is missing.
const RULES = {
  FEWER_TRANSFER_COST: (r) => (r.transferCost == null ? null : -r.transferCost),
  HIGHER_GROSS_POINTS: (r) => (r.grossGwPoints == null ? null : r.grossGwPoints),
  HIGHER_CAPTAIN_POINTS: (r) => (r.captainPoints == null ? null : r.captainPoints),
  FEWER_POINTS_ON_BENCH: (r) => (r.pointsOnBench == null ? null : -r.pointsOnBench),
  // Prefers managers who played no chip; activeChip null is a valid value here.
  NO_CHIP_PLAYED: (r) => (r.activeChip === undefined ? null : r.activeChip === null ? 1 : 0),
  HIGHER_SEASON_TOTAL: (r) => (r.totalPoints == null ? null : r.totalPoints),
  BETTER_OVERALL_RANK: (r) => (r.overallRank == null ? null : -r.overallRank),
};

export const TIE_BREAK_RULES = Object.freeze([...Object.keys(RULES), SHARED]);

export const tieBreakValue = (rule, row) => RULES[rule](row);

export const hasData = (rule, rows) => rows.every((r) => RULES[rule](r) !== null);

/**
 * TIE_BREAKERS[rule](candidates) → the best candidates (non-empty subset), or
 * the input when the rule cannot separate them or data is missing.
 * @type {Record<string, (c: TieBreakRow[]) => TieBreakRow[]>}
 */
export const TIE_BREAKERS = Object.freeze(
  Object.fromEntries(
    Object.keys(RULES).map((rule) => [
      rule,
      (candidates) => {
        if (!hasData(rule, candidates)) return candidates;
        const best = Math.max(...candidates.map((c) => RULES[rule](c)));
        return candidates.filter((c) => RULES[rule](c) === best);
      },
    ]),
  ),
);

export function isValidRuleChain(rules) {
  return Array.isArray(rules) && rules.length > 0 && rules.at(-1) === SHARED &&
    rules.every((r, i) => (r === SHARED ? i === rules.length - 1 : r in RULES)) &&
    new Set(rules).size === rules.length;
}
