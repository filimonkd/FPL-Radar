import { ids } from '../../db/ids.js';
import { attachProvenance, idString, mapList, provenanceToDomain } from './common.js';
import { fixtureToDomain, fixtureToDocument } from './event.js';

// seasons ↔ domain season: teams, chip rules (with their own provenance),
// points semantics and unscheduled fixtures (v0.3 §3). Points semantics are
// mapped verbatim: UNVERIFIED and CONFLICTED are never reinterpreted.

const teamToDomain = (t) => ({ id: t.id, name: t.name, shortName: t.shortName });
const ruleToDomain = (r) => ({
  chipName: r.chipName, startEvent: r.startEvent, stopEvent: r.stopEvent, number: r.number, chipType: r.chipType ?? null,
});

export const INITIAL_POINTS_SEMANTICS = Object.freeze({ value: 'UNVERIFIED', evidenceRows: 0, conflictRows: 0, firstVerifiedRunId: null });

export function seasonToDomain(doc, opts = {}) {
  if (!doc) return null;
  const ps = doc.pointsSemantics ?? INITIAL_POINTS_SEMANTICS;
  const chipRules = { source: doc.chipRules.source, rules: mapList(doc.chipRules.rules, ruleToDomain) };
  if (opts.withProvenance) chipRules.provenance = provenanceToDomain(doc.chipRules.provenance);
  return attachProvenance({
    season: doc.season,
    teams: mapList(doc.teams, teamToDomain),
    chipRules,
    pointsSemantics: {
      value: ps.value,
      evidenceRows: ps.evidenceRows,
      conflictRows: ps.conflictRows,
      firstVerifiedRunId: idString(ps.firstVerifiedRunId),
    },
    unscheduledFixtures: mapList(doc.unscheduledFixtures, fixtureToDomain),
  }, doc, opts);
}

/** Season-level snapshot fields (hashed into seasons.provenance). */
export function seasonBlockToDocument(s) {
  return {
    _id: ids.season(s.season),
    season: s.season,
    teams: mapList(s.teams, teamToDomain),
    unscheduledFixtures: mapList(s.unscheduledFixtures, fixtureToDocument),
  };
}

/** Chip-rule block (hashed into seasons.chipRules.provenance); replaced as a whole set. */
export function chipRulesToDocument(chipRules) {
  return { source: chipRules.source, rules: mapList(chipRules.rules, ruleToDomain) };
}

/** Chip rules in the shape chipAvailability takes (v0.2 §14). */
export const chipRulesToEngine = (chipRules) => chipRules.rules.map((r) => ({ ...r, source: chipRules.source }));
