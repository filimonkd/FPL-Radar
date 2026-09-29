import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlayers, pointsPerMillion } from '../../../src/analytics/finder.js';

const run = (avgFdr) => ({ gws: [6, 7, 8], fixtures: [], avgFdr, doubles: 0, blanks: 0 });
const P = (elementId, over = {}) => ({
  elementId, webName: `P${elementId}`, team: 'C1', position: 'MID', status: 'a', priceTenths: 50, totalPoints: 20,
  formTenths: 30, epNextTenths: 30, selectedByTenths: 50, fixtures: run(3), last: { 5: { points: 10, minutes: 450, gws: 5, of: 5 } }, ...over,
});
const players = [
  P(1, { priceTenths: 100, totalPoints: 60, selectedByTenths: 450, formTenths: 80, epNextTenths: 70, fixtures: run(2.3) }), // 6.0/£m, popular
  P(2, { priceTenths: 45, totalPoints: 36, selectedByTenths: 12, formTenths: 50, fixtures: run(3.7) }), // 8.0/£m, differential
  P(3, { position: 'DEF', priceTenths: 40, totalPoints: 30, selectedByTenths: 8, status: 'd', chanceNext: 50, fixtures: run(2.7) }), // 7.5/£m, doubtful
  P(4, { priceTenths: 55, totalPoints: null, selectedByTenths: null, formTenths: null, epNextTenths: null, fixtures: run(null) }), // no data
  P(5, { priceTenths: 50, totalPoints: 40, status: 'i', selectedByTenths: 30 }), // 8.0/£m, injured
];
const squads = [{ entryId: 10, elementIds: [1, 5] }, { entryId: 20, elementIds: [1, 2] }, { entryId: 30, elementIds: [1] }];

test('points per £m: season points over price, one decimal; null without data', () => {
  assert.equal(pointsPerMillion(36, 45), 8);
  assert.equal(pointsPerMillion(10, 55), 1.8);
  assert.equal(pointsPerMillion(null, 55), null);
  assert.equal(pointsPerMillion(10, 0), null);
});

test('sorts: value, form, expected points (descending), FDR (ascending); missing data last; ties by value then id', () => {
  const ids = (sort) => findPlayers({ players, squads, sort }).rows.map((r) => r.elementId);
  assert.deepEqual(ids('value'), [2, 5, 3, 1, 4], '8.0, 8.0 (id), 7.5, 6.0, none');
  assert.deepEqual(ids('form'), [1, 2, 5, 3, 4], 'P3 and P5 tie on form; P5 has the better value');
  assert.deepEqual(ids('xpts'), [1, 2, 5, 3, 4], 'ties at 3.0 broken by value');
  assert.deepEqual(ids('fdr'), [1, 3, 5, 2, 4]);
  assert.throws(() => findPlayers({ players, squads, sort: 'luck' }), RangeError);
});

test('filters: position, max price, max world ownership, max group owners, fit only; missing data never passes', () => {
  const ids = (filters) => findPlayers({ players, squads, filters }).rows.map((r) => r.elementId);
  assert.deepEqual(ids({ position: 'DEF' }), [3]);
  assert.deepEqual(ids({ maxPriceTenths: 50 }), [2, 5, 3]);
  assert.deepEqual(ids({ maxSelectedByTenths: 50 }), [2, 5, 3], 'P4 has no ownership figure');
  assert.deepEqual(ids({ maxGroupOwners: 0 }), [3, 4]);
  assert.deepEqual(ids({ maxGroupOwners: 1 }), [2, 5, 3, 4]);
  assert.deepEqual(ids({ fitOnly: true }), [2, 1, 4], 'doubtful and injured hidden');
  assert.deepEqual(ids({ fitOnly: true, maxGroupOwners: 1, maxSelectedByTenths: 100 }), [2]);
});

test('rows carry world and group ownership, mine, easy runs and the limit', () => {
  const out = findPlayers({ players, squads, myEntryId: 10, limit: 2 });
  assert.equal(out.total, 5);
  assert.equal(out.groupOf, 3);
  assert.equal(out.rows.length, 2);
  const [p2, p5] = out.rows;
  assert.deepEqual([p2.selectedByTenths, p2.groupOwners, p2.ownedByMe, p2.easyRun], [12, 1, false, false]);
  assert.deepEqual([p5.groupOwners, p5.ownedByMe], [1, true]);
  const p1 = findPlayers({ players, squads, sort: 'fdr' }).rows[0];
  assert.deepEqual([p1.groupOwners, p1.easyRun, p1.last5.points], [3, true, 10]);
  assert.equal(findPlayers({ players, squads, sort: 'fdr' }).rows.at(-1).easyRun, false, 'no FDR is not easy');
});
