import { ids } from '../../db/ids.js';
import { attachProvenance } from './common.js';

// players ↔ domain player (prices in integer tenths, v0.3 §3).

export function playerToDomain(doc, opts) {
  if (!doc) return null;
  return attachProvenance({
    id: doc._id,
    season: doc.season,
    elementId: doc.elementId,
    webName: doc.webName,
    teamId: doc.teamId,
    elementType: doc.elementType,
    priceTenths: doc.priceTenths,
    status: doc.status ?? null,
    epNextTenths: doc.epNextTenths ?? null,
  }, doc, opts);
}

export function playerToDocument(p) {
  return {
    _id: ids.player(p.season, p.elementId),
    season: p.season,
    elementId: p.elementId,
    webName: p.webName,
    teamId: p.teamId,
    elementType: p.elementType,
    priceTenths: p.priceTenths,
    status: p.status ?? null,
    epNextTenths: p.epNextTenths ?? null,
  };
}
