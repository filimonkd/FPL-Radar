import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGwResult } from '../../../src/analytics/winner.js';
import { TIE_BREAKERS, isValidRuleChain, TIE_BREAK_RULES } from '../../../src/analytics/tieBreakers.js';
import { makeGwRow, makeMember, makeGroup } from '../../helpers/builders.js';

const result = (rows, tieBreakRules, squads) => computeGwResult({
  group: makeGroup({ tieBreakRules }), event: 5, eventState: 'DATA_CHECKED',
  members: rows.map((r) => makeMember(r.entryId)), gwRows: rows, effectiveSquads: squads,
});
const tr = (entryId, over) => ({ entryId, score: 70, grossGwPoints: 70, transferCost: 0, captainPoints: 10, pointsOnBench: 5, activeChip: null, totalPoints: 300, overallRank: 1000, ...over });

test('fewer transfer cost: 2 × net 70, costs 4 vs 0 → cost-0 wins', () => {
  const r = result([makeGwRow(1, { netGwPoints: 70, transferCost: 4 }), makeGwRow(2, { netGwPoints: 70 })], ['FEWER_TRANSFER_COST', 'SHARED']);
  assert.deepEqual(r.winners, [2]);
  assert.equal(r.tieBreakApplied, 'FEWER_TRANSFER_COST');
  assert.deepEqual(r.tieBreakTrace, [{ rule: 'FEWER_TRANSFER_COST', remaining: [2] }]);
});

test('chain falls through: equal cost, season totals 400 vs 410 → 410 wins via HIGHER_SEASON_TOTAL', () => {
  const r = result([makeGwRow(1, { totalPoints: 400 }), makeGwRow(2, { totalPoints: 410 })], ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED']);
  assert.deepEqual(r.winners, [2]);
  assert.equal(r.tieBreakApplied, 'HIGHER_SEASON_TOTAL');
  assert.deepEqual(r.tieBreakTrace.map((t) => t.rule), ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL']);
});

test('each rule separates on its own field in its stated direction', () => {
  const cases = {
    FEWER_TRANSFER_COST: [{ transferCost: 4 }, { transferCost: 0 }],
    HIGHER_GROSS_POINTS: [{ grossGwPoints: 70 }, { grossGwPoints: 74 }],
    HIGHER_CAPTAIN_POINTS: [{ captainPoints: 4 }, { captainPoints: 16 }],
    FEWER_POINTS_ON_BENCH: [{ pointsOnBench: 12 }, { pointsOnBench: 3 }],
    NO_CHIP_PLAYED: [{ activeChip: 'bboost' }, { activeChip: null }],
    HIGHER_SEASON_TOTAL: [{ totalPoints: 400 }, { totalPoints: 410 }],
    BETTER_OVERALL_RANK: [{ overallRank: 5000 }, { overallRank: 12 }],
  };
  assert.deepEqual(Object.keys(cases).sort(), TIE_BREAK_RULES.filter((r) => r !== 'SHARED').sort());
  for (const [rule, [lose, win]] of Object.entries(cases)) {
    assert.deepEqual(TIE_BREAKERS[rule]([tr(1, lose), tr(2, win)]).map((c) => c.entryId), [2], rule);
  }
});

test('NO_CHIP_PLAYED with nobody qualifying (or everybody) → no-op', () => {
  const both = [tr(1, { activeChip: 'bboost' }), tr(2, { activeChip: '3xc' })];
  assert.equal(TIE_BREAKERS.NO_CHIP_PLAYED(both).length, 2);
  assert.equal(TIE_BREAKERS.NO_CHIP_PLAYED([tr(1), tr(2)]).length, 2);
});

test('missing data: HIGHER_CAPTAIN_POINTS with null captain points → unchanged, TIE_BREAK_DATA_MISSING', () => {
  const rows = [makeGwRow(1), makeGwRow(2)];
  const squads = new Map([[1, { captainPoints: 12 }]]); // entry 2 has no squad → null
  const r = result(rows, ['HIGHER_CAPTAIN_POINTS', 'SHARED'], squads);
  assert.deepEqual(r.tieBreakTrace[0], { rule: 'HIGHER_CAPTAIN_POINTS', remaining: [1, 2], note: 'TIE_BREAK_DATA_MISSING' });
  assert.deepEqual(r.winners, [1, 2]);
  assert.ok(r.warnings.some((w) => w.code === 'TIE_BREAK_DATA_MISSING'));
});

test('order matters: same data, chain reversed → different winner', () => {
  const rows = [makeGwRow(1, { netGwPoints: 70, transferCost: 0, totalPoints: 400 }), makeGwRow(2, { netGwPoints: 70, transferCost: 4, totalPoints: 500 })];
  assert.deepEqual(result(rows, ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED']).winners, [1]);
  assert.deepEqual(result(rows, ['HIGHER_SEASON_TOTAL', 'FEWER_TRANSFER_COST', 'SHARED']).winners, [2]);
});

test('rule chains must end with SHARED and contain known rules once', () => {
  assert.equal(isValidRuleChain(['FEWER_TRANSFER_COST', 'SHARED']), true);
  assert.equal(isValidRuleChain(['SHARED']), true);
  assert.equal(isValidRuleChain(['FEWER_TRANSFER_COST']), false);
  assert.equal(isValidRuleChain(['SHARED', 'FEWER_TRANSFER_COST']), false);
  assert.equal(isValidRuleChain(['MADE_UP', 'SHARED']), false);
  assert.equal(isValidRuleChain(['FEWER_TRANSFER_COST', 'FEWER_TRANSFER_COST', 'SHARED']), false);
});
