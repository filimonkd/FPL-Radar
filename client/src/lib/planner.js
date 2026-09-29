// Wildcard / Free Hit planner rules (Step 21). Pure: players from the players
// API (/api/seasons/:season/players) and a draft in, checks and totals out.
// Drafts live in this browser only (see loadDrafts / saveDrafts).

export const SQUAD_SHAPE = Object.freeze({ GKP: 2, DEF: 5, MID: 5, FWD: 3 });
export const SQUAD_SIZE = 15;
export const XI_SIZE = 11;
export const XI_MIN = Object.freeze({ GKP: 1, DEF: 3, MID: 2, FWD: 1 });
export const XI_MAX = Object.freeze({ GKP: 1, DEF: 5, MID: 5, FWD: 3 });
export const MAX_PER_CLUB = 3;
export const DEFAULT_BUDGET_TENTHS = 1000;
const POSITIONS = Object.keys(SQUAD_SHAPE);

const countBy = (list, key) => list.reduce((m, p) => m.set(key(p), (m.get(key(p)) ?? 0) + 1), new Map());
const r1 = (x) => Math.round(x * 10) / 10;

/** The draft's squad as player rows, in squad order; unknown ids are dropped. */
export const squadOf = (draft, byId) => draft.squad.map((id) => byId.get(id)).filter(Boolean);
export const costOf = (players) => players.reduce((s, p) => s + (p.priceTenths ?? 0), 0);

/**
 * Why a player can't be added to the squad now, or null. Over-budget adds are
 * allowed (the budget shows red), like FPL's own team picker.
 */
export function addBlocker(draft, byId, player) {
  const squad = squadOf(draft, byId);
  if (draft.squad.includes(player.elementId)) return 'already in your squad';
  if (!SQUAD_SHAPE[player.position]) return 'unknown position';
  if (squad.filter((p) => p.position === player.position).length >= SQUAD_SHAPE[player.position]) return `${player.position} is full (${SQUAD_SHAPE[player.position]})`;
  if (squad.filter((p) => p.teamId === player.teamId).length >= MAX_PER_CLUB) return `already ${MAX_PER_CLUB} from ${player.team ?? 'this club'}`;
  return null;
}

/** Best XI by FPL expected points: the formation minimums first, then the best of the rest. */
export function bestXi(players) {
  const byEp = [...players].sort((a, b) => (b.epNextTenths ?? -1) - (a.epNextTenths ?? -1) || a.elementId - b.elementId);
  const xi = [];
  for (const pos of POSITIONS) xi.push(...byEp.filter((p) => p.position === pos).slice(0, XI_MIN[pos]));
  for (const p of byEp) {
    if (xi.length >= XI_SIZE) break;
    if (xi.includes(p)) continue;
    const n = xi.filter((x) => x.position === p.position).length;
    if (n < XI_MAX[p.position]) xi.push(p);
  }
  return xi.map((p) => p.elementId);
}

/**
 * Everything the planner shows about a draft.
 * @param {{ squad: number[], xi: number[], budgetTenths: number }} draft
 * @param {Map<number, object>} byId  players API rows by elementId
 * @param {number} nextGw  the GW the draft is for (FPL's current GW + 1)
 */
export function evaluate(draft, byId, nextGw) {
  const squad = squadOf(draft, byId);
  const xi = squad.filter((p) => draft.xi.includes(p.elementId));
  const pos = countBy(squad, (p) => p.position);
  const xiPos = countBy(xi, (p) => p.position);
  const clubs = countBy(squad, (p) => p.teamId);
  const cost = costOf(squad);
  const problems = [];
  const missing = [];
  for (const p of POSITIONS) {
    const n = pos.get(p) ?? 0;
    if (n > SQUAD_SHAPE[p]) problems.push(`Too many ${p}: ${n}/${SQUAD_SHAPE[p]}`);
    else if (n < SQUAD_SHAPE[p]) missing.push(`${SQUAD_SHAPE[p] - n} ${p}`);
  }
  for (const [teamId, n] of clubs) {
    if (n > MAX_PER_CLUB) problems.push(`${n} players from ${squad.find((p) => p.teamId === teamId)?.team ?? `club ${teamId}`} (max ${MAX_PER_CLUB})`);
  }
  if (cost > draft.budgetTenths) problems.push(`Over budget by £${((cost - draft.budgetTenths) / 10).toFixed(1)}m`);
  if (squad.length === SQUAD_SIZE) {
    if (xi.length !== XI_SIZE) problems.push(`Starting XI has ${xi.length} players (needs ${XI_SIZE})`);
    for (const p of POSITIONS) {
      const n = xiPos.get(p) ?? 0;
      if (n < XI_MIN[p]) problems.push(`Starting XI needs at least ${XI_MIN[p]} ${p}`);
      if (n > XI_MAX[p]) problems.push(`Starting XI allows at most ${XI_MAX[p]} ${p}`);
    }
  }
  const eps = xi.map((p) => p.epNextTenths);
  const captain = [...xi].sort((a, b) => (b.epNextTenths ?? -1) - (a.epNextTenths ?? -1) || a.elementId - b.elementId)[0] ?? null;
  const known = eps.filter((e) => e != null);
  const xPts = xi.length && known.length ? r1((known.reduce((s, e) => s + e, 0) + (captain?.epNextTenths ?? 0)) / 10) : null;
  const fdrs = xi.flatMap((p) => (p.fixtures?.fixtures ?? []).map((f) => f.fdr)).filter((d) => d != null);
  const gamesNext = (p) => (p.fixtures?.fixtures ?? []).filter((f) => f.gw === nextGw).length;
  return {
    size: squad.length,
    cost,
    bankTenths: draft.budgetTenths - cost,
    positions: Object.fromEntries(POSITIONS.map((p) => [p, pos.get(p) ?? 0])),
    xiSize: xi.length,
    xPts,
    xPtsMissing: xi.length - known.length,
    captainId: captain?.elementId ?? null,
    avgFdr: fdrs.length ? r1(fdrs.reduce((s, d) => s + d, 0) / fdrs.length) : null,
    doubles: xi.filter((p) => gamesNext(p) >= 2).length,
    blanks: xi.filter((p) => gamesNext(p) === 0).length,
    problems,
    missing,
    complete: squad.length === SQUAD_SIZE,
    valid: squad.length === SQUAD_SIZE && problems.length === 0,
  };
}

// ── drafts in this browser ────────────────────────────────────────────────
const key = (groupId, season) => `fpl-radar:planner:${groupId}:${season}`;
const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function loadDrafts(groupId, season) {
  try {
    const raw = store()?.getItem(key(groupId, season));
    const data = raw ? JSON.parse(raw) : null;
    if (!data || !Array.isArray(data.drafts)) return { drafts: [], activeId: null };
    const drafts = data.drafts.filter((d) => d && typeof d.id === 'string' && Array.isArray(d.squad) && Array.isArray(d.xi) && Number.isInteger(d.budgetTenths));
    return { drafts, activeId: drafts.some((d) => d.id === data.activeId) ? data.activeId : drafts[0]?.id ?? null };
  } catch {
    return { drafts: [], activeId: null };
  }
}

export function saveDrafts(groupId, season, state) {
  try { store()?.setItem(key(groupId, season), JSON.stringify(state)); return true; } catch { return false; }
}

export function newDraft({ id, name, mode = 'WILDCARD', squad = [], xi = [], budgetTenths = DEFAULT_BUDGET_TENTHS }) {
  return { id, name, mode, squad: [...squad], xi: [...xi], budgetTenths };
}
