import { test } from 'node:test';
import assert from 'node:assert/strict';
import { competitionRanks, resolvePositions } from '../../../src/analytics/ranking.js';
import { computeGwResult } from '../../../src/analytics/winner.js';
import { makeGwRow, makeMember, makeGroup, managersMap } from '../../helpers/builders.js';

const SCORES = [78, 78, 71, 71, 60];
const tieRows = () => SCORES.map((score, i) => ({ entryId: i + 1, score, grossGwPoints: score, transferCost: i % 2 ? 4 : 0, captainPoints: null, pointsOnBench: 0, activeChip: null, totalPoints: 300, overallRank: null }));

test('competition rank: scores 78,78,71,71,60 → 1,1,3,3,5', () => {
  const ranks = competitionRanks(SCORES.map((score, i) => ({ entryId: i + 1, score })));
  assert.deepEqual([...ranks.values()], [1, 1, 3, 3, 5]);
});

test('resolved position: unique 1–5, deterministic across 100 shuffled runs', () => {
  const rules = ['FEWER_TRANSFER_COST', 'SHARED'];
  const expected = resolvePositions(tieRows(), rules);
  assert.deepEqual(expected.map((p) => p.resolvedPosition), [1, 2, 3, 4, 5]);
  assert.deepEqual(expected.map((p) => [p.entryId, p.positionDecidedBy]), [[1, null], [2, 'FEWER_TRANSFER_COST'], [3, null], [4, 'FEWER_TRANSFER_COST'], [5, null]]);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 100; i++) {
    const shuffled = tieRows().map((r) => [rand(), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    assert.deepEqual(resolvePositions(shuffled, rules), expected);
  }
});

test('rules with missing data are skipped when ordering', () => {
  const r = resolvePositions(tieRows().slice(0, 2), ['HIGHER_CAPTAIN_POINTS', 'SHARED']);
  assert.deepEqual(r.map((p) => p.positionDecidedBy), [null, 'ENTRY_ID_FALLBACK']);
});

test('ineligible rows: rank and position null, sorted last by name', () => {
  const r = computeGwResult({
    group: makeGroup(), event: 5, eventState: 'DATA_CHECKED',
    members: [makeMember(9, { isExcluded: true }), makeMember(1), makeMember(8, { joinedEvent: 20 })],
    gwRows: [makeGwRow(1), makeGwRow(9), makeGwRow(8)], managers: managersMap([1, 8, 9]),
  });
  assert.deepEqual(r.rows.map((x) => x.entryId), [1, 8, 9]);
  for (const row of r.rows.slice(1)) {
    assert.equal(row.competitionRank, null);
    assert.equal(row.resolvedPosition, null);
  }
});
