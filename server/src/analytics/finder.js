import { ownersByElement } from './news.js';

// Differential & value finder (Step 19). Pure: the players view (Step 17) and
// the group's latest squads in, filtered and sorted candidates out. Missing
// data never passes a filter it would be judged by, and sorts last.

export const FINDER_SORTS = Object.freeze(['value', 'form', 'xpts', 'fdr']);
export const POSITIONS = Object.freeze(['GKP', 'DEF', 'MID', 'FWD']);
/** Statuses that count as fit: FPL "a" (available). Unknown status is not hidden. */
const FIT = (status) => status == null || status === 'a';
/** Fixture run average difficulty below which a run is called easy. */
export const EASY_FDR = 3.0;

/** Season points per £1m of current price, one decimal; null without data. */
export const pointsPerMillion = (totalPoints, priceTenths) => (totalPoints == null || !priceTenths ? null : Math.round((totalPoints / (priceTenths / 10)) * 10) / 10);

const METRIC = {
  value: (p) => p.pointsPerMillion,
  form: (p) => p.formTenths,
  xpts: (p) => p.epNextTenths,
  fdr: (p) => p.fixtures?.avgFdr ?? null,
};
const ASCENDING = { fdr: true };

/**
 * @param {{ players: object[], squads: { entryId: number, elementIds: number[] }[], myEntryId?: number|null,
 *           filters?: { position?: string, maxPriceTenths?: number, maxSelectedByTenths?: number, maxGroupOwners?: number, fitOnly?: boolean },
 *           sort?: string, limit?: number }} input
 * @returns {{ total: number, groupOf: number, rows: object[] }}
 *   total: matches before the limit; groupOf: squads known (the "of" in 0/10).
 */
export function findPlayers({ players, squads, myEntryId = null, filters = {}, sort = 'value', limit = 50 }) {
  if (!FINDER_SORTS.includes(sort)) throw new RangeError(`unknown sort ${sort}`);
  const owners = ownersByElement(squads);
  const f = filters;
  const rows = players
    .map((p) => {
      const ownedBy = owners.get(p.elementId) ?? [];
      return { ...p, pointsPerMillion: pointsPerMillion(p.totalPoints, p.priceTenths), groupOwners: ownedBy.length, ownedByMe: myEntryId != null && ownedBy.includes(myEntryId) };
    })
    .filter((p) => (f.position == null || p.position === f.position)
      && (f.maxPriceTenths == null || (p.priceTenths != null && p.priceTenths <= f.maxPriceTenths))
      && (f.maxSelectedByTenths == null || (p.selectedByTenths != null && p.selectedByTenths <= f.maxSelectedByTenths))
      && (f.maxGroupOwners == null || p.groupOwners <= f.maxGroupOwners)
      && (!f.fitOnly || FIT(p.status)));
  const metric = METRIC[sort];
  const asc = ASCENDING[sort] === true;
  rows.sort((a, b) => {
    const x = metric(a);
    const y = metric(b);
    if (x !== y) {
      if (x == null) return 1;
      if (y == null) return -1;
      return asc ? x - y : y - x;
    }
    return (b.pointsPerMillion ?? -Infinity) - (a.pointsPerMillion ?? -Infinity) || a.elementId - b.elementId;
  });
  return {
    total: rows.length,
    groupOf: squads.length,
    rows: rows.slice(0, limit).map((p) => ({
      elementId: p.elementId,
      webName: p.webName,
      team: p.team ?? null,
      position: p.position ?? null,
      status: p.status ?? null,
      chanceNext: p.chanceNext ?? null,
      priceTenths: p.priceTenths,
      totalPoints: p.totalPoints ?? null,
      pointsPerMillion: p.pointsPerMillion,
      formTenths: p.formTenths ?? null,
      epNextTenths: p.epNextTenths ?? null,
      selectedByTenths: p.selectedByTenths ?? null,
      groupOwners: p.groupOwners,
      ownedByMe: p.ownedByMe,
      last5: p.last?.[5] ?? null,
      fixtures: p.fixtures,
      easyRun: p.fixtures?.avgFdr != null && p.fixtures.avgFdr < EASY_FDR,
    })),
  };
}
