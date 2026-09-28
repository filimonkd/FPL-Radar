import { deriveEffectiveSquad, computeOwnership, selectEligible, summarizeTransfers } from '../analytics/index.js';
import { pickViolations } from '../models/validation/picks.js';
import { contentHash } from '../utils/canonical.js';

// Pure ownership / captaincy / transfer views (architecture v0.2 §7, §14).
// Every multiplier, captain decision and share is computed by the unchanged
// analytics engine; this module fixes the exact inputs (so a view can be
// reproduced from persisted data and identified by an inputsHash), maps players
// to the PlayerRef shape the engine expects, and orders rows deterministically.

const byNumber = (a, b) => a - b;
const EFFECTIVE_BY_DEFAULT = new Set(['MATCHES_FINISHED', 'FPL_PROCESSING', 'DATA_CHECKED']);

/** PlayerRef for computeOwnership: `id` is the FPL element id (a number), never the storage id. */
export const toPlayerRef = (p) => ({
  id: p.elementId, webName: p.webName, teamId: p.teamId, elementType: p.elementType, priceTenths: p.priceTenths, status: p.status ?? null,
});

/**
 * The canonical, plain inputs of an ownership view, from ownershipRepo.loadSquads.
 * Live data is narrowed to picked elements; everything is sorted.
 */
export function ownershipInputs(loaded, event) {
  const picked = new Set(loaded.squads.flatMap((s) => s.picks.map((p) => p.elementId)));
  return {
    event,
    eventState: loaded.eventState,
    myEntryId: loaded.myEntryId,
    members: [...loaded.members].sort((a, b) => a.entryId - b.entryId),
    // Eligibility only needs to know a GW row exists; ownership never depends on
    // points labels (pointsSemantics / reconciliation), so they are not inputs.
    gwRows: presence(loaded.gwRows),
    squads: [...loaded.squads].sort((a, b) => a.entryId - b.entryId).map((s) => ({
      entryId: s.entryId,
      picks: [...s.picks].sort((a, b) => a.squadPosition - b.squadPosition),
      activeChip: s.activeChip ?? null,
      autoSubs: s.autoSubs ?? [],
      grossGwPoints: s.grossGwPoints ?? null,
    })),
    live: [...loaded.live].filter(([id]) => picked.has(id)).sort(([a], [b]) => a - b)
      .map(([elementId, l]) => ({ elementId, minutes: l.minutes, totalPoints: l.totalPoints, fixturesSettled: l.fixturesSettled })),
    players: [...loaded.players.values()].map(toPlayerRef).sort((a, b) => a.id - b.id),
  };
}

const presence = (gwRows) => [...gwRows].map((r) => ({ entryId: r.entryId, event: r.event })).sort((a, b) => a.entryId - b.entryId);

const metricValue = (row, view) => (view === 'picked' ? row.pickedEo.all : row.effectiveEo.all);

/**
 * The ownership view (picked and effective ownership, captaincy per manager).
 * @param {ReturnType<typeof ownershipInputs>} inputs
 * @param {{ view?: 'picked'|'effective' }} [opts]  row order; default by event state (v0.2 §7)
 */
export function buildOwnershipView(inputs, { view } = {}) {
  const defaultView = EFFECTIVE_BY_DEFAULT.has(inputs.eventState) ? 'effective' : 'picked';
  const order = view ?? defaultView;
  const rowByEntry = new Map(inputs.gwRows.map((r) => [r.entryId, r]));
  const { eligible, ineligible } = selectEligible(inputs.members, rowByEntry, inputs.event);
  const eligibleSet = new Set(eligible);
  const live = new Map(inputs.live.map((l) => [l.elementId, { minutes: l.minutes, totalPoints: l.totalPoints, fixturesSettled: l.fixturesSettled }]));
  const players = new Map(inputs.players.map((p) => [p.id, p]));

  const squads = new Map();
  const invalid = [];
  for (const s of inputs.squads) {
    if (!eligibleSet.has(s.entryId)) continue;
    const violations = pickViolations(s.picks);
    if (violations.length) {
      invalid.push({ entryId: s.entryId, violations }); // never guessed: counted as missing picks
      continue;
    }
    squads.set(s.entryId, deriveEffectiveSquad({ picks: s.picks, activeChip: s.activeChip, autoSubs: s.autoSubs, live, grossGwPoints: s.grossGwPoints }));
  }

  const own = computeOwnership({ squads, eligible, myEntryId: inputs.myEntryId, players });
  const rows = [...own.rows].sort((a, b) => {
    const x = metricValue(a, order);
    const y = metricValue(b, order);
    if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
    return a.player.id - b.player.id;
  });

  const captaincy = [...squads].sort(([a], [b]) => a - b).map(([entryId, s]) => ({
    entryId,
    pickedCaptain: s.pickedCaptain,
    pickedVice: s.pickedVice,
    capMult: s.capMult,
    tripleCaptain: s.capMult === 3,
    benchBoost: s.benchBoost,
    effectiveCaptain: s.effectiveCaptain,
    captainPoints: s.captainPoints,
    autoSubSource: s.autoSubSource,
    autoSubbed: s.picks.filter((p) => p.autoSubbed).map((p) => ({ elementId: p.elementId, autoSubbed: p.autoSubbed })),
    reconstructedPoints: s.reconstructedPoints,
    warnings: s.warnings,
  }));

  const pending = captaincy.filter((c) => c.effectiveCaptain.via === 'PENDING').map((c) => c.entryId);
  return {
    event: inputs.event,
    eventState: inputs.eventState,
    view: order,
    defaultView,
    // Effective metrics are provisional until DATA_CHECKED and while any captaincy is pending.
    effectiveProvisional: inputs.eventState !== 'DATA_CHECKED' || pending.length > 0,
    pendingCaptaincy: pending,
    eligible: [...eligible].sort(byNumber),
    ineligible,
    denominators: own.denominators,
    missingEntryIds: own.missingEntryIds,
    invalidPicks: invalid,
    myEntryId: inputs.myEntryId,
    rows,
    captaincy,
    inputsHash: contentHash(inputs),
  };
}

/** Canonical inputs of a transfer view, from ownershipRepo.loadTransfers. */
export function transferInputs(loaded, event) {
  return {
    event,
    eventState: loaded.eventState,
    members: [...loaded.members].sort((a, b) => a.entryId - b.entryId),
    gwRows: presence(loaded.gwRows),
    rows: [...loaded.rows].sort(([a], [b]) => a - b).map(([entryId, r]) => ({ entryId, ...r })),
    transfers: [...loaded.transfers].sort(([a], [b]) => a - b).map(([entryId, list]) => ({ entryId, list: list.filter((t) => t.event === event) })),
    players: [...loaded.players.values()].map(toPlayerRef).sort((a, b) => a.id - b.id),
  };
}

export function buildTransferView(inputs) {
  const rowByEntry = new Map(inputs.gwRows.map((r) => [r.entryId, r]));
  const { eligible } = selectEligible(inputs.members, rowByEntry, inputs.event);
  const summary = summarizeTransfers({
    event: inputs.event,
    eligible,
    transfersByEntry: new Map(inputs.transfers.map((t) => [t.entryId, t.list])),
    rows: new Map(inputs.rows.map(({ entryId, ...r }) => [entryId, r])),
    players: new Map(inputs.players.map((p) => [p.id, p])),
  });
  return { ...summary, eventState: inputs.eventState, inputsHash: contentHash(inputs) };
}
