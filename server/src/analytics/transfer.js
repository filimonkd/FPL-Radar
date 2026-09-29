import { sellingPrice } from './playerStats.js';

// Transfer simulator (Step 20). Pure. Every projected number is an estimate:
//   GW+1      FPL's own expected points (ep_next), as published;
//   GW+2..+5  a per-game base times a fixture-difficulty factor per fixture.
// The per-game base is ep_next divided by his team's GW+1 fixture count; when
// GW+1 is a blank (no ep_next signal) it falls back to FPL form. A blank GW
// projects 0; a double counts both games.

export const PROJECTION_GWS = 5;
export const HIT_COST = 4;
export const MAX_PER_CLUB = 3;
/** Fixture difficulty (FPL 1–5) → multiplier on the per-game base. Unknown difficulty counts as 3. */
export const FDR_FACTOR = Object.freeze({ 1: 1.2, 2: 1.1, 3: 1.0, 4: 0.9, 5: 0.8 });

const r1 = (x) => Math.round(x * 10) / 10;
const factor = (fdr) => FDR_FACTOR[fdr] ?? 1;

/**
 * @param {{ teamId: number, epNextTenths: number|null, formTenths?: number|null }} player
 * @param {{ event: number, teamH: number, teamA: number, teamHFdr: number|null, teamAFdr: number|null }[]} fixtures
 * @returns {{ basis: 'EP_NEXT'|'FORM'|null, perGw: { gw: number, games: number, points: number|null, source: 'FPL'|'ESTIMATE' }[] }}
 */
export function projectPoints(player, fixtures, event, horizon = PROJECTION_GWS) {
  const gws = Array.from({ length: horizon }, (_, i) => event + 1 + i).filter((g) => g <= 38);
  const games = (gw) => fixtures
    .filter((f) => f.event === gw && (f.teamH === player.teamId || f.teamA === player.teamId))
    .map((f) => (f.teamH === player.teamId ? f.teamHFdr : f.teamAFdr));
  const ep = player.epNextTenths == null ? null : player.epNextTenths / 10;
  const first = gws.length ? games(gws[0]).length : 0;
  let basis = null;
  let base = null;
  if (ep != null && first > 0) {
    basis = 'EP_NEXT';
    base = ep / first;
  } else if (player.formTenths != null) {
    basis = 'FORM';
    base = player.formTenths / 10;
  }
  const perGw = gws.map((gw, i) => {
    const g = games(gw);
    if (i === 0 && ep != null) return { gw, games: g.length, points: r1(ep), source: 'FPL' };
    return { gw, games: g.length, points: base == null ? null : r1(g.reduce((s, fdr) => s + base * factor(fdr), 0)), source: 'ESTIMATE' };
  });
  return { basis, perGw };
}

/**
 * Break-even of swapping `out` for `in` over the projection window.
 * Pays off at the first GW where the cumulative gain reaches the hit cost
 * (and is above 0, so a free transfer must actually gain).
 * @returns {{ hitCost: number, perGw: object[], total: number|null, net: number|null,
 *             verdict: 'PAYS_OFF'|'DOES_NOT_PAY'|'UNKNOWN', withinGws: number|null, basis: { out, in } }}
 */
export function breakEven(outProjection, inProjection, { hit = true } = {}) {
  const hitCost = hit ? HIT_COST : 0;
  let cumulative = 0;
  let unknown = false;
  let withinGws = null;
  const perGw = outProjection.perGw.map((o, i) => {
    const n = inProjection.perGw[i];
    if (o.points == null || n?.points == null) unknown = true;
    const gain = unknown ? null : r1(n.points - o.points);
    if (!unknown) cumulative = r1(cumulative + gain);
    const row = { gw: o.gw, out: o.points, in: n?.points ?? null, gain, cumulative: unknown ? null : cumulative, source: o.source === 'FPL' && n?.source === 'FPL' ? 'FPL' : 'ESTIMATE' };
    if (!unknown && withinGws == null && cumulative > 0 && cumulative >= hitCost) withinGws = i + 1;
    return row;
  });
  const total = unknown ? null : cumulative;
  return {
    hitCost,
    perGw,
    total,
    net: total == null ? null : r1(total - hitCost),
    verdict: unknown ? 'UNKNOWN' : withinGws != null ? 'PAYS_OFF' : 'DOES_NOT_PAY',
    withinGws,
    basis: { out: outProjection.basis, in: inProjection.basis },
  };
}

/**
 * Money and rule checks for one transfer against my latest squad.
 * @param {{ squad: { elementId, teamId, position }[], out: { elementId, teamId, position, sellingTenths }, in: { elementId, teamId, position, priceTenths }, bankTenths: number|null }} input
 */
export function transferCheck({ squad, out, in: buy, bankTenths }) {
  const clubCount = squad.filter((p) => p.elementId !== out.elementId && p.teamId === buy.teamId).length + 1;
  const bankAfterTenths = bankTenths == null || out.sellingTenths == null || buy.priceTenths == null ? null : bankTenths + out.sellingTenths - buy.priceTenths;
  return {
    samePosition: out.position === buy.position,
    alreadyOwned: squad.some((p) => p.elementId === buy.elementId),
    clubCount,
    clubLimitBroken: clubCount > MAX_PER_CLUB,
    priceDiffTenths: buy.priceTenths == null || out.sellingTenths == null ? null : buy.priceTenths - out.sellingTenths,
    bankAfterTenths,
    affordable: bankAfterTenths == null ? null : bankAfterTenths >= 0,
  };
}

export { sellingPrice };
