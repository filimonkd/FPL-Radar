// Chip rules and availability (architecture v0.2 §8). Pure.
// bootstrap chips[] is authoritative when valid; the config file is a fallback;
// the two are never merged. No chip windows are hard-coded here.

/** Validates bootstrap `chips[]` (or config rules). The whole set is rejected on any problem. */
export function validateChipRules(chips) {
  const problems = [];
  if (!Array.isArray(chips) || chips.length === 0) return { valid: false, rules: [], problems: ['chips[] missing or empty'] };
  const rules = chips.map((c) => ({
    chipName: c.name ?? c.chipName,
    number: c.number,
    startEvent: c.start_event ?? c.startEvent,
    stopEvent: c.stop_event ?? c.stopEvent,
    chipType: c.chip_type ?? c.chipType ?? null,
  }));
  for (const r of rules) {
    if (typeof r.chipName !== 'string' || r.chipName === '') problems.push('name must be a string');
    if (!(Number.isInteger(r.number) && r.number >= 1)) problems.push(`${r.chipName}: number must be ≥ 1`);
    if (!(Number.isInteger(r.startEvent) && Number.isInteger(r.stopEvent) && r.startEvent >= 1 && r.startEvent <= r.stopEvent && r.stopEvent <= 38)) {
      problems.push(`${r.chipName}: window ${r.startEvent}–${r.stopEvent} invalid`);
    }
  }
  const byName = Map.groupBy(rules, (r) => r.chipName);
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => a.startEvent - b.startEvent);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startEvent <= sorted[i - 1].stopEvent) problems.push(`${name}: overlapping windows`);
    }
  }
  return problems.length ? { valid: false, rules: [], problems } : { valid: true, rules, problems: [] };
}

/**
 * @param {{ chipName: string, startEvent: number, stopEvent: number, number: number, source: 'FPL_BOOTSTRAP'|'CONFIG_FALLBACK' }[]} rules
 * @param {{ entryId: number, chipName: string, event: number }[]} played
 * @param {number} currentEvent
 * @param {number[]} entryIds
 */
export function chipAvailability(rules, played, currentEvent, entryIds) {
  const source = rules[0]?.source ?? null;
  const names = new Set(rules.map((r) => r.chipName));
  const sortedRules = [...rules].sort((a, b) => a.chipName.localeCompare(b.chipName) || a.startEvent - b.startEvent);
  const managers = [...entryIds].sort((a, b) => a - b).map((entryId) => {
    const mine = played.filter((p) => p.entryId === entryId);
    const chips = sortedRules.map((r) => {
      const inWindow = mine.filter((p) => p.chipName === r.chipName && p.event >= r.startEvent && p.event <= r.stopEvent);
      return {
        chipName: r.chipName,
        window: [r.startEvent, r.stopEvent],
        used: inWindow.length,
        allowed: r.number,
        available: inWindow.length < r.number,
        current: currentEvent >= r.startEvent && currentEvent <= r.stopEvent,
        playedEvents: inWindow.map((p) => p.event).sort((a, b) => a - b),
      };
    });
    const unmapped = mine.filter((p) => !names.has(p.chipName)).map(({ chipName, event }) => ({ chipName, event }));
    return { entryId, chips, unmapped };
  });
  return { source, managers };
}
