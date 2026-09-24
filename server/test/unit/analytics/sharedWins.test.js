import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGwResult } from '../../../src/analytics/winner.js';
import { makeGwRow, makeMember, makeGroup } from '../../helpers/builders.js';

const run = (ids, tieBreakRules) => computeGwResult({
  group: makeGroup({ tieBreakRules }), event: 5, eventState: 'DATA_CHECKED',
  members: ids.map((id) => makeMember(id)), gwRows: ids.map((id) => makeGwRow(id)),
});

test('full tie: 3 equal on all rules → 3 winners, positions 1–3 by entryId, ENTRY_ID_FALLBACK', () => {
  const r = run([30, 10, 20], ['FEWER_TRANSFER_COST', 'HIGHER_SEASON_TOTAL', 'SHARED']);
  assert.deepEqual(r.winners, [10, 20, 30]);
  assert.equal(r.tieBreakApplied, 'SHARED');
  assert.deepEqual(r.rows.map((x) => [x.entryId, x.resolvedPosition, x.positionDecidedBy]), [
    [10, 1, null], [20, 2, 'ENTRY_ID_FALLBACK'], [30, 3, 'ENTRY_ID_FALLBACK'],
  ]);
  assert.deepEqual(r.rows.map((x) => x.competitionRank), [1, 1, 1]);
  assert.deepEqual(r.rows[0].tiedWith, [20, 30]);
});

test("rules empty: tieBreakRules = ['SHARED'] with 2 tied → shared", () => {
  const r = run([1, 2], ['SHARED']);
  assert.deepEqual(r.winners, [1, 2]);
  assert.equal(r.tieBreakApplied, 'SHARED');
});

test('entryId never decides: shared winners unaffected by entryId order', () => {
  const a = run([1, 2, 3], ['SHARED']);
  const b = run([3, 2, 1], ['SHARED']);
  assert.deepEqual(a.winners, b.winners);
  assert.deepEqual(a.winners, [1, 2, 3]);
});
