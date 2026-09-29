// Injury & news feed (Step 18). Pure: the players view (FPL's news fields plus
// the Step 17 stats) and who owns whom in, flagged feed items out. Flags are
// signals taken from FPL's own data, never predictions.

/** FPL player status codes that mean he will not play. */
export const OUT_STATUS = Object.freeze({ i: 'Injured', s: 'Suspended', u: 'Unavailable', n: 'Not available' });
/** Net transfers in this GW at or above which a rise is flagged as likely pressure. */
export const PRICE_PRESSURE_NET = 50_000;
/** Most severe first; also the order flags are listed in. */
export const FLAG_ORDER = Object.freeze(['OUT', 'DOUBT', 'ROTATION', 'PRICE_DROPPED', 'PRICE_PRESSURE']);
/** Flags worth an alert on the owner's own squad (price pressure is good news for an owner). */
export const ALERT_FLAGS = Object.freeze(['OUT', 'DOUBT', 'ROTATION', 'PRICE_DROPPED']);

/**
 * @param {{ status, chanceNext, rotation?: { risk }, transfersInEvent, transfersOutEvent, costChangeEventTenths }} p
 * @returns {{ code: string, label?: string, chance?: number|null, net?: number, changeTenths?: number }[]}
 */
export function playerFlags(p) {
  const flags = [];
  if (OUT_STATUS[p.status]) flags.push({ code: 'OUT', label: OUT_STATUS[p.status], chance: p.chanceNext ?? null });
  if (p.status === 'd') flags.push({ code: 'DOUBT', chance: p.chanceNext ?? null });
  if (p.rotation?.risk === true) flags.push({ code: 'ROTATION' });
  if (p.costChangeEventTenths != null && p.costChangeEventTenths < 0) flags.push({ code: 'PRICE_DROPPED', changeTenths: p.costChangeEventTenths });
  if (p.transfersInEvent != null && p.transfersOutEvent != null) {
    const net = p.transfersInEvent - p.transfersOutEvent;
    if (net >= PRICE_PRESSURE_NET) flags.push({ code: 'PRICE_PRESSURE', net });
  }
  return flags;
}

/**
 * Who owns each player: elementId → entry ids (ascending).
 * @param {{ entryId: number, elementIds: number[] }[]} squads  each member's latest known 15
 * @returns {Map<number, number[]>}
 */
export function ownersByElement(squads) {
  const owners = new Map();
  for (const s of [...squads].sort((a, b) => a.entryId - b.entryId)) {
    for (const id of new Set(s.elementIds)) {
      if (!owners.has(id)) owners.set(id, []);
      owners.get(id).push(s.entryId);
    }
  }
  return owners;
}

const severity = (flags) => (flags.length ? FLAG_ORDER.indexOf(flags[0].code) : FLAG_ORDER.length);
const time = (d) => (d == null ? null : new Date(d).getTime());

/**
 * @param {{ players: object[], squads: { entryId: number, elementIds: number[] }[], myEntryId: number|null }} input
 *   players: the players view rows; squads: each member's latest known 15.
 * @returns {{ items: object[], mine: object[] }}
 *   items: owned players with news or a flag, newest FPL news first (no
 *   timestamp last), then most severe; mine: my squad's alert-worthy items.
 */
export function buildNewsFeed({ players, squads, myEntryId = null }) {
  const owners = ownersByElement(squads);
  const items = players
    .filter((p) => owners.has(p.elementId))
    .map((p) => {
      const ownedBy = owners.get(p.elementId);
      const flags = playerFlags(p);
      return {
        elementId: p.elementId,
        webName: p.webName,
        team: p.team ?? null,
        position: p.position ?? null,
        status: p.status ?? null,
        news: p.news ?? null,
        newsAdded: p.newsAdded ?? null,
        chanceNext: p.chanceNext ?? null,
        flags,
        ownedBy,
        ownedByMe: myEntryId != null && ownedBy.includes(myEntryId),
      };
    })
    .filter((x) => x.news || x.flags.length)
    .sort((a, b) => {
      const ta = time(a.newsAdded);
      const tb = time(b.newsAdded);
      if (ta !== tb) return ta == null ? 1 : tb == null ? -1 : tb - ta;
      return severity(a.flags) - severity(b.flags) || a.elementId - b.elementId;
    });
  const mine = items
    .filter((x) => x.ownedByMe && x.flags.some((f) => ALERT_FLAGS.includes(f.code)))
    .sort((a, b) => severity(a.flags) - severity(b.flags) || a.elementId - b.elementId);
  return { items, mine };
}
