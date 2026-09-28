import { ids } from '../../db/ids.js';
import { attachProvenance, mapList } from './common.js';

// managerGameweeks ↔ domain GW row (normalized points + picks, v0.3 §3).
// Points are mapped verbatim: pointsSemantics keeps UNVERIFIED / CONFLICTED,
// net/gross stay null unless reconciled, and nothing picks gross or net here.

const pointsToDomain = (p) => ({
  reportedGwPoints: p.reportedGwPoints,
  transferCost: p.transferCost,
  netGwPoints: p.netGwPoints ?? null,
  grossGwPoints: p.grossGwPoints ?? null,
  totalPoints: p.totalPoints,
  previousTotalPoints: p.previousTotalPoints ?? null,
  picksReportedPoints: p.picksReportedPoints ?? null,
  pointsSemantics: p.pointsSemantics,
  reconciliationStatus: p.reconciliationStatus,
  reconciliationDetail: {
    delta: p.reconciliationDetail?.delta ?? null,
    hypothesis: p.reconciliationDetail?.hypothesis,
    picksPoints: p.reconciliationDetail?.picksPoints ?? null,
  },
});

const pickToDomain = (p) => ({
  elementId: p.elementId, squadPosition: p.squadPosition, fplMultiplier: p.fplMultiplier, isCaptain: p.isCaptain, isViceCaptain: p.isViceCaptain,
});
const autoSubToDomain = (a) => ({ elementIn: a.elementIn, elementOut: a.elementOut, source: a.source });

export function managerGameweekToDomain(doc, opts) {
  if (!doc) return null;
  return attachProvenance({
    id: doc._id,
    season: doc.season,
    entryId: doc.entryId,
    event: doc.event,
    points: pointsToDomain(doc.points),
    eventTransfers: doc.eventTransfers ?? 0,
    pointsOnBench: doc.pointsOnBench ?? 0,
    overallRank: doc.overallRank ?? null,
    bankTenths: doc.bankTenths ?? null,
    teamValueTenths: doc.teamValueTenths ?? null,
    activeChip: doc.activeChip ?? null,
    hasPicks: doc.hasPicks,
    picks: mapList(doc.picks, pickToDomain),
    autoSubs: mapList(doc.autoSubs, autoSubToDomain),
  }, doc, opts);
}

export function managerGameweekToDocument(r) {
  return {
    _id: ids.managerGameweek(r.season, r.entryId, r.event),
    season: r.season,
    entryId: r.entryId,
    event: r.event,
    points: pointsToDomain(r.points),
    eventTransfers: r.eventTransfers ?? 0,
    pointsOnBench: r.pointsOnBench ?? 0,
    overallRank: r.overallRank ?? null,
    bankTenths: r.bankTenths ?? null,
    teamValueTenths: r.teamValueTenths ?? null,
    activeChip: r.activeChip ?? null,
    hasPicks: r.hasPicks,
    picks: mapList(r.picks, pickToDomain),
    autoSubs: mapList(r.autoSubs, autoSubToDomain),
  };
}

/**
 * reconcileSeason() output row (NormalizedGwPoints, v0.2 §14) → stored points.
 * Copies every value as computed; picksReportedPoints is the Rpicks the
 * reconciliation used.
 */
export function pointsFromNormalized(n) {
  return pointsToDomain({ ...n, picksReportedPoints: n.reconciliationDetail?.picksPoints ?? null });
}

/** Domain GW row → the flat NormalizedGwPoints row computeGwResult takes (v0.2 §14). */
export function toEngineGwRow(r) {
  return {
    entryId: r.entryId,
    season: r.season,
    event: r.event,
    ...pointsToDomain(r.points),
    pointsOnBench: r.pointsOnBench,
    activeChip: r.activeChip,
    overallRank: r.overallRank,
  };
}
