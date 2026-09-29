// Rival analytics (Step 16): leaderboards and podium, "spy vs me", strategy
// lab and rival radar, computed from already-synced data only.
//
// Pure: plain objects in, plain objects out; no database, clock, randomness or
// environment. Every metric states its rule here, and the output carries what
// was missing instead of silently treating it as zero.
//
// Points: `score` is the GW score the group's winner rule uses (net or gross,
// from reconciliation). It is null when that row is not reconciled; such GWs
// are skipped, never guessed (H3 stays unresolved). Overall standings use
// FPL's reported season total (`totalPoints`) as-is.

export const THREAT_RULE = Object.freeze({
  formWindow: 3,
  formAhead: 5, // points per GW
  levels: { HIGH: 3, MEDIUM: 2 },
  text: 'Form: +2 if their 3-GW average beats the baseline by 5+, +1 if by less. Chips: +1 for Triple Captain left, +1 for Bench Boost left, +1 if Free Hit or Wildcard left. 3+ = HIGH, 2 = MEDIUM, otherwise LOW. Baseline = your form, or the group average if "me" is not set.',
});
export const FDR_WINDOW = 3;

const byNum = (a, b) => a - b;
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Competition ranks ("=" ties) over values, higher is better; entries without a value are unranked. */
function rankBy(entries, valueOf) {
  const ranked = entries.filter((e) => valueOf(e) != null)
    .sort((a, b) => valueOf(b) - valueOf(a) || a.entryId - b.entryId);
  const out = new Map();
  ranked.forEach((e) => {
    const v = valueOf(e);
    const rank = 1 + ranked.filter((o) => valueOf(o) > v).length;
    const tied = ranked.filter((o) => o !== e && valueOf(o) === v).map((o) => o.entryId);
    out.set(e.entryId, { rank, tied });
  });
  return { order: ranked.map((e) => e.entryId), ranks: out };
}

/**
 * @param {{
 *   event: number,
 *   myEntryId: number|null,
 *   members: { entryId: number, isExcluded?: boolean }[],
 *   managers: { entryId: number, playerName: string, teamName: string }[],
 *   rows: { entryId: number, event: number, score: number|null, transferCost: number, totalPoints: number, bankTenths: number|null, teamValueTenths: number|null, activeChip: string|null }[],
 *   squads: { entryId: number, event: number, picks: { elementId: number, squadPosition: number, isCaptain: boolean, isViceCaptain: boolean }[] }[],
 *   players: { id: number, webName?: string, teamId?: number, epNextTenths?: number|null }[],
 *   upcoming: { event: number, teamH: number, teamA: number, teamHFdr: number|null, teamAFdr: number|null }[],
 *   transfersIn: { elementId: number, count: number, entryIds: number[] }[],
 *   chipsLeft: { entryId: number, chips: { chipName: string, available: boolean }[] }[] | null,
 * }} input
 */
export function computeRivals(input) {
  const { event } = input;
  const members = [...input.members].filter((m) => !m.isExcluded).sort((a, b) => a.entryId - b.entryId);
  const ids = members.map((m) => m.entryId);
  const idSet = new Set(ids);
  const nameOf = new Map(input.managers.map((m) => [m.entryId, m]));
  const playerOf = new Map(input.players.map((p) => [p.id, p]));
  const me = input.myEntryId != null && idSet.has(input.myEntryId) ? input.myEntryId : null;

  // Season rows per entry, up to and including the selected GW.
  const rowsOf = new Map(ids.map((id) => [id, []]));
  for (const r of input.rows) if (idSet.has(r.entryId) && r.event <= event) rowsOf.get(r.entryId).push(r);
  for (const list of rowsOf.values()) list.sort((a, b) => a.event - b.event);
  const rowAt = (id) => rowsOf.get(id).find((r) => r.event === event) ?? null;
  const latestRow = (id) => rowsOf.get(id).at(-1) ?? null;

  const squadOf = new Map();
  for (const s of input.squads) {
    if (!idSet.has(s.entryId) || s.event > event) continue;
    const prev = squadOf.get(s.entryId);
    if (!prev || s.event > prev.event) squadOf.set(s.entryId, s);
  }
  const xiOf = (id) => (squadOf.get(id)?.picks ?? []).filter((p) => p.squadPosition <= 11).map((p) => p.elementId).sort(byNum);
  const squad15Of = (id) => (squadOf.get(id)?.picks ?? []).map((p) => p.elementId).sort(byNum);
  const captainOf = (id) => squadOf.get(id)?.picks.find((p) => p.isCaptain)?.elementId ?? null;

  // ── per-manager stats ────────────────────────────────────────────────
  const stats = new Map(ids.map((id) => {
    const rows = rowsOf.get(id);
    const scored = rows.filter((r) => r.score != null);
    const last = scored.slice(-THREAT_RULE.formWindow);
    const at = rowAt(id);
    const latest = latestRow(id);
    return [id, {
      entryId: id,
      gwScore: at?.score ?? null,
      total: latest?.totalPoints ?? null,
      totalEvent: latest?.event ?? null,
      form: round1(mean(last.map((r) => r.score))),
      formGws: last.map((r) => r.event),
      hits: rows.reduce((s, r) => s + (r.transferCost ?? 0), 0),
      hitGws: rows.filter((r) => r.transferCost > 0).length,
      bankTenths: at?.bankTenths ?? latest?.bankTenths ?? null,
      valueTenths: at?.teamValueTenths ?? latest?.teamValueTenths ?? null,
      activeChip: at?.activeChip ?? null,
      gwHit: at?.transferCost ?? null,
      captain: captainOf(id),
      squadEvent: squadOf.get(id)?.event ?? null,
    }];
  }));
  const s = (id) => stats.get(id);
  const label = (id) => ({ entryId: id, teamName: nameOf.get(id)?.teamName ?? `#${id}`, playerName: nameOf.get(id)?.playerName ?? '' });

  // ── leaderboard + podium (overall) and GW table ─────────────────────
  const overall = rankBy(ids.map((id) => s(id)), (x) => x.total);
  const gw = rankBy(ids.map((id) => s(id)), (x) => x.gwScore);
  const leaderboard = overall.order.map((id) => ({
    ...label(id),
    rank: overall.ranks.get(id).rank,
    tiedWith: overall.ranks.get(id).tied,
    total: s(id).total,
    gwScore: s(id).gwScore,
    gwRank: gw.ranks.get(id)?.rank ?? null,
    gwHit: s(id).gwHit,
    form: s(id).form,
    isMe: id === me,
  }));
  const podium = leaderboard.filter((r) => r.rank <= 3);
  const unranked = ids.filter((id) => !overall.ranks.has(id));
  const topGw = gw.order.length ? s(gw.order[0]).gwScore : null;
  const gwTop = gw.order.filter((id) => s(id).gwScore === topGw).map((id) => ({ ...label(id), score: topGw }));

  // ── closest rivals (by overall position) ────────────────────────────
  let closest = null;
  if (me != null && overall.ranks.has(me)) {
    const i = overall.order.indexOf(me);
    const pick = (id) => (id == null ? null : { ...label(id), total: s(id).total, gap: s(id).total - s(me).total });
    closest = { above: pick(overall.order[i - 1] ?? null), below: pick(overall.order[i + 1] ?? null), myRank: overall.ranks.get(me).rank };
  }

  // ── chips ────────────────────────────────────────────────────────────
  const chipsOf = new Map((input.chipsLeft ?? []).map((c) => [c.entryId, c.chips]));
  const hasChip = (id, name) => (chipsOf.get(id) ?? []).some((c) => c.chipName === name && c.available);
  const chipInventory = (id) => (input.chipsLeft ? (chipsOf.get(id) ?? []).filter((c) => c.available).map((c) => c.chipName).sort() : null);

  // ── threat level ─────────────────────────────────────────────────────
  const forms = ids.map((id) => s(id).form).filter((f) => f != null);
  const baseline = me != null && s(me).form != null ? { value: s(me).form, source: 'ME' } : { value: round1(mean(forms)), source: 'GROUP_AVERAGE' };
  function threat(id) {
    const reasons = [];
    let pts = 0;
    const f = s(id).form;
    if (f != null && baseline.value != null) {
      const d = f - baseline.value;
      if (d >= THREAT_RULE.formAhead) { pts += 2; reasons.push(`hot form (+${round1(d)}/GW)`); } else if (d > 0) { pts += 1; reasons.push(`better form (+${round1(d)}/GW)`); }
    }
    if (input.chipsLeft) {
      if (hasChip(id, '3xc')) { pts += 1; reasons.push('Triple Captain left'); }
      if (hasChip(id, 'bboost')) { pts += 1; reasons.push('Bench Boost left'); }
      if (hasChip(id, 'freehit') || hasChip(id, 'wildcard')) { pts += 1; reasons.push('Free Hit / Wildcard left'); }
    }
    const level = pts >= THREAT_RULE.levels.HIGH ? 'HIGH' : pts >= THREAT_RULE.levels.MEDIUM ? 'MEDIUM' : 'LOW';
    return { level, points: pts, reasons, complete: f != null && input.chipsLeft != null };
  }

  // ── head to head vs me ───────────────────────────────────────────────
  function h2h(id) {
    if (me == null || id === me) return null;
    const mine = new Map(rowsOf.get(me).filter((r) => r.score != null).map((r) => [r.event, r.score]));
    let wins = 0; let losses = 0; let draws = 0;
    const gws = [];
    for (const r of rowsOf.get(id)) {
      if (r.score == null || !mine.has(r.event)) continue;
      const d = mine.get(r.event) - r.score;
      if (d > 0) wins += 1; else if (d < 0) losses += 1; else draws += 1;
      gws.push(r.event);
    }
    return { wins, losses, draws, gws: gws.length };
  }

  // ── spy vs me ────────────────────────────────────────────────────────
  const myXi = me != null ? new Set(xiOf(me)) : null;
  const rivals = ids.filter((id) => id !== me).map((id) => {
    const x = s(id);
    const xi = xiOf(id);
    const overlap = myXi && myXi.size && xi.length ? xi.filter((e) => myXi.has(e)) : null;
    return {
      ...label(id),
      rank: overall.ranks.get(id)?.rank ?? null,
      total: x.total,
      gwScore: x.gwScore,
      gwDiff: me != null && x.gwScore != null && s(me).gwScore != null ? x.gwScore - s(me).gwScore : null,
      overallDiff: me != null && x.total != null && s(me).total != null ? x.total - s(me).total : null,
      overlap: overlap ? { shared: overlap.length, of: 11, sharedIds: overlap, theirOnly: xi.filter((e) => !myXi.has(e)), squadEvent: x.squadEvent } : null,
      bankTenths: x.bankTenths,
      valueTenths: x.valueTenths,
      captain: x.captain,
      activeChip: x.activeChip,
      form: x.form,
      formGws: x.formGws,
      hits: x.hits,
      hitGws: x.hitGws,
      chipsLeft: chipInventory(id),
      h2h: h2h(id),
      threat: threat(id),
    };
  });

  // ── strategy lab ─────────────────────────────────────────────────────
  const mySquad = me != null ? new Set(squad15Of(me)) : null;
  const ownedBy = new Map();
  for (const id of ids) for (const e of squad15Of(id)) ownedBy.set(e, (ownedBy.get(e) ?? 0) + 1);
  const withSquads = ids.filter((id) => squadOf.has(id)).length;
  const bandwagon = [...input.transfersIn]
    .filter((t) => t.entryIds.some((e) => idSet.has(e)))
    .map((t) => ({ elementId: t.elementId, webName: playerOf.get(t.elementId)?.webName ?? null, boughtBy: t.entryIds.filter((e) => idSet.has(e)).sort(byNum), ownedBy: ownedBy.get(t.elementId) ?? 0, of: withSquads, iOwn: mySquad ? mySquad.has(t.elementId) : null }))
    .map((b) => ({ ...b, count: b.boughtBy.length }))
    .sort((a, b) => b.count - a.count || b.ownedBy - a.ownedBy || a.elementId - b.elementId);

  // xPts: FPL ep_next over each manager's latest known XI, captain counted twice.
  const xpts = ids.map((id) => {
    const xi = xiOf(id);
    if (!xi.length) return { ...label(id), xPts: null, missing: null, squadEvent: null, isMe: id === me };
    const cap = s(id).captain;
    let tenths = 0; let missing = 0;
    for (const e of xi) {
      const ep = playerOf.get(e)?.epNextTenths;
      if (ep == null) { missing += 1; continue; }
      tenths += ep * (e === cap ? 2 : 1);
    }
    // No estimate for any starter → unknown, never 0.
    return { ...label(id), xPts: missing === xi.length ? null : round1(tenths / 10), missing, squadEvent: s(id).squadEvent, isMe: id === me };
  }).sort((a, b) => (b.xPts ?? -Infinity) - (a.xPts ?? -Infinity) || a.entryId - b.entryId);

  // FDR: mean FPL difficulty of every XI player's fixtures in the next 3 GWs.
  const window = [event + 1, event + 2, event + 3].filter((g) => g <= 38);
  const fixturesOfTeam = (teamId) => input.upcoming
    .filter((f) => window.includes(f.event) && (f.teamH === teamId || f.teamA === teamId))
    .map((f) => (f.teamH === teamId ? f.teamHFdr : f.teamAFdr))
    .filter((d) => d != null);
  const fdr = ids.map((id) => {
    const xi = xiOf(id);
    const diffs = [];
    let unknownTeam = 0;
    for (const e of xi) {
      const team = playerOf.get(e)?.teamId;
      if (team == null) { unknownTeam += 1; continue; }
      diffs.push(...fixturesOfTeam(team));
    }
    return { ...label(id), fdr: round1(mean(diffs)), fixtures: diffs.length, unknownPlayers: unknownTeam, isMe: id === me };
  }).sort((a, b) => (a.fdr ?? Infinity) - (b.fdr ?? Infinity) || a.entryId - b.entryId);

  return {
    event,
    myEntryId: me,
    leaderboard,
    unranked: unranked.map(label),
    podium,
    gwTop,
    closest,
    rivals,
    strategy: { bandwagon, xpts, fdr, fdrWindow: window },
    threatBaseline: baseline,
    captains: ids.map((id) => ({ entryId: id, captain: s(id).captain, activeChip: s(id).activeChip, squadEvent: s(id).squadEvent })),
    players: input.players.map((p) => ({ id: p.id, webName: p.webName ?? null })).sort((a, b) => a.id - b.id),
    rules: { threat: THREAT_RULE.text, form: `Average GW score over the last ${THREAT_RULE.formWindow} scored GWs.`, xPts: 'FPL ep_next summed over each manager\'s latest known starting XI, captain counted twice.', fdr: `Mean FPL fixture difficulty (1–5) of the starting XI's fixtures in the next ${FDR_WINDOW} GWs.` },
  };
}
