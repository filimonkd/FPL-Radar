import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOwnership } from '../../../src/analytics/ownership.js';

// Minimal EffectiveSquad-shaped objects: only the fields computeOwnership reads.
function squad(picks, { captain = null, capMult = 2, effCaptain = captain } = {}) {
  return {
    picks: picks.map(([elementId, squadPosition, pickedMultiplier, effectiveMultiplier = pickedMultiplier]) => ({ elementId, squadPosition, pickedMultiplier, effectiveMultiplier })),
    pickedCaptain: captain,
    capMult,
    effectiveCaptain: { elementId: effCaptain, via: effCaptain === null ? 'NONE' : 'CAPTAIN' },
  };
}
const X = 100;
const Y = 200;
const players = new Map([[X, { id: X, webName: 'X' }], [Y, { id: Y, webName: 'Y' }]]);
const rowOf = (res, id) => res.rows.find((r) => r.player.id === id);
const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);

test('denominators (Group B): 9 members, Me eligible → rivals 8, all 9', () => {
  const squads = new Map(ids(9).map((id) => [id, squad([[X, 1, 1]])]));
  const res = computeOwnership({ squads, eligible: ids(9), myEntryId: 1, players });
  assert.deepEqual(res.denominators, { rivals: 8, all: 9 });
  assert.deepEqual(res.missingEntryIds, []);
});

test('missing picks: 1 rival without picks → rivals 7, missingEntryIds [id]', () => {
  const squads = new Map(ids(8).map((id) => [id, squad([[X, 1, 1]])]));
  const res = computeOwnership({ squads, eligible: ids(9), myEntryId: 1, players });
  assert.deepEqual(res.denominators, { rivals: 7, all: 8 });
  assert.deepEqual(res.missingEntryIds, [9]);
});

test('excluded member (not in eligible) is not counted in any denominator', () => {
  const squads = new Map(ids(9).map((id) => [id, squad([[X, 1, 1]])]));
  const res = computeOwnership({ squads, eligible: ids(8), myEntryId: 1, players });
  assert.deepEqual(res.denominators, { rivals: 7, all: 8 });
});

test('zero denominator: only Me eligible → rivals pct null (not NaN)', () => {
  const res = computeOwnership({ squads: new Map([[1, squad([[X, 1, 1]])]]), eligible: [1], myEntryId: 1, players });
  const row = rowOf(res, X);
  assert.equal(res.denominators.rivals, 0);
  assert.equal(row.pickedSquad.rivals.pct, null);
  assert.equal(row.pickedEo.rivals, null);
  assert.equal(row.pickedExposure, null);
});

test('squad vs XI: player on 3 benches + 2 XIs → squad 5/8, XI 2/8', () => {
  const squads = new Map(ids(8).map((id) => [id, squad(id <= 2 ? [[X, 5, 1]] : id <= 5 ? [[X, 13, 0]] : [[Y, 5, 1]])]));
  const row = rowOf(computeOwnership({ squads, eligible: ids(8), myEntryId: null, players }), X);
  assert.deepEqual([row.pickedSquad.all.count, row.pickedSquad.all.of], [5, 8]);
  assert.deepEqual([row.pickedXi.all.count, row.pickedXi.all.of], [2, 8]);
  assert.equal(row.pickedSquad.all.pct, 62.5);
});

test('picked captaincy: 5 of 8 captain X, 1 with TC → pickedCaptain 5/8, pickedTriple 1/8', () => {
  const squads = new Map(ids(8).map((id) => [id, id <= 5
    ? squad([[X, 1, id === 1 ? 3 : 2]], { captain: X, capMult: id === 1 ? 3 : 2 })
    : squad([[X, 1, 1], [Y, 2, 2]], { captain: Y })]));
  const row = rowOf(computeOwnership({ squads, eligible: ids(8), myEntryId: null, players }), X);
  assert.equal(row.pickedCaptain.all.count, 5);
  assert.equal(row.pickedTriple.all.count, 1);
});

test('effective captaincy: X blanks, 3 of those 5 have VC Y → effectiveCaptain Y 3/8', () => {
  const squads = new Map(ids(8).map((id) => [id, id <= 3
    ? squad([[X, 1, 2, 1], [Y, 2, 1, 2]], { captain: X, effCaptain: Y })
    : id <= 5 ? squad([[X, 1, 2, 1]], { captain: X, effCaptain: null })
      : squad([[Y, 5, 1]])]));
  const res = computeOwnership({ squads, eligible: ids(8), myEntryId: null, players });
  assert.equal(rowOf(res, Y).effectiveCaptain.all.count, 3);
  assert.equal(rowOf(res, X).effectiveCaptain.all.count, 0);
});

test('EO: multipliers [2,2,1,1,0,0,3,1] over 8 → pickedEo 1.25', () => {
  const m = [2, 2, 1, 1, 0, 0, 3, 1];
  const squads = new Map(ids(8).map((id) => [id, squad([[X, m[id - 1] === 0 ? 13 : 1, m[id - 1]]])]));
  assert.equal(rowOf(computeOwnership({ squads, eligible: ids(8), myEntryId: null, players }), X).pickedEo.all, 1.25);
});

test('bench-boost EO: benched player under bboost counts 1 in effectiveEo, 0 in pickedXi', () => {
  const squads = new Map([[1, squad([[X, 13, 1, 1]])]]);
  const row = rowOf(computeOwnership({ squads, eligible: [1], myEntryId: null, players }), X);
  assert.equal(row.effectiveEo.all, 1);
  assert.equal(row.pickedXi.all.count, 0);
});

test('exposure: my mult 2, rivals EO 1.25 → exposure +0.75', () => {
  const m = [2, 2, 1, 1, 0, 0, 3, 1];
  const squads = new Map(ids(8).map((id) => [id, squad([[X, m[id - 1] === 0 ? 13 : 1, m[id - 1]]])]));
  squads.set(99, squad([[X, 1, 2]], { captain: X }));
  const row = rowOf(computeOwnership({ squads, eligible: [...ids(8), 99], myEntryId: 99, players }), X);
  assert.equal(row.myPickedMultiplier, 2);
  assert.equal(row.pickedEo.rivals, 1.25);
  assert.equal(row.pickedExposure, 0.75);
});
