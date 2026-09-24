// Effective squad derivation (architecture v0.2 §7). Pure.
// The engine derives effective multipliers itself; FPL's multiplier is only a
// cross-check (FPL_MULTIPLIER_DIFFERS), never the source.

const KNOWN_CHIPS = new Set(['bboost', '3xc', 'wildcard', 'freehit']);

/**
 * @param {{
 *   picks: { elementId: number, squadPosition: number, isCaptain: boolean, isViceCaptain: boolean, fplMultiplier: number }[],
 *   activeChip: string|null,
 *   autoSubs: { elementIn: number, elementOut: number, source: 'FPL'|'SIMULATED' }[],
 *   live: Map<number, { minutes: number, totalPoints: number, fixturesSettled: boolean }>,
 *   grossGwPoints?: number|null,   // enables the EFFECTIVE_POINTS_MISMATCH cross-check
 * }} input
 */
export function deriveEffectiveSquad({ picks, activeChip, autoSubs = [], live, grossGwPoints = null }) {
  const warnings = [];
  const chip = activeChip ?? null;
  if (chip !== null && !KNOWN_CHIPS.has(chip)) warnings.push('UNKNOWN_CHIP');
  const benchBoost = chip === 'bboost';
  const capMult = chip === '3xc' ? 3 : 2;

  const sorted = [...picks].sort((a, b) => a.squadPosition - b.squadPosition);
  const captain = sorted.find((p) => p.isCaptain)?.elementId ?? null;
  const vice = sorted.find((p) => p.isViceCaptain)?.elementId ?? null;

  // 1. Base multipliers.
  const base = new Map(sorted.map((p) => [p.elementId, benchBoost || p.squadPosition <= 11 ? 1 : 0]));
  const autoSubbed = new Map();

  // 2. Auto-subs (never under bench boost).
  let autoSubSource = 'NONE';
  if (!benchBoost && autoSubs.length > 0) {
    autoSubSource = autoSubs[0].source;
    for (const s of autoSubs) {
      if (base.has(s.elementOut)) {
        base.set(s.elementOut, 0);
        autoSubbed.set(s.elementOut, 'OUT');
      }
      if (base.has(s.elementIn)) {
        base.set(s.elementIn, 1);
        autoSubbed.set(s.elementIn, 'IN');
      }
    }
  }

  // 4. Captain resolution.
  const stat = (id) => live.get(id) ?? { minutes: 0, totalPoints: 0, fixturesSettled: false };
  const played = (id) => id !== null && stat(id).minutes > 0;
  const settled = (id) => id !== null && (stat(id).fixturesSettled === true || played(id));

  const effective = new Map(base);
  let effectiveCaptain;
  if (played(captain) && base.get(captain) > 0) {
    effective.set(captain, capMult);
    effectiveCaptain = { elementId: captain, via: 'CAPTAIN' };
  } else if (!settled(captain)) {
    // Provisional: keep the picked captaincy until the captain's fixtures settle.
    if (captain !== null && base.get(captain) > 0) effective.set(captain, capMult);
    effectiveCaptain = { elementId: captain, via: 'PENDING' };
  } else if (played(vice) && base.get(vice) > 0) {
    effective.set(vice, capMult);
    effectiveCaptain = { elementId: vice, via: 'VICE' };
  } else if (!settled(vice)) {
    effectiveCaptain = { elementId: null, via: 'PENDING' };
  } else {
    effectiveCaptain = { elementId: null, via: 'NONE' };
  }

  const pickedMultiplier = (p) => (p.isCaptain ? capMult : benchBoost || p.squadPosition <= 11 ? 1 : 0);
  const out = sorted.map((p) => ({
    elementId: p.elementId,
    squadPosition: p.squadPosition,
    pickedMultiplier: pickedMultiplier(p),
    effectiveMultiplier: effective.get(p.elementId),
    autoSubbed: autoSubbed.get(p.elementId) ?? null,
  }));

  const reconstructedPoints = out.reduce((sum, p) => sum + p.effectiveMultiplier * stat(p.elementId).totalPoints, 0);
  const settledNow = effectiveCaptain.via !== 'PENDING';
  if (settledNow && sorted.some((p) => p.fplMultiplier !== effective.get(p.elementId))) warnings.push('FPL_MULTIPLIER_DIFFERS');
  if (settledNow && grossGwPoints !== null && reconstructedPoints !== grossGwPoints) warnings.push('EFFECTIVE_POINTS_MISMATCH');

  const ec = effectiveCaptain.elementId;
  return {
    picks: out,
    pickedCaptain: captain,
    pickedVice: vice,
    capMult,
    effectiveCaptain,
    benchBoost,
    autoSubSource,
    reconstructedPoints,
    // Points scored by the effective captain including the multiplier (tie-break data);
    // 0 when nobody was multiplied, null while pending.
    captainPoints: effectiveCaptain.via === 'PENDING' ? null : ec === null ? 0 : stat(ec).totalPoints * effective.get(ec),
    warnings,
  };
}
