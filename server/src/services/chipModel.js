import { chipAvailability, deriveEffectiveSquad } from '../analytics/index.js';
import { contentHash } from '../utils/canonical.js';

// Pure chip view (architecture v0.2 §7, §8). The engine decides everything:
// chipAvailability (windows, used / allowed / available / current, UNMAPPED
// names) and deriveEffectiveSquad (what a chip actually does to multipliers).
// This module fixes the inputs and states, per manager and GW, what each FPL
// source says — without inferring a chip from missing data.

// Display labels with a raw-name fallback (v0.2 §8: no hard-coded windows; labels only).
export const CHIP_LABELS = Object.freeze({ wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' });
export const chipLabel = (name) => (name == null ? null : CHIP_LABELS[name] ?? name);

/**
 * Per-manager chip state for one GW, comparing the two FPL sources:
 *   declared  — history.chips (stored in managerSeasons): FPL's record of a played chip
 *   squadChip — the GW row's active chip (picks.active_chip for the synced GW)
 * States:
 *   PLAYED              declared (and the squad agrees, or no squad row is stored)
 *   ACTIVE_UNCONFIRMED  the squad carries a chip that history does not list (yet)
 *   SOURCE_DISAGREEMENT history and the squad name different chips
 *   NONE                a stored GW row and history both show no chip
 *   UNKNOWN             not enough data (member never synced, or no GW row and no
 *                       history entry): never read as "no chip"
 */
export function chipState({ synced, declared, row }) {
  if (!synced) return { state: 'UNKNOWN', reason: 'NOT_SYNCED' };
  const squadChip = row ? (row.activeChip ?? null) : undefined;
  if (declared) {
    if (squadChip === undefined || squadChip === declared) return { state: 'PLAYED' };
    return { state: 'SOURCE_DISAGREEMENT' };
  }
  if (squadChip === undefined) return { state: 'UNKNOWN', reason: 'NO_GW_ROW' };
  return squadChip ? { state: 'ACTIVE_UNCONFIRMED' } : { state: 'NONE' };
}

/** Canonical inputs from ownershipRepo.loadChips. */
export function chipInputs(loaded, event) {
  return {
    event,
    eventState: loaded.eventState,
    members: [...loaded.members].sort((a, b) => a.entryId - b.entryId).map((m) => ({ entryId: m.entryId, isExcluded: m.isExcluded, synced: m.synced })),
    rows: [...loaded.rows].sort((a, b) => a.entryId - b.entryId).map((r) => ({
      entryId: r.entryId, activeChip: r.activeChip ?? null, hasPicks: r.hasPicks, picks: r.hasPicks ? r.picks : [], autoSubs: r.autoSubs ?? [],
    })),
    played: [...loaded.played].sort((a, b) => a.entryId - b.entryId || a.event - b.event || a.chipName.localeCompare(b.chipName)),
    chipRules: loaded.chipRules
      ? { source: loaded.chipRules.source, rules: [...loaded.chipRules.rules].sort((a, b) => a.chipName.localeCompare(b.chipName) || a.startEvent - b.startEvent) }
      : null,
  };
}

/** What a chip actually did to this squad's multipliers, as the engine derives it. */
function applied(row) {
  if (!row?.hasPicks) return null;
  const s = deriveEffectiveSquad({ picks: row.picks, activeChip: row.activeChip, autoSubs: row.autoSubs, live: new Map() });
  return {
    chip: row.activeChip,
    benchBoost: s.benchBoost,
    tripleCaptain: s.capMult === 3,
    unknownChip: s.warnings.includes('UNKNOWN_CHIP'),
    // wildcard / free hit change the squad, not the multipliers
    scoringEffect: s.benchBoost ? 'BENCH_BOOST' : s.capMult === 3 ? 'TRIPLE_CAPTAIN' : 'NONE',
  };
}

/**
 * @param {ReturnType<typeof chipInputs>} inputs
 */
export function buildChipView(inputs) {
  const { event } = inputs;
  const synced = new Set(inputs.members.filter((m) => m.synced).map((m) => m.entryId));
  const rowByEntry = new Map(inputs.rows.map((r) => [r.entryId, r]));
  const warnings = [];
  const rulesAvailable = Boolean(inputs.chipRules?.rules.length);
  if (!rulesAvailable) warnings.push({ code: 'CHIP_RULES_UNAVAILABLE' }); // never invented
  else if (inputs.chipRules.source === 'CONFIG_FALLBACK') warnings.push({ code: 'CONFIG_FALLBACK' });
  if (inputs.eventState !== 'DATA_CHECKED') warnings.push({ code: 'PROVISIONAL_EVENT_STATE', eventState: inputs.eventState });

  const syncedIds = inputs.members.filter((m) => m.synced).map((m) => m.entryId);
  const availability = rulesAvailable ? chipAvailability(inputs.chipRules.rules, inputs.played, event, syncedIds) : null;

  const gameweek = inputs.members.map((m) => {
    const declared = inputs.played.find((p) => p.entryId === m.entryId && p.event === event)?.chipName ?? null;
    const row = rowByEntry.get(m.entryId) ?? null;
    const st = chipState({ synced: synced.has(m.entryId), declared, row });
    return {
      entryId: m.entryId,
      isExcluded: m.isExcluded,
      ...st,
      declared,
      declaredLabel: chipLabel(declared),
      squadChip: row ? row.activeChip : null,
      squadChipLabel: chipLabel(row?.activeChip ?? null),
      applied: applied(row),
    };
  });

  const counts = new Map();
  for (const g of gameweek) {
    if (g.state !== 'PLAYED' || !g.declared) continue;
    counts.set(g.declared, [...(counts.get(g.declared) ?? []), g.entryId]);
  }
  const playedThisEvent = [...counts]
    .map(([chipName, entryIds]) => ({ chipName, label: chipLabel(chipName), count: entryIds.length, entryIds }))
    .sort((a, b) => b.count - a.count || a.chipName.localeCompare(b.chipName));

  return {
    event,
    eventState: inputs.eventState,
    provisional: inputs.eventState !== 'DATA_CHECKED',
    rules: rulesAvailable ? { source: inputs.chipRules.source, rules: inputs.chipRules.rules.map((r) => ({ ...r, label: chipLabel(r.chipName) })) } : null,
    availability,
    gameweek,
    playedThisEvent,
    missingEntryIds: inputs.members.filter((m) => !m.synced).map((m) => m.entryId),
    warnings,
    inputsHash: contentHash(inputs),
  };
}
