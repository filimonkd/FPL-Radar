import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS, nextAction, snapshotHash, verifyChain } from '../../src/audit/hashChain.js';

const snapshot = (id, winners) => {
  const s = { _id: id, groupId: 'g', season: '2026-27', event: 5, declaredWinnerEntryIds: winners, computedAt: new Date('2026-09-22T20:00:00Z') };
  return { ...s, contentHash: snapshotHash(s) };
};

function buildChain() {
  const s1 = snapshot('s1', [1]);
  const s2 = snapshot('s2', [2]);
  const a1 = nextAction(null, { action: 'FINALIZE', newSnapshotId: 's1', newSnapshotHash: s1.contentHash, newWinnerEntryIds: [1], createdAt: new Date('2026-09-22T20:00:00Z') });
  const a2 = nextAction({ headSeq: 1, headHash: a1.hash }, { action: 'OVERRIDE', note: 'late sub', newSnapshotId: 's2', newSnapshotHash: s2.contentHash, newWinnerEntryIds: [2], createdAt: new Date('2026-09-22T21:00:00Z') });
  return {
    actions: [a1, a2],
    snapshotsById: new Map([['s1', s1], ['s2', s2]]),
    pointer: { headSeq: 2, headHash: a2.hash, currentSnapshotId: 's2' },
  };
}

test('a well-formed chain verifies; seq 1 links to GENESIS', () => {
  const c = buildChain();
  assert.equal(c.actions[0].prevHash, GENESIS);
  assert.equal(c.actions[1].prevHash, c.actions[0].hash);
  assert.deepEqual(verifyChain(c.actions, c), { valid: true });
  assert.deepEqual(verifyChain([...c.actions].reverse(), c), { valid: true }, 'order of input does not matter');
});

test('tampered action field is detected', () => {
  const c = buildChain();
  c.actions[0] = { ...c.actions[0], newWinnerEntryIds: [9] };
  assert.deepEqual(verifyChain(c.actions, c), { valid: false, brokenAtSeq: 1, reason: 'ACTION_HASH_MISMATCH' });
});

test('tampered snapshot is detected', () => {
  const c = buildChain();
  c.snapshotsById.set('s1', { ...c.snapshotsById.get('s1'), declaredWinnerEntryIds: [9] });
  assert.equal(verifyChain(c.actions, c).reason, 'SNAPSHOT_HASH_MISMATCH');
});

test('deleted action (seq gap) and forged link are detected', () => {
  const c = buildChain();
  assert.equal(verifyChain([c.actions[1]], c).reason, 'SEQ_GAP: expected seq 1, found 2');
  const forged = { ...c.actions[1], prevHash: 'sha256:' + '0'.repeat(64) };
  assert.equal(verifyChain([c.actions[0], forged], c).reason, 'PREV_HASH_MISMATCH');
});

test('pointer must equal the chain head', () => {
  const c = buildChain();
  assert.equal(verifyChain(c.actions, { ...c, pointer: { ...c.pointer, headSeq: 1 } }).reason, 'POINTER_HEAD_MISMATCH');
  assert.equal(verifyChain(c.actions, { ...c, pointer: { ...c.pointer, currentSnapshotId: 's1' } }).reason, 'POINTER_SNAPSHOT_MISMATCH');
});

test('snapshot hash ignores its own _id and contentHash', () => {
  const s = snapshot('s1', [1]);
  assert.equal(snapshotHash({ ...s, _id: 'other', contentHash: 'x' }), s.contentHash);
});
