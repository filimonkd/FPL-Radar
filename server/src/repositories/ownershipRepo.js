import { Player } from '../models/Player.js';
import { Season } from '../models/Season.js';
import { Event } from '../models/Event.js';
import { Manager } from '../models/Manager.js';
import { ManagerGameweek } from '../models/ManagerGameweek.js';
import { managerToDomain } from './mappers/manager.js';
import { managerGameweekToDomain } from './mappers/managerGameweek.js';
import { eventToDomain } from './mappers/event.js';
import { ids } from '../db/ids.js';
import { seasonToDomain, chipRulesToEngine } from './mappers/season.js';
import { playerToDomain } from './mappers/player.js';
import { memberToEngine } from './mappers/group.js';
import { toEngineGwRow } from './mappers/managerGameweek.js';
import { liveToEngineMap } from './mappers/live.js';
import { loadGroupGw, loadRuns, buildSources } from './internal/assemble.js';

// Ownership / captaincy / transfer / chip input assembler (v0.3 §10 rule 3): picks,
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
   * Chip inputs for one GW (v0.2 §8): the season's validated chip rules (with
   * their own provenance), every member's played chips (managerSeasons, from
   * FPL history) and the GW rows' squad chips.
   * @returns {Promise<{ members, gwRows, rows, played, synced, chipRules, eventState, sources }>}
   *   rows: [{ entryId, activeChip, hasPicks, picks, autoSubs }] for the GW;
   *   played: [{ entryId, chipName, event }] for synced members;
   *   chipRules: { source, rules (engine form) } or null when the season has none stored.
   */
  async loadChips(groupId, season, event, { session } = {}) {
    const { group, eventDoc, rows, managerSeasons } = await loadGroupGw(groupId, season, event, session);
    const seasonDoc = seasonToDomain(await Season.findById(ids.season(season)).session(session ?? null).lean(), { withProvenance: true });
    const members = group.members.map((m) => ({ ...memberToEngine(m, managerSeasons.some((s) => s.entryId === m.entryId)), leftLeague: m.leftLeague }));
    return {
      members,
      gwRows: rows.map(toEngineGwRow),
      rows: rows.map((r) => ({ entryId: r.entryId, activeChip: r.activeChip, hasPicks: r.hasPicks, picks: r.picks, autoSubs: r.autoSubs })),
      played: managerSeasons.flatMap((m) => m.chips.map((c) => ({ entryId: m.entryId, chipName: c.name, event: c.event }))),
      synced: managerSeasons.map((m) => m.entryId),
      chipRules: seasonDoc ? { source: seasonDoc.chipRules.source, rules: chipRulesToEngine(seasonDoc.chipRules) } : null,
      eventState: eventDoc?.state ?? null,
      sources: await sourcesOf([eventDoc, seasonDoc ? { provenance: seasonDoc.chipRules.provenance } : null, ...rows, ...managerSeasons], session),
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

  /**
   * Rival analytics inputs (Step 16): every member's season rows up to the GW,
   * their latest known squads, manager names, the players those squads use
   * (with FPL ep_next) and the fixtures of the next three GWs. Read-only.
   * @returns {Promise<{ group, managers, rows, squads, players, upcoming, eventState, sources }>}
   */
  async loadRivalInputs(groupId, season, event, { session } = {}) {
    const s = session ?? null;
    const { group, eventDoc } = await loadGroupGw(groupId, season, event, session);
    const entryIds = group.members.map((m) => m.entryId);
    const rowDocs = await ManagerGameweek.find({ season, entryId: { $in: entryIds }, event: { $lte: event } }).sort({ entryId: 1, event: 1 }).session(s).lean();
    const rows = rowDocs.map((d) => managerGameweekToDomain(d, { withProvenance: true }));
    const managers = (await Manager.find({ entryId: { $in: entryIds } }).sort({ entryId: 1 }).session(s).lean()).map((d) => managerToDomain(d));
    const squads = rows.filter((r) => r.hasPicks).map((r) => ({ entryId: r.entryId, event: r.event, picks: r.picks }));
    const players = await playersFor(season, squads.flatMap((q) => q.picks.map((p) => p.elementId)), session);
    const nextGws = [event + 1, event + 2, event + 3].filter((g) => g <= 38);
    const upcomingDocs = await Event.find({ season, gw: { $in: nextGws } }).sort({ gw: 1 }).session(s).lean();
    const upcoming = upcomingDocs.map((d) => eventToDomain(d)).flatMap((e) => e.fixtures.map((f) => ({ event: e.gw, teamH: f.teamH, teamA: f.teamA, teamHFdr: f.teamHFdr ?? null, teamAFdr: f.teamAFdr ?? null })));
    return {
      group,
      managers,
      rows,
      squads,
      players,
      upcoming,
      eventState: eventDoc?.state ?? null,
      sources: await sourcesOf([eventDoc, ...rows], session),
    };
  },
};
