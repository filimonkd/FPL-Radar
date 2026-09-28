import { Player } from '../models/Player.js';
import { playerToDomain } from './mappers/player.js';
import { memberToEngine } from './mappers/group.js';
import { toEngineGwRow } from './mappers/managerGameweek.js';
import { liveToEngineMap } from './mappers/live.js';
import { loadGroupGw } from './internal/assemble.js';

// Ownership input assembler (v0.3 §10 rule 3): picks, chips, auto-subs and live
// data for deriveEffectiveSquad, plus what selectEligible and computeOwnership
// take. Read-only.

export const ownershipRepo = {
  /**
   * @returns {Promise<{ myEntryId, members, gwRows, squads, live, players }>}
   *   squads: [{ entryId, picks, activeChip, autoSubs, grossGwPoints }] for rows with picks, by entryId;
   *   live: Map elementId → { minutes, totalPoints, fixturesSettled };
   *   players: Map elementId → player (every picked element found for the season).
   */
  async loadSquads(groupId, season, event, { session } = {}) {
    const { group, rows, managerSeasons, live } = await loadGroupGw(groupId, season, event, session);
    const synced = new Set(managerSeasons.map((m) => m.entryId));
    const withPicks = rows.filter((r) => r.hasPicks);
    const elementIds = [...new Set(withPicks.flatMap((r) => r.picks.map((p) => p.elementId)))].sort((a, b) => a - b);
    const playerDocs = await Player.find({ season, elementId: { $in: elementIds } }).sort({ elementId: 1 }).session(session ?? null).lean();
    return {
      myEntryId: group.myEntryId,
      members: group.members.map((m) => memberToEngine(m, synced.has(m.entryId))),
      gwRows: rows.map(toEngineGwRow),
      squads: withPicks.map((r) => ({
        entryId: r.entryId, picks: r.picks, activeChip: r.activeChip, autoSubs: r.autoSubs, grossGwPoints: r.points.grossGwPoints,
      })),
      live: liveToEngineMap(live),
      players: new Map(playerDocs.map((d) => { const p = playerToDomain(d); return [p.elementId, p]; })),
    };
  },
};
