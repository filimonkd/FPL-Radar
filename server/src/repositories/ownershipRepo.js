import { Player } from '../models/Player.js';
import { playerToDomain } from './mappers/player.js';
import { memberToEngine } from './mappers/group.js';
import { toEngineGwRow } from './mappers/managerGameweek.js';
import { liveToEngineMap } from './mappers/live.js';
import { loadGroupGw, loadRuns, buildSources } from './internal/assemble.js';

// Ownership / captaincy / transfer input assembler (v0.3 §10 rule 3): picks,
// chips, auto-subs and live data for deriveEffectiveSquad, plus what
// selectEligible, computeOwnership and the transfer summary take. Read-only;
// ownership tables are computed on read and never stored (v0.2 §9).

async function playersFor(season, elementIds, session) {
  const ids = [...new Set(elementIds)].sort((a, b) => a - b);
  if (ids.length === 0) return new Map();
  const docs = await Player.find({ season, elementId: { $in: ids } }).sort({ elementId: 1 }).session(session ?? null).lean();
  return new Map(docs.map((d) => { const p = playerToDomain(d); return [p.elementId, p]; }));
}

async function sourcesOf(docs, session) {
  const runIds = [...new Set(docs.map((d) => d?.provenance?.lastConfirmedByRunId).filter(Boolean))];
  return buildSources(docs, await loadRuns(runIds, session));
}

export const ownershipRepo = {
  /**
   * @returns {Promise<{ myEntryId, members, gwRows, squads, live, players, eventState, sources }>}
   *   squads: [{ entryId, picks, activeChip, autoSubs, grossGwPoints }] for rows with picks, by entryId;
   *   live: Map elementId → { minutes, totalPoints, fixturesSettled };
   *   players: Map elementId → player (every picked element found for the season);
   *   sources: the runs (and request hashes) that last confirmed the event, GW rows and live data (v0.3 §8).
   */
  async loadSquads(groupId, season, event, { session } = {}) {
    const { group, eventDoc, rows, managerSeasons, live } = await loadGroupGw(groupId, season, event, session);
    const synced = new Set(managerSeasons.map((m) => m.entryId));
    const withPicks = rows.filter((r) => r.hasPicks);
    const players = await playersFor(season, withPicks.flatMap((r) => r.picks.map((p) => p.elementId)), session);
    return {
      myEntryId: group.myEntryId,
      members: group.members.map((m) => memberToEngine(m, synced.has(m.entryId))),
      gwRows: rows.map(toEngineGwRow),
      squads: withPicks.map((r) => ({
        entryId: r.entryId, picks: r.picks, activeChip: r.activeChip, autoSubs: r.autoSubs, grossGwPoints: r.points.grossGwPoints,
      })),
      live: liveToEngineMap(live),
      players,
      eventState: eventDoc?.state ?? null,
      sources: await sourcesOf([eventDoc, live, ...rows], session),
    };
  },

  /**
   * Transfer activity inputs for one GW.
   * @returns {Promise<{ myEntryId, members, gwRows, rows, transfers, players, eventState, sources }>}
   *   rows: Map entryId → { eventTransfers, transferCost, activeChip } from the GW rows;
   *   transfers: Map entryId → the full FPL transfer list (managerSeasons), for synced entries only.
   */
  async loadTransfers(groupId, season, event, { session } = {}) {
    const { group, eventDoc, rows, managerSeasons } = await loadGroupGw(groupId, season, event, session);
    const synced = new Set(managerSeasons.map((m) => m.entryId));
    const transfers = new Map(managerSeasons.map((m) => [m.entryId, m.transfers]));
    const moved = managerSeasons.flatMap((m) => m.transfers.filter((t) => t.event === event).flatMap((t) => [t.elementIn, t.elementOut]));
    return {
      myEntryId: group.myEntryId,
      members: group.members.map((m) => memberToEngine(m, synced.has(m.entryId))),
      gwRows: rows.map(toEngineGwRow),
      rows: new Map(rows.map((r) => [r.entryId, { eventTransfers: r.eventTransfers, transferCost: r.points.transferCost, activeChip: r.activeChip }])),
      transfers,
      players: await playersFor(season, moved, session),
      eventState: eventDoc?.state ?? null,
      sources: await sourcesOf([eventDoc, ...rows, ...managerSeasons], session),
    };
  },
};
