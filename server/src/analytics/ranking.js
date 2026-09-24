import { SHARED, hasData, tieBreakValue } from './tieBreakers.js';

// Ranking model (architecture v0.2 §6). Pure and deterministic.
// competitionRank comes from the score only; resolvedPosition is a unique order
// after the group's tie-break chain, with entryId ascending as the final key.

/** @param {{ entryId: number, score: number }[]} scores */
export function competitionRanks(scores) {
  const ranks = new Map();
  for (const s of scores) ranks.set(s.entryId, 1 + scores.filter((o) => o.score > s.score).length);
  return ranks;
}

// Orders one tied group; returns [{ row, decidedBy }] where decidedBy says what
// separated the row from the one before it (undefined for the group's first row).
function resolveGroup(group, rules, i) {
  if (group.length === 1) return [{ row: group[0] }];
  if (i >= rules.length) {
    return [...group]
      .sort((a, b) => a.entryId - b.entryId)
      .map((row, k) => (k === 0 ? { row } : { row, decidedBy: 'ENTRY_ID_FALLBACK' }));
  }
  const rule = rules[i];
  if (!hasData(rule, group)) return resolveGroup(group, rules, i + 1);
  const buckets = new Map();
  for (const row of group) {
    const v = tieBreakValue(rule, row);
    if (!buckets.has(v)) buckets.set(v, []);
    buckets.get(v).push(row);
  }
  const out = [];
  for (const v of [...buckets.keys()].sort((a, b) => b - a)) {
    const sub = resolveGroup(buckets.get(v), rules, i + 1);
    if (out.length > 0) sub[0] = { ...sub[0], decidedBy: rule };
    out.push(...sub);
  }
  return out;
}

/**
 * @param {import('./tieBreakers.js').TieBreakRow[]} rows  eligible, scored rows
 * @param {string[]} rules  the group's chain; SHARED (and anything after it) is ignored
 */
export function resolvePositions(rows, rules) {
  const chain = rules.filter((r) => r !== SHARED);
  const byScore = new Map();
  for (const row of rows) {
    if (!byScore.has(row.score)) byScore.set(row.score, []);
    byScore.get(row.score).push(row);
  }
  const ordered = [];
  for (const score of [...byScore.keys()].sort((a, b) => b - a)) {
    const group = resolveGroup(byScore.get(score), chain, 0);
    group[0] = { ...group[0], decidedBy: null };
    ordered.push(...group);
  }
  return ordered.map(({ row, decidedBy }, i) => ({
    entryId: row.entryId,
    resolvedPosition: i + 1,
    positionDecidedBy: decidedBy ?? null,
  }));
}
