import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsOver, rotationRisk, fixtureRun, sellingPrice, purchasePrice, startPrice } from '../../../src/analytics/playerStats.js';

// Step 17: shared player statistics, on hand-built data.

const H = [
  { gw: 1, points: 2, minutes: 90 }, { gw: 2, points: 8, minutes: 90 }, { gw: 3, points: 1, minutes: 20 },
  { gw: 4, points: 12, minutes: 90 }, { gw: 6, points: 0, minutes: 0 }, { gw: 7, points: 3, minutes: 45 },
];

test('points over the last 3 / 5 / 10 GWs, with coverage reported', () => {
  assert.deepEqual(pointsOver(H, 7, 3), { points: 3, minutes: 45, gws: 2, of: 3 }, 'GW5 not stored → 2 of 3 known');
  assert.deepEqual(pointsOver(H, 7, 5), { points: 16, minutes: 155, gws: 4, of: 5 });
  assert.deepEqual(pointsOver(H, 7, 10), { points: 26, minutes: 335, gws: 6, of: 7 }, 'the window never reaches before GW1');
  assert.deepEqual(pointsOver(H, 4, 3), { points: 21, minutes: 200, gws: 3, of: 3 });
  assert.deepEqual(pointsOver([], 7, 3), { points: null, minutes: null, gws: 0, of: 3 }, 'no data → null, not 0');
});

test('rotation: under 60 minutes in 2 of the last 3 games; blanks skipped; unknown when too few games', () => {
  assert.deepEqual(rotationRisk(H, 7), { risk: true, short: 2, games: 3 }, 'GW7 45, GW6 0, GW4 90');
  assert.deepEqual(rotationRisk(H, 4), { risk: false, short: 1, games: 3 });
  const blankGw6 = (gw) => (gw === 6 ? 0 : 1);
  assert.deepEqual(rotationRisk(H, 7, blankGw6), { risk: true, short: 2, games: 3 }, 'GW6 skipped as a blank; GW3 (20 min) enters the window');
  assert.deepEqual(rotationRisk(H.slice(0, 2), 2), { risk: null, short: 0, games: 2 });
});

test('fixture run: next N GWs with difficulty, doubles and blanks', () => {
  const fixtures = [
    { event: 8, teamH: 1, teamA: 2, teamHFdr: 2, teamAFdr: 4 },
    { event: 9, teamH: 3, teamA: 1, teamHFdr: 3, teamAFdr: 5 },
    { event: 9, teamH: 1, teamA: 4, teamHFdr: 2, teamAFdr: 3 },
    { event: 11, teamH: 1, teamA: 5, teamHFdr: 1, teamAFdr: 5 },
  ];
  const r = fixtureRun(1, fixtures, 7);
  assert.deepEqual(r.gws, [8, 9, 10]);
  assert.deepEqual(r.fixtures.map((f) => [f.gw, f.opponent, f.home, f.fdr]), [[8, 2, true, 2], [9, 3, false, 5], [9, 4, true, 2]]);
  assert.deepEqual([r.avgFdr, r.doubles, r.blanks], [3, 1, 1]);
  assert.deepEqual(fixtureRun(1, fixtures, 37).gws, [38], 'never past GW38');
  assert.equal(fixtureRun(9, fixtures, 7).avgFdr, null);
});

test('selling price keeps half a rise (rounded down) and passes a fall on in full', () => {
  assert.equal(sellingPrice(100, 103), 101);
  assert.equal(sellingPrice(100, 104), 102);
  assert.equal(sellingPrice(100, 101), 100);
  assert.equal(sellingPrice(100, 97), 97);
  assert.equal(sellingPrice(null, 97), null);
});

test('purchase price: latest transfer in, else the season start price', () => {
  const transfers = [
    { elementIn: 7, elementInCostTenths: 60, elementOut: 1, event: 3, time: '2026-08-30T10:00:00Z' },
    { elementIn: 9, elementInCostTenths: 45, elementOut: 7, event: 5, time: '2026-09-12T10:00:00Z' },
    { elementIn: 7, elementInCostTenths: 63, elementOut: 9, event: 6, time: '2026-09-19T10:00:00Z' },
  ];
  assert.equal(purchasePrice(7, transfers, 58), 63, 'bought back later at 6.3');
  assert.equal(purchasePrice(11, transfers, 58), 58);
  assert.equal(purchasePrice(11, [], null), null);
  assert.equal(startPrice(65, 2), 63);
  assert.equal(startPrice(65, null), null);
});
