import { ids } from '../../db/ids.js';
import { attachProvenance, mapList } from './common.js';

// liveGameweeks ↔ domain live data (v0.3 §3).

const elementToDomain = (e) => ({ elementId: e.elementId, totalPoints: e.totalPoints, minutes: e.minutes, settled: e.settled });

export function liveToDomain(doc, opts) {
  if (!doc) return null;
  return attachProvenance({ id: doc._id, season: doc.season, gw: doc.gw, elements: mapList(doc.elements, elementToDomain) }, doc, opts);
}

export function liveToDocument(l) {
  return { _id: ids.liveGameweek(l.season, l.gw), season: l.season, gw: l.gw, elements: mapList(l.elements, elementToDomain) };
}

/** The live Map deriveEffectiveSquad takes (v0.2 §14): elementId → { minutes, totalPoints, fixturesSettled }. */
export function liveToEngineMap(live) {
  return new Map((live?.elements ?? []).map((e) => [e.elementId, { minutes: e.minutes, totalPoints: e.totalPoints, fixturesSettled: e.settled }]));
}
