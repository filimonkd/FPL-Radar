import { idString, toObjectId, mapList } from './common.js';

// groups ↔ domain group (members embedded, v0.3 §3).

const memberToDomain = (m) => ({
  entryId: m.entryId,
  isExcluded: m.isExcluded ?? false,
  joinedEvent: m.joinedEvent ?? null,
  leftLeague: m.leftLeague ?? false,
  addedManually: m.addedManually ?? false,
  addedAt: m.addedAt,
});

export const memberToDocument = (m) => ({
  entryId: m.entryId,
  isExcluded: m.isExcluded ?? false,
  joinedEvent: m.joinedEvent ?? null,
  leftLeague: m.leftLeague ?? false,
  addedManually: m.addedManually ?? false,
  addedAt: m.addedAt,
});

export function groupToDomain(doc) {
  if (!doc) return null;
  return {
    id: idString(doc._id),
    name: doc.name,
    slug: doc.slug,
    memberSource: doc.memberSource,
    fplLeagueId: doc.fplLeagueId ?? null,
    myEntryId: doc.myEntryId ?? null,
    winnerRule: doc.winnerRule,
    tieBreakRules: [...doc.tieBreakRules],
    shareToken: doc.shareToken ?? null,
    isActive: doc.isActive,
    archivedAt: doc.archivedAt ?? null,
    members: mapList(doc.members, memberToDomain),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function groupToDocument(g) {
  const doc = {
    name: g.name,
    slug: g.slug,
    memberSource: g.memberSource,
    fplLeagueId: g.fplLeagueId ?? null,
    myEntryId: g.myEntryId ?? null,
    winnerRule: g.winnerRule,
    ...(g.tieBreakRules === undefined ? {} : { tieBreakRules: [...g.tieBreakRules] }),
    shareToken: g.shareToken ?? null,
    isActive: g.isActive ?? true,
    archivedAt: g.archivedAt ?? null,
    members: mapList(g.members, memberToDocument),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
  if (g.id != null) doc._id = toObjectId(g.id, 'group id');
  return doc;
}

/** The member snapshot computeGwResult / selectEligible take (v0.2 §14). */
export const memberToEngine = (m, synced) => ({
  entryId: m.entryId,
  isExcluded: m.isExcluded,
  joinedEvent: m.joinedEvent,
  synced,
});
