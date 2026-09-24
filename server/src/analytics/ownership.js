// Picked vs effective ownership (architecture v0.2 §7). Pure.
// Denominators count eligible managers with picks; missing ones are reported,
// never silently dropped. pct is null (not NaN) when a denominator is 0.

const share = (count, of) => ({ count, of, pct: of === 0 ? null : (count / of) * 100 });
const eo = (sum, of) => (of === 0 ? null : sum / of);

/**
 * @param {{ squads: Map<number, ReturnType<typeof import('./effectiveSquad.js').deriveEffectiveSquad>>,
 *   eligible: number[], myEntryId: number|null, players: Map<number, object> }} input
 */
export function computeOwnership({ squads, eligible, myEntryId, players }) {
  const withPicks = eligible.filter((id) => squads.has(id)).sort((a, b) => a - b);
  const missingEntryIds = eligible.filter((id) => !squads.has(id)).sort((a, b) => a - b);
  const meCounts = myEntryId !== null && withPicks.includes(myEntryId);
  const rivals = withPicks.filter((id) => !(meCounts && id === myEntryId));
  const denominators = { rivals: rivals.length, all: withPicks.length };

  const playerIds = new Set();
  for (const id of withPicks) for (const p of squads.get(id).picks) playerIds.add(p.elementId);

  const scopeStats = (scope, elementId) => {
    const s = { squad: 0, xi: 0, captain: 0, triple: 0, effCaptain: 0, pickedSum: 0, effSum: 0 };
    for (const id of scope) {
      const squad = squads.get(id);
      const pick = squad.picks.find((p) => p.elementId === elementId);
      if (!pick) continue;
      s.squad += 1;
      if (pick.squadPosition <= 11) s.xi += 1;
      if (squad.pickedCaptain === elementId) {
        s.captain += 1;
        if (squad.capMult === 3) s.triple += 1;
      }
      if (squad.effectiveCaptain.elementId === elementId) s.effCaptain += 1;
      s.pickedSum += pick.pickedMultiplier;
      s.effSum += pick.effectiveMultiplier;
    }
    return s;
  };

  const mine = meCounts ? squads.get(myEntryId) : null;
  const rows = [...playerIds].map((elementId) => {
    const r = scopeStats(rivals, elementId);
    const a = scopeStats(withPicks, elementId);
    const both = (key) => ({ rivals: share(r[key], rivals.length), all: share(a[key], withPicks.length) });
    const pickedEo = { rivals: eo(r.pickedSum, rivals.length), all: eo(a.pickedSum, withPicks.length) };
    const effectiveEo = { rivals: eo(r.effSum, rivals.length), all: eo(a.effSum, withPicks.length) };
    const myPick = mine?.picks.find((p) => p.elementId === elementId);
    const myPickedMultiplier = mine ? (myPick?.pickedMultiplier ?? 0) : null;
    const myEffectiveMultiplier = mine ? (myPick?.effectiveMultiplier ?? 0) : null;
    return {
      player: players.get(elementId) ?? { id: elementId },
      pickedSquad: both('squad'),
      pickedXi: both('xi'),
      pickedCaptain: both('captain'),
      pickedTriple: both('triple'),
      effectiveCaptain: both('effCaptain'),
      pickedEo,
      effectiveEo,
      myPickedMultiplier,
      myEffectiveMultiplier,
      pickedExposure: myPickedMultiplier === null || pickedEo.rivals === null ? null : myPickedMultiplier - pickedEo.rivals,
      effectiveExposure: myEffectiveMultiplier === null || effectiveEo.rivals === null ? null : myEffectiveMultiplier - effectiveEo.rivals,
      owners: withPicks.filter((id) => squads.get(id).picks.some((p) => p.elementId === elementId)),
    };
  });
  rows.sort((x, y) => (y.effectiveEo.all ?? 0) - (x.effectiveEo.all ?? 0) || (x.player.id ?? 0) - (y.player.id ?? 0));
  return { denominators, missingEntryIds, rows };
}
