import { ids } from '../db/ids.js';
import { verifyChain } from '../audit/hashChain.js';
import { pickViolations } from '../models/validation/picks.js';
import { snapshotToDomain, actionToDomain, pointerToDomain, snapshotContentHashOf, omitKeys } from '../repositories/mappers/index.js';

// npm run db:check (architecture v0.3 §10): a read-only scan of eight invariants
// the database can't enforce by itself. It only issues find() on the native
// driver handle it is given: never a write, never a lock. Every rule reuses the
// modules the writers use (ids.js, audit/hashChain.js, validation/picks.js and
// the result mappers), so the checker can't disagree with the app.

const ERROR = 'ERROR';
const INFO = 'INFO';

// Collections whose _id is rebuilt from the document's own fields (I2).
const DETERMINISTIC_IDS = {
  seasons: (d) => ids.season(d.season),
  events: (d) => ids.event(d.season, d.gw),
  players: (d) => ids.player(d.season, d.elementId),
  managerGameweeks: (d) => ids.managerGameweek(d.season, d.entryId, d.event),
  managerSeasons: (d) => ids.managerSeason(d.season, d.entryId),
  liveGameweeks: (d) => ids.liveGameweek(d.season, d.gw),
  gwResults: (d) => ids.gwResult(String(d.groupId), d.season, d.event),
};
const LOCK_ID = /^[a-z]+(:[a-z]+)*(:.+)?$/;
// Mutable snapshot collections carrying provenance.lastConfirmedByRunId (I6 INFO).
const PROVENANCE_COLLECTIONS = ['seasons', 'events', 'players', 'managerGameweeks', 'managerSeasons', 'liveGameweeks'];

const str = (v) => (v == null ? null : String(v));
const chainKey = (d) => `${str(d.groupId)}:${d.season}:${d.event}`;

/**
 * @param {import('mongodb').Db} db  native driver handle (mongoose.connection.db or a MongoClient db)
 * @returns {Promise<{ ok, checkedAt, dbName, counts: { error, info }, violations }>}
 */
export async function runDbCheck(db, { now = () => new Date() } = {}) {
  const violations = [];
  const add = (invariant, severity, collection, id, detail) => violations.push({ invariant, severity, collection, id: str(id), detail });
  const all = (name, projection) => db.collection(name).find({}, projection ? { projection } : {}).toArray();

  const [groups, managers, mgws, mseasons, snapshots, actions, pointers, runs] = await Promise.all([
    all('groups', { members: 1, myEntryId: 1 }),
    all('managers', { _id: 1 }),
    all('managerGameweeks'),
    all('managerSeasons', { _id: 1, season: 1, entryId: 1, provenance: 1 }),
    all('resultSnapshots'),
    all('gwResultActions'),
    all('gwResults'),
    all('syncRuns', { _id: 1, expireAt: 1, 'requests.bodySha256': 1 }),
  ]);
  const managerIds = new Set(managers.map((m) => m._id));
  const runsById = new Map(runs.map((r) => [str(r._id), r]));

  // I1 — no duplicate member entryId within a group.
  for (const g of groups) {
    const seen = new Set();
    for (const m of g.members ?? []) {
      if (seen.has(m.entryId)) add('I1', ERROR, 'groups', g._id, `duplicate member entryId ${m.entryId}`);
      seen.add(m.entryId);
    }
  }

  // I2 — every deterministic _id is valid (format + rebuilt from fields).
  const docsFor = { managerGameweeks: mgws, managerSeasons: mseasons, gwResults: pointers };
  for (const [name, build] of Object.entries(DETERMINISTIC_IDS)) {
    const docs = docsFor[name] ?? (await all(name, { _id: 1, season: 1, gw: 1, elementId: 1, entryId: 1, event: 1, groupId: 1 }));
    for (const d of docs) {
      let expected;
      try { expected = build(d); } catch (err) { add('I2', ERROR, name, d._id, `fields do not form a valid id: ${err.message}`); continue; }
      if (d._id !== expected) add('I2', ERROR, name, d._id, `expected _id ${JSON.stringify(expected)}`);
    }
  }
  for (const l of await all('locks', { _id: 1 })) {
    if (typeof l._id !== 'string' || !LOCK_ID.test(l._id)) add('I2', ERROR, 'locks', l._id, 'malformed lock id');
  }

  // I3 — no orphan manager references; myEntryId is a member.
  for (const g of groups) {
    const members = new Set((g.members ?? []).map((m) => m.entryId));
    for (const e of members) if (!managerIds.has(e)) add('I3', ERROR, 'groups', g._id, `member entryId ${e} has no managers document`);
    if (g.myEntryId != null) {
      if (!managerIds.has(g.myEntryId)) add('I3', ERROR, 'groups', g._id, `myEntryId ${g.myEntryId} has no managers document`);
      if (!members.has(g.myEntryId)) add('I3', ERROR, 'groups', g._id, `myEntryId ${g.myEntryId} is not a member`);
    }
  }
  for (const [name, docs] of [['managerGameweeks', mgws], ['managerSeasons', mseasons]]) {
    for (const d of docs) if (!managerIds.has(d.entryId)) add('I3', ERROR, name, d._id, `entryId ${d.entryId} has no managers document`);
  }

  // I4 — snapshot references; I5 — hash chains.
  const snapshotsById = new Map();
  for (const doc of snapshots) {
    const s = snapshotToDomain(doc);
    snapshotsById.set(s.id, s);
    const recomputed = snapshotContentHashOf(s);
    if (s.contentHash !== recomputed) add('I4', ERROR, 'resultSnapshots', s.id, 'stored contentHash does not recompute');
  }
  const chains = new Map();
  for (const doc of actions) {
    const a = actionToDomain(doc);
    for (const ref of ['prevSnapshotId', 'newSnapshotId']) {
      if (a[ref] != null && !snapshotsById.has(a[ref])) add('I4', ERROR, 'gwResultActions', a.id, `${ref} ${a[ref]} does not exist`);
    }
    const snap = snapshotsById.get(a.newSnapshotId);
    if (snap && a.newSnapshotHash !== snapshotContentHashOf(snap)) add('I4', ERROR, 'gwResultActions', a.id, 'newSnapshotHash does not match the snapshot');
    if (!chains.has(chainKey(a))) chains.set(chainKey(a), []);
    chains.get(chainKey(a)).push(a);
  }
  const pointersByKey = new Map();
  for (const doc of pointers) {
    const p = pointerToDomain(doc);
    pointersByKey.set(chainKey(p), p);
    const snap = snapshotsById.get(p.currentSnapshotId);
    if (!snap) add('I4', ERROR, 'gwResults', p.id, `currentSnapshotId ${p.currentSnapshotId} does not exist`);
    else if (snap.groupId !== p.groupId || snap.season !== p.season || snap.event !== p.event) {
      add('I4', ERROR, 'gwResults', p.id, 'current snapshot belongs to another group/season/event');
    }
    const last = (chains.get(chainKey(p)) ?? []).reduce((m, a) => (m && m.seq > a.seq ? m : a), null);
    if (last && last.newSnapshotId !== p.currentSnapshotId) add('I4', ERROR, 'gwResults', p.id, 'currentSnapshotId is not the last action\'s newSnapshotId');
  }
  for (const key of new Set([...chains.keys(), ...pointersByKey.keys()])) {
    const chainActions = (chains.get(key) ?? []).map((a) => omitKeys(a, ['id']));
    const pointer = pointersByKey.get(key) ?? null;
    const chainSnaps = new Map([...snapshotsById].map(([id, s]) => [id, omitKeys(s, ['id'])]));
    if (!pointer && chainActions.length) add('I5', ERROR, 'gwResults', key, 'actions exist without a gwResults pointer');
    const r = verifyChain(chainActions, { snapshotsById: chainSnaps, pointer });
    if (!r.valid) add('I5', ERROR, 'gwResultActions', key, `chain broken at seq ${r.brokenAtSeq}: ${r.reason}`);
  }

  // I6 — source run references.
  for (const s of snapshotsById.values()) {
    for (const src of s.sources) {
      const run = runsById.get(src.syncRunId);
      if (!run) { add('I6', ERROR, 'resultSnapshots', s.id, `source run ${src.syncRunId} does not exist`); continue; }
      const logged = new Set((run.requests ?? []).map((r) => r.bodySha256).filter(Boolean));
      for (const h of src.requestHashes) if (!logged.has(h)) add('I6', ERROR, 'resultSnapshots', s.id, `request hash ${h} is not in run ${src.syncRunId}`);
    }
  }
  for (const doc of actions) {
    if (doc.syncRunId != null && !runsById.has(str(doc.syncRunId))) add('I6', ERROR, 'gwResultActions', doc._id, `syncRunId ${doc.syncRunId} does not exist`);
  }
  for (const name of PROVENANCE_COLLECTIONS) {
    const docs = docsFor[name] ?? (await all(name, { _id: 1, 'provenance.lastConfirmedByRunId': 1 }));
    for (const d of docs) {
      const runId = str(d.provenance?.lastConfirmedByRunId);
      if (runId && !runsById.has(runId)) add('I6', INFO, name, d._id, `lastConfirmedByRunId ${runId} has expired (TTL)`);
    }
  }

  // I7 — every snapshot referenced by any action keeps its sources permanently.
  const referenced = new Set(actions.flatMap((a) => [str(a.prevSnapshotId), str(a.newSnapshotId)]).filter(Boolean));
  const evidence = new Map(); // runId -> Set(hash)
  for (const id of referenced) {
    const s = snapshotsById.get(id);
    if (!s) continue; // reported by I4
    for (const src of s.sources) {
      const run = runsById.get(src.syncRunId);
      if (!run) add('I7', ERROR, 'resultSnapshots', id, `source run ${src.syncRunId} is missing`);
      else if (run.expireAt) add('I7', ERROR, 'syncRuns', src.syncRunId, `source of snapshot ${id} still has expireAt`);
      if (!evidence.has(src.syncRunId)) evidence.set(src.syncRunId, new Set());
      for (const h of src.requestHashes) evidence.get(src.syncRunId).add(h);
    }
  }
  for (const [runId, hashes] of evidence) {
    const raws = await db.collection('fplRawResponses')
      .find({ bodySha256: { $in: [...hashes] }, expireAt: { $exists: true } }, { projection: { _id: 1, syncRunId: 1, bodySha256: 1 } }).toArray();
    for (const r of raws) if (str(r.syncRunId) === runId) add('I7', ERROR, 'fplRawResponses', r._id, `evidence for run ${runId} still has expireAt`);
  }

  // I8 — stored picks are valid.
  for (const d of mgws) {
    if (!d.hasPicks) continue;
    const v = pickViolations(d.picks ?? []);
    if (v.length) add('I8', ERROR, 'managerGameweeks', d._id, v.join('; '));
  }

  const error = violations.filter((v) => v.severity === ERROR).length;
  return { ok: error === 0, checkedAt: now().toISOString(), dbName: db.databaseName, counts: { error, info: violations.length - error }, violations };
}
