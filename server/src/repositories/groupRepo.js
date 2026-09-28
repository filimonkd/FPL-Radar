import { Group } from '../models/Group.js';
import { groupToDomain, groupToDocument, memberToDocument } from './mappers/group.js';
import { toObjectId } from './mappers/common.js';
import { DuplicateMemberError, NotFoundError } from './errors.js';
import { requireTransaction, sessionOpt } from './internal/session.js';

// groups (architecture v0.3 §10): create, update config, set members (T2, in a
// transaction), archive/unarchive (T5). No delete: archive instead (v0.2).
//
// members[].entryId uniqueness: MongoDB has no unique constraint across array
// elements, so this repository — the only writer — rejects duplicates and
// writes the members array by read-modify-write inside the caller's
// transaction (v0.3 §4). The model validator and db:check (I1) back it up.

export const CONFIG_FIELDS = Object.freeze(['name', 'winnerRule', 'tieBreakRules', 'myEntryId', 'shareToken']);

export function assertUniqueMembers(members) {
  const seen = new Set();
  const dupes = new Set();
  for (const m of members) (seen.has(m.entryId) ? dupes : seen).add(m.entryId);
  if (dupes.size) throw new DuplicateMemberError([...dupes].sort((a, b) => a - b));
}

async function loadHydrated(groupId, session) {
  const doc = await Group.findById(toObjectId(groupId, 'groupId')).session(session ?? null);
  if (!doc) throw new NotFoundError('group', groupId);
  return doc;
}

export const groupRepo = {
  /** Inserts a new active group. `at` stamps createdAt/updatedAt and any member without addedAt (default: now). */
  async create(group, { at = new Date(), session } = {}) {
    const members = (group.members ?? []).map((m) => ({ ...m, addedAt: m.addedAt ?? at }));
    assertUniqueMembers(members);
    const doc = groupToDocument({ ...group, members, isActive: true, archivedAt: null, createdAt: at, updatedAt: at });
    const [created] = await Group.create([doc], sessionOpt(session));
    return groupToDomain(created.toObject());
  },

  /** Updates configuration fields only (CONFIG_FIELDS); members and archive state have their own methods. */
  async updateConfig(groupId, patch, { at = new Date(), session } = {}) {
    const unknown = Object.keys(patch).filter((k) => !CONFIG_FIELDS.includes(k));
    if (unknown.length) throw new TypeError(`not a group config field: ${unknown.join(', ')}`);
    const doc = await loadHydrated(groupId, session);
    doc.set({ ...patch, updatedAt: at });
    await doc.save(sessionOpt(session));
    return groupToDomain(doc.toObject());
  },

  /**
   * Replaces the members array (T2). Keyed on entryId: an existing member keeps
   * its addedAt unless the input sets one. Duplicate entryIds are rejected.
   */
  async setMembers(groupId, members, { at = new Date(), session } = {}) {
    requireTransaction(session, 'groupRepo.setMembers');
    assertUniqueMembers(members);
    const doc = await loadHydrated(groupId, session);
    const previous = new Map(doc.members.map((m) => [m.entryId, m]));
    doc.members = members.map((m) => memberToDocument({ ...m, addedAt: m.addedAt ?? previous.get(m.entryId)?.addedAt ?? at }));
    doc.updatedAt = at;
    await doc.save({ session });
    return groupToDomain(doc.toObject());
  },

  /** Archives an active group (T5). Returns false when it was already archived. */
  async archive(groupId, { at = new Date(), session } = {}) {
    const r = await Group.updateOne(
      { _id: toObjectId(groupId, 'groupId'), isActive: true },
      { $set: { isActive: false, archivedAt: at, updatedAt: at } },
      sessionOpt(session),
    );
    if (r.matchedCount === 0 && !(await Group.exists({ _id: toObjectId(groupId, 'groupId') }).session(session ?? null))) {
      throw new NotFoundError('group', groupId);
    }
    return r.modifiedCount === 1;
  },

  /** Unarchives an archived group (T5). Returns false when it was already active. */
  async unarchive(groupId, { at = new Date(), session } = {}) {
    const r = await Group.updateOne(
      { _id: toObjectId(groupId, 'groupId'), isActive: false },
      { $set: { isActive: true, archivedAt: null, updatedAt: at } },
      sessionOpt(session),
    );
    if (r.matchedCount === 0 && !(await Group.exists({ _id: toObjectId(groupId, 'groupId') }).session(session ?? null))) {
      throw new NotFoundError('group', groupId);
    }
    return r.modifiedCount === 1;
  },

  async getById(groupId, { session } = {}) {
    return groupToDomain(await Group.findById(toObjectId(groupId, 'groupId')).session(session ?? null).lean());
  },

  async getBySlug(slug, { session } = {}) {
    return groupToDomain(await Group.findOne({ slug }).session(session ?? null).lean());
  },

  async getByShareToken(shareToken, { session } = {}) {
    if (typeof shareToken !== 'string' || !shareToken) return null;
    return groupToDomain(await Group.findOne({ shareToken }).session(session ?? null).lean());
  },

  /** Groups ordered by name (index active_by_name); archived ones only when asked. */
  async list({ includeArchived = false, session } = {}) {
    const filter = includeArchived ? {} : { isActive: true };
    const docs = await Group.find(filter).sort({ isActive: -1, name: 1, slug: 1 }).session(session ?? null).lean();
    return docs.map(groupToDomain);
  },

  /** Groups containing an FPL entry (index member_entry), ordered by name. */
  async listContainingEntry(entryId, { session } = {}) {
    const docs = await Group.find({ 'members.entryId': entryId }).sort({ name: 1, slug: 1 }).session(session ?? null).lean();
    return docs.map(groupToDomain);
  },
};
