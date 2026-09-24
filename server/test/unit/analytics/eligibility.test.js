import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEligible } from '../../../src/analytics/eligibility.js';
import { computeGwResult } from '../../../src/analytics/winner.js';
import { makeGwRow, makeMember, makeGroup } from '../../helpers/builders.js';

const rowsMap = (...ids) => new Map(ids.map((id) => [id, makeGwRow(id)]));

test('excluded: excluded top scorer is not the winner, not ranked, ineligibleReason EXCLUDED', () => {
  const res = computeGwResult({
    group: makeGroup(), event: 5, eventState: 'DATA_CHECKED',
    members: [makeMember(1, { isExcluded: true }), makeMember(2)],
    gwRows: [makeGwRow(1, { netGwPoints: 99 }), makeGwRow(2, { netGwPoints: 50 })],
  });
  assert.deepEqual(res.winners, [2]);
  const excluded = res.rows.find((r) => r.entryId === 1);
  assert.equal(excluded.ineligibleReason, 'EXCLUDED');
  assert.equal(excluded.competitionRank, null);
});

test('joined later: joinedEvent 6 → GW 5 JOINED_LATER; GW 6 eligible', () => {
  const m = [makeMember(1, { joinedEvent: 6 })];
  assert.deepEqual(selectEligible(m, rowsMap(1), 5).ineligible, [{ entryId: 1, reason: 'JOINED_LATER' }]);
  assert.deepEqual(selectEligible(m, rowsMap(1), 6).eligible, [1]);
});

test('no team: history OK but no GW row → NO_TEAM, result not blocked', () => {
  assert.deepEqual(selectEligible([makeMember(1), makeMember(2)], rowsMap(2), 5), {
    eligible: [2], ineligible: [{ entryId: 1, reason: 'NO_TEAM' }],
  });
  const res = computeGwResult({
    group: makeGroup(), event: 5, eventState: 'DATA_CHECKED',
    members: [makeMember(1), makeMember(2)], gwRows: [makeGwRow(2)],
  });
  assert.equal(res.status, 'PROVISIONAL');
  assert.deepEqual(res.winners, [2]);
});

test('precedence: excluded + joined later → EXCLUDED only', () => {
  const r = selectEligible([makeMember(1, { isExcluded: true, joinedEvent: 9 })], rowsMap(1), 5);
  assert.deepEqual(r.ineligible, [{ entryId: 1, reason: 'EXCLUDED' }]);
});

test('a member that failed to sync stays eligible (blocks instead of dropping out)', () => {
  assert.deepEqual(selectEligible([makeMember(1, { synced: false })], new Map(), 5).eligible, [1]);
});
