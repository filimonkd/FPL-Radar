import { computeRivals } from '../analytics/rivals.js';
import { contentHash } from '../utils/canonical.js';

// Loaded repository data → the pure computeRivals input (Step 16). The GW
// score is the one the group's winner rule uses (net or gross after
// reconciliation, null when not reconciled), exactly as the result engine
// reads it; nothing here decides gross vs net.

const scoreFor = (winnerRule, points) => (winnerRule === 'GROSS_POINTS' ? points.grossGwPoints : points.netGwPoints) ?? null;

export function rivalsInputs(loaded, event, { transfersIn = [], chipsLeft = null } = {}) {
  const { group } = loaded;
  return {
    event,
    myEntryId: group.myEntryId ?? null,
    members: group.members.map((m) => ({ entryId: m.entryId, isExcluded: Boolean(m.isExcluded) })).sort((a, b) => a.entryId - b.entryId),
    managers: loaded.managers.map((m) => ({ entryId: m.entryId, playerName: m.playerName, teamName: m.teamName })).sort((a, b) => a.entryId - b.entryId),
    rows: loaded.rows.map((r) => ({
      entryId: r.entryId,
      event: r.event,
      score: scoreFor(group.winnerRule, r.points),
      transferCost: r.points.transferCost,
      totalPoints: r.points.totalPoints,
      bankTenths: r.bankTenths ?? null,
      teamValueTenths: r.teamValueTenths ?? null,
      activeChip: r.activeChip ?? null,
    })).sort((a, b) => a.entryId - b.entryId || a.event - b.event),
    squads: loaded.squads.map((q) => ({
      entryId: q.entryId,
      event: q.event,
      picks: q.picks.map((p) => ({ elementId: p.elementId, squadPosition: p.squadPosition, isCaptain: p.isCaptain, isViceCaptain: p.isViceCaptain })).sort((a, b) => a.squadPosition - b.squadPosition),
    })).sort((a, b) => a.entryId - b.entryId || a.event - b.event),
    players: [...loaded.players.values()].map((p) => ({ id: p.elementId, webName: p.webName, teamId: p.teamId, epNextTenths: p.epNextTenths ?? null })).sort((a, b) => a.id - b.id),
    upcoming: [...loaded.upcoming].sort((a, b) => a.event - b.event || a.teamH - b.teamH || a.teamA - b.teamA),
    transfersIn: transfersIn.map((t) => ({ elementId: t.elementId, count: t.count, entryIds: [...t.entryIds].sort((a, b) => a - b) })),
    chipsLeft,
  };
}

export function buildRivalsView(inputs) {
  return { ...computeRivals(inputs), inputsHash: contentHash(inputs) };
}

/** Current-window chip inventory per manager from the chips view (null when rules are unknown). */
export function chipsLeftOf(chipsView) {
  if (!chipsView?.availability) return null;
  return chipsView.availability.managers.map((m) => ({
    entryId: m.entryId,
    chips: m.chips.filter((c) => c.current).map((c) => ({ chipName: c.chipName, available: c.available })),
  }));
}
