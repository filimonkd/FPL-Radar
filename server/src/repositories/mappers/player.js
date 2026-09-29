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
    news: doc.news ?? null,
    newsAdded: doc.newsAdded ?? null,
    chanceNext: doc.chanceNext ?? null,
    selectedByTenths: doc.selectedByTenths ?? null,
    formTenths: doc.formTenths ?? null,
    ppgTenths: doc.ppgTenths ?? null,
    totalPoints: doc.totalPoints ?? null,
    minutes: doc.minutes ?? null,
    costChangeEventTenths: doc.costChangeEventTenths ?? null,
    costChangeStartTenths: doc.costChangeStartTenths ?? null,
    transfersInEvent: doc.transfersInEvent ?? null,
    transfersOutEvent: doc.transfersOutEvent ?? null,
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
    news: p.news ?? null,
    newsAdded: p.newsAdded ?? null,
    chanceNext: p.chanceNext ?? null,
    selectedByTenths: p.selectedByTenths ?? null,
    formTenths: p.formTenths ?? null,
    ppgTenths: p.ppgTenths ?? null,
    totalPoints: p.totalPoints ?? null,
    minutes: p.minutes ?? null,
    costChangeEventTenths: p.costChangeEventTenths ?? null,
    costChangeStartTenths: p.costChangeStartTenths ?? null,
    transfersInEvent: p.transfersInEvent ?? null,
    transfersOutEvent: p.transfersOutEvent ?? null,
  };
}
