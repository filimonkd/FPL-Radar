import { ids } from '../../db/ids.js';
import { attachProvenance } from './common.js';

// managers ↔ domain manager profile. _id = entryId (v0.3 §4).

export function managerToDomain(doc, opts) {
  if (!doc) return null;
  return attachProvenance({ entryId: doc.entryId, playerName: doc.playerName, teamName: doc.teamName }, doc, opts);
}

export function managerToDocument(m) {
  return { _id: ids.manager(m.entryId), entryId: m.entryId, playerName: m.playerName, teamName: m.teamName };
}
