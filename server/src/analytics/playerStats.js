// Player statistics shared by the news tracker, differential finder, transfer
// simulator and wildcard planner (Step 17). Pure: plain objects in and out, no
// database, clock or randomness. Missing data is reported, never read as 0.

/** Rotation risk: fewer than 60 minutes in at least 2 of the last 3 games. */
export const ROTATION_RULE = Object.freeze({ games: 3, minMinutes: 60, shortGames: 2 });
export const FIXTURE_WINDOW = 3;

/**
 * Points and minutes over the last `n` GWs up to and including `uptoGw`.
 * @param {{ gw: number, points: number, minutes: number }[]} history  one player's stored GWs
 * @returns {{ points: number|null, minutes: number|null, gws: number, of: number }}
 *   gws = how many of the n GWs have stored data; points/minutes are null when none do.
 */
export function pointsOver(history, uptoGw, n) {
  const from = uptoGw - n + 1;
  const rows = history.filter((h) => h.gw >= Math.max(1, from) && h.gw <= uptoGw);
  if (rows.length === 0) return { points: null, minutes: null, gws: 0, of: Math.min(n, uptoGw) };
  return {
    points: rows.reduce((s, h) => s + h.points, 0),
    minutes: rows.reduce((s, h) => s + h.minutes, 0),
    gws: rows.length,
    of: Math.min(n, uptoGw),
  };
}

/**
 * Rotation risk over the player's last `ROTATION_RULE.games` games up to `uptoGw`.
 * A "game" is a GW in which his team had a fixture (blank GWs are skipped);
 * without fixture information every stored GW counts.
 * @param {{ gw: number, minutes: number }[]} history
 * @param {(gw: number) => number} [fixturesInGw]  the player's team's fixture count in a GW
 * @returns {{ risk: boolean|null, short: number, games: number }}  risk null when fewer than 3 games are known
 */
export function rotationRisk(history, uptoGw, fixturesInGw = null) {
  const games = history
    .filter((h) => h.gw <= uptoGw && (!fixturesInGw || fixturesInGw(h.gw) > 0))
    .sort((a, b) => b.gw - a.gw)
    .slice(0, ROTATION_RULE.games);
  const short = games.filter((h) => h.minutes < ROTATION_RULE.minMinutes).length;
  if (games.length < ROTATION_RULE.games) return { risk: null, short, games: games.length };
  return { risk: short >= ROTATION_RULE.shortGames, short, games: games.length };
}

/**
 * A team's fixtures in the `n` GWs after `afterGw`, with FPL difficulty.
 * @param {number} teamId
 * @param {{ event: number, teamH: number, teamA: number, teamHFdr: number|null, teamAFdr: number|null }[]} fixtures
 * @returns {{ gws: number[], fixtures: { gw, opponent, home, fdr }[], avgFdr: number|null, doubles: number, blanks: number }}
 */
export function fixtureRun(teamId, fixtures, afterGw, n = FIXTURE_WINDOW) {
  const gws = Array.from({ length: n }, (_, i) => afterGw + 1 + i).filter((g) => g <= 38);
  const list = fixtures
    .filter((f) => gws.includes(f.event) && (f.teamH === teamId || f.teamA === teamId))
    .map((f) => {
      const home = f.teamH === teamId;
      return { gw: f.event, opponent: home ? f.teamA : f.teamH, home, fdr: home ? f.teamHFdr : f.teamAFdr };
    })
    .sort((a, b) => a.gw - b.gw || a.opponent - b.opponent);
  const known = list.map((f) => f.fdr).filter((d) => d != null);
  const perGw = new Map(gws.map((g) => [g, list.filter((f) => f.gw === g).length]));
  return {
    gws,
    fixtures: list,
    avgFdr: known.length ? Math.round((known.reduce((s, d) => s + d, 0) / known.length) * 10) / 10 : null,
    doubles: [...perGw.values()].filter((c) => c >= 2).length,
    blanks: [...perGw.values()].filter((c) => c === 0).length,
  };
}

/**
 * FPL selling price: you keep half of any rise (rounded down to £0.1m); a fall
 * is passed on in full. All values in tenths of £m.
 */
export function sellingPrice(purchaseTenths, nowTenths) {
  if (purchaseTenths == null || nowTenths == null) return null;
  return nowTenths <= purchaseTenths ? nowTenths : purchaseTenths + Math.floor((nowTenths - purchaseTenths) / 2);
}

/**
 * The price a manager paid for a player: the cost of his latest transfer in,
 * else (owned since the start) the season start price. null when unknown.
 * @param {{ elementIn: number, elementInCostTenths: number, event: number, time?: string|Date }[]} transfers
 */
export function purchasePrice(elementId, transfers, startPriceTenths) {
  const buys = transfers.filter((t) => t.elementIn === elementId)
    .sort((a, b) => a.event - b.event || String(a.time ?? '').localeCompare(String(b.time ?? '')));
  if (buys.length) return buys.at(-1).elementInCostTenths;
  return startPriceTenths ?? null;
}

/** Season start price from FPL's now_cost and cost_change_start (tenths). */
export const startPrice = (priceTenths, costChangeStartTenths) => (priceTenths == null || costChangeStartTenths == null ? null : priceTenths - costChangeStartTenths);
