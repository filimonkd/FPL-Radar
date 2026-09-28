// Pure pick validation (architecture v0.3 §12). Shared by the FPL mapper, the
// Mongoose pre('validate') hook and db:check, so all three enforce identical rules.
export function pickViolations(picks) {
  const v = [];
  if (picks.length !== 15) v.push(`expected 15 picks, got ${picks.length}`);
  if (new Set(picks.map((p) => p.squadPosition)).size !== picks.length) v.push('duplicate squadPosition');
  if (new Set(picks.map((p) => p.elementId)).size !== picks.length) v.push('duplicate elementId');
  const captains = picks.filter((p) => p.isCaptain);
  const vices = picks.filter((p) => p.isViceCaptain);
  if (captains.length !== 1) v.push(`expected 1 captain, got ${captains.length}`);
  if (vices.length !== 1) v.push(`expected 1 vice-captain, got ${vices.length}`);
  if (captains.length === 1 && vices.length === 1 && captains[0].elementId === vices[0].elementId) {
    v.push('captain and vice-captain are the same player');
  }
  return v;
}
