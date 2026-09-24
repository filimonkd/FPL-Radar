// Eligibility (architecture v0.2 §14 eligibility.js). Pure.
//
// One reason per ineligible manager, precedence EXCLUDED > JOINED_LATER > NO_TEAM.
// NO_TEAM needs proof of absence: the member's history was fetched successfully
// (`synced: true`) and has no row for the event. A member that failed to sync
// stays eligible so the result is BLOCKED (NOT_SYNCED) rather than silently
// handing someone else the win.

export const IneligibleReason = Object.freeze({ EXCLUDED: 'EXCLUDED', JOINED_LATER: 'JOINED_LATER', NO_TEAM: 'NO_TEAM' });

/**
 * @param {{ entryId: number, isExcluded?: boolean, joinedEvent?: number|null, synced?: boolean }[]} members
 * @param {Map<number, object>} gwRows  entryId -> NormalizedGwPoints for this event
 * @param {number} event
 */
export function selectEligible(members, gwRows, event) {
  const eligible = [];
  const ineligible = [];
  for (const m of [...members].sort((a, b) => a.entryId - b.entryId)) {
    let reason = null;
    if (m.isExcluded) reason = IneligibleReason.EXCLUDED;
    else if (m.joinedEvent != null && event < m.joinedEvent) reason = IneligibleReason.JOINED_LATER;
    else if (m.synced === true && !gwRows.has(m.entryId)) reason = IneligibleReason.NO_TEAM;
    if (reason) ineligible.push({ entryId: m.entryId, reason });
    else eligible.push(m.entryId);
  }
  return { eligible, ineligible };
}
