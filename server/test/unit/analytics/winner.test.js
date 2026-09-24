import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGwResult } from '../../../src/analytics/winner.js';
import { ENGINE_VERSION } from '../../../src/analytics/version.js';
import { makeGwRow, makeMember, makeGroup, managersMap } from '../../helpers/builders.js';

// A: R 70 C 8 (net 62, gross 70); B: R 65 C 0 (net 65, gross 65)
const rowsAB = () => [makeGwRow(1, { netGwPoints: 62, transferCost: 8 }), makeGwRow(2, { netGwPoints: 65 })];
const run = (over = {}) => computeGwResult({
  group: makeGroup(), event: 5, eventState: 'DATA_CHECKED',
  members: [makeMember(1), makeMember(2)], gwRows: rowsAB(), managers: managersMap([1, 2]), ...over,
});

test('net rule: winner B (65 > 62)', () => {
  const r = run();
  assert.equal(r.status, 'PROVISIONAL');
  assert.deepEqual(r.winners, [2]);
  assert.equal(r.winningScore, 65);
  assert.equal(r.tieBreakApplied, null);
});

test('gross rule: same data → winner A (70 > 65)', () => {
  const r = run({ group: makeGroup({ winnerRule: 'GROSS_POINTS' }) });
  assert.deepEqual(r.winners, [1]);
  assert.equal(r.winningScore, 70);
});

test('blocked: one eligible manager MISMATCH → BLOCKED, winners [], blockedBy lists them', () => {
  const rows = rowsAB();
  rows[0] = { ...rows[0], reconciliationStatus: 'MISMATCH', netGwPoints: null, grossGwPoints: null };
  const r = run({ gwRows: rows });
  assert.equal(r.status, 'BLOCKED');
  assert.deepEqual(r.winners, []);
  assert.deepEqual(r.blockedBy, [{ entryId: 1, reconciliationStatus: 'MISMATCH' }]);
  const a = r.rows.find((x) => x.entryId === 1);
  assert.equal(a.reportedGwPoints, 70); // rows still returned with reported points
  assert.equal(a.competitionRank, null);
});

test('not synced: eligible member without a row this run → BLOCKED', () => {
  const r = run({ members: [makeMember(1), makeMember(2), makeMember(3, { synced: false })] });
  assert.equal(r.status, 'BLOCKED');
  assert.deepEqual(r.blockedBy, [{ entryId: 3, reconciliationStatus: 'NOT_SYNCED' }]);
  assert.equal(r.rows.find((x) => x.entryId === 3).reconciliationStatus, 'NOT_SYNCED');
});

test('result carries inputs, a stable inputsHash and the engine version', () => {
  const a = run();
  const b = run({ members: [makeMember(2), makeMember(1)], gwRows: [...rowsAB()].reverse() });
  assert.equal(a.engineVersion, ENGINE_VERSION);
  assert.match(a.inputsHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(a.inputsHash, b.inputsHash, 'input order must not change the hash');
  assert.notEqual(a.inputsHash, run({ gwRows: [makeGwRow(1, { netGwPoints: 61, transferCost: 8 }), makeGwRow(2, { netGwPoints: 65 })] }).inputsHash);
});

test('before DATA_CHECKED the result is marked provisional', () => {
  assert.deepEqual(run({ eventState: 'LIVE' }).warnings, [{ code: 'PROVISIONAL_EVENT_STATE', eventState: 'LIVE' }]);
});

test('rows: table order follows resolvedPosition; me flagged; ineligible rows last', () => {
  const r = computeGwResult({
    group: makeGroup({ myEntryId: 2 }), event: 5, eventState: 'DATA_CHECKED',
    members: [makeMember(1), makeMember(2), makeMember(3, { isExcluded: true })],
    gwRows: [...rowsAB(), makeGwRow(3, { netGwPoints: 99 })], managers: managersMap([1, 2, 3]),
  });
  assert.deepEqual(r.rows.map((x) => x.entryId), [2, 1, 3]);
  assert.equal(r.rows[0].isMe, true);
  assert.equal(r.rows[0].isWinner, true);
  assert.equal(r.rows[2].ineligibleReason, 'EXCLUDED');
});
