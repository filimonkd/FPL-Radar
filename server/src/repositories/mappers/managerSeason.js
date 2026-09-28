import { ids } from '../../db/ids.js';
import { attachProvenance, mapList } from './common.js';

// managerSeasons ↔ domain chips + transfers. Lists are full FPL lists, replaced
// wholesale; transfers are de-duplicated on time + in + out (v0.3 §4).

const chipToDomain = (c) => ({ name: c.name, event: c.event, time: c.time ?? null });
const transferToDomain = (t) => ({
  elementIn: t.elementIn,
  elementInCostTenths: t.elementInCostTenths,
  elementOut: t.elementOut,
  elementOutCostTenths: t.elementOutCostTenths,
  event: t.event,
  time: t.time,
});

const transferKey = (t) => `${new Date(t.time).toISOString()}|${t.elementIn}|${t.elementOut}`;

export function dedupeTransfers(transfers) {
  const seen = new Set();
  const out = [];
  for (const t of transfers ?? []) {
    const key = transferKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function managerSeasonToDomain(doc, opts) {
  if (!doc) return null;
  return attachProvenance({
    id: doc._id,
    season: doc.season,
    entryId: doc.entryId,
    chips: mapList(doc.chips, chipToDomain),
    transfers: mapList(doc.transfers, transferToDomain),
  }, doc, opts);
}

export function managerSeasonToDocument(ms) {
  return {
    _id: ids.managerSeason(ms.season, ms.entryId),
    season: ms.season,
    entryId: ms.entryId,
    chips: mapList(ms.chips, chipToDomain),
    transfers: dedupeTransfers(ms.transfers).map(transferToDomain),
  };
}
