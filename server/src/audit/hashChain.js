import { contentHash } from '../utils/canonical.js';

// Hash chain for the append-only decision log (architecture v0.3 §7, layer 5).
// Pure: callers pass plain objects; nothing is read from or written to a DB.

export const GENESIS = 'GENESIS';

const withoutKeys = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

// snapshot.contentHash = hash of the canonical snapshot (its own hash and _id excluded).
export const snapshotHash = (snapshot) => contentHash(withoutKeys(snapshot, ['_id', 'contentHash']));

// action.hash = sha256(canonical({ …actionFields, prevHash, newSnapshotHash })); _id and hash excluded.
export const actionHash = (action) => contentHash(withoutKeys(action, ['_id', 'hash']));

// Builds the next action in a chain, filling seq, prevHash and hash.
export function nextAction(head, fields) {
  const action = {
    ...fields,
    seq: (head?.headSeq ?? 0) + 1,
    prevHash: head?.headHash ?? GENESIS,
  };
  return { ...action, hash: actionHash(action) };
}

// Walks one (group, season, event) chain. `actions` may be unsorted.
// Returns { valid: true } or { valid: false, brokenAtSeq, reason }.
export function verifyChain(actions, { snapshotsById = new Map(), pointer = null } = {}) {
  const sorted = [...actions].sort((a, b) => a.seq - b.seq);
  let prevHash = GENESIS;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const fail = (reason) => ({ valid: false, brokenAtSeq: a.seq, reason });
    if (a.seq !== i + 1) return { valid: false, brokenAtSeq: i + 1, reason: `SEQ_GAP: expected seq ${i + 1}, found ${a.seq}` };
    if (a.prevHash !== prevHash) return fail('PREV_HASH_MISMATCH');
    if (actionHash(a) !== a.hash) return fail('ACTION_HASH_MISMATCH');
    const snap = snapshotsById.get(String(a.newSnapshotId));
    if (snapshotsById.size && !snap) return fail('SNAPSHOT_MISSING');
    if (snap) {
      const recomputed = snapshotHash(snap);
      if (snap.contentHash !== recomputed || a.newSnapshotHash !== recomputed) return fail('SNAPSHOT_HASH_MISMATCH');
    }
    prevHash = a.hash;
  }
  if (pointer) {
    const last = sorted.at(-1);
    const n = sorted.length;
    if (!last) return { valid: false, brokenAtSeq: 0, reason: 'POINTER_WITHOUT_ACTIONS' };
    if (pointer.headSeq !== n || pointer.headHash !== last.hash) return { valid: false, brokenAtSeq: n, reason: 'POINTER_HEAD_MISMATCH' };
    if (String(pointer.currentSnapshotId) !== String(last.newSnapshotId)) return { valid: false, brokenAtSeq: n, reason: 'POINTER_SNAPSHOT_MISMATCH' };
  }
  return { valid: true };
}
