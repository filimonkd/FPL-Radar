// Transfer activity for one gameweek. Pure.
//
// v0.2 §14 names analytics/transfers.js with "signatures unchanged from
// v0.1 §10", but v0.1 §10 is not available, so this is a factual summary only:
// the transfers each eligible manager made in the GW (as FPL lists them), their
// reported transfer count / cost / chip, and how many managers brought each
// player in or out. No advice, no scoring of transfers, no inferred semantics.

const byNumber = (a, b) => a - b;

/**
 * @param {{
 *   event: number,
 *   eligible: number[],
 *   transfersByEntry: Map<number, { elementIn: number, elementInCostTenths: number, elementOut: number, elementOutCostTenths: number, event: number, time: Date|string }[]>,
 *   rows: Map<number, { eventTransfers: number|null, transferCost: number|null, activeChip: string|null }>,
 *   players?: Map<number, object>,
 * }} input
 */
export function summarizeTransfers({ event, eligible, transfersByEntry, rows, players = new Map() }) {
  const ids = [...eligible].sort(byNumber);
  const members = [];
  const missingEntryIds = [];
  const ins = new Map();
  const outs = new Map();
  const tally = (map, elementId, entryId) => map.set(elementId, [...(map.get(elementId) ?? []), entryId]);
  const time = (t) => new Date(t).getTime();

  for (const entryId of ids) {
    const list = transfersByEntry.get(entryId);
    if (!list) {
      missingEntryIds.push(entryId); // no synced transfer list: reported, never treated as "no transfers"
      continue;
    }
    const made = list
      .filter((t) => t.event === event)
      .map((t) => ({ elementIn: t.elementIn, elementInCostTenths: t.elementInCostTenths, elementOut: t.elementOut, elementOutCostTenths: t.elementOutCostTenths, time: t.time }))
      .sort((a, b) => time(a.time) - time(b.time) || a.elementIn - b.elementIn || a.elementOut - b.elementOut);
    const row = rows.get(entryId) ?? null;
    members.push({
      entryId,
      transfers: made,
      eventTransfers: row?.eventTransfers ?? null,
      transferCost: row?.transferCost ?? null,
      activeChip: row?.activeChip ?? null,
    });
    for (const t of made) {
      tally(ins, t.elementIn, entryId);
      tally(outs, t.elementOut, entryId);
    }
  }

  const ranked = (map) => [...map]
    .map(([elementId, entryIds]) => ({ elementId, player: players.get(elementId) ?? { id: elementId }, count: entryIds.length, entryIds: [...entryIds].sort(byNumber) }))
    .sort((a, b) => b.count - a.count || a.elementId - b.elementId);

  const withCost = members.filter((m) => m.transferCost !== null);
  return {
    event,
    members,
    playersIn: ranked(ins),
    playersOut: ranked(outs),
    totals: {
      transfers: members.reduce((n, m) => n + m.transfers.length, 0),
      managersWithTransfers: members.filter((m) => m.transfers.length > 0).length,
      managersWithHits: withCost.filter((m) => m.transferCost > 0).length,
      hitCost: withCost.reduce((n, m) => n + m.transferCost, 0),
    },
    missingEntryIds,
  };
}
