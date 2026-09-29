// Each member's latest known squad up to a GW, from ownershipRepo.loadRivalInputs
// squads (one per member GW with picks). Shared by the news feed and the finder.

/** @returns {{ entryId: number, event: number, elementIds: number[] }[]} ascending by entryId */
export function latestSquads(squads) {
  const latest = new Map();
  for (const q of squads) {
    if (!latest.has(q.entryId) || latest.get(q.entryId).event < q.event) latest.set(q.entryId, q);
  }
  return [...latest.values()]
    .map((q) => ({ entryId: q.entryId, event: q.event, elementIds: q.picks.map((p) => p.elementId) }))
    .sort((a, b) => a.entryId - b.entryId);
}
