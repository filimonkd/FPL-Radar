import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTransfers } from '../../../src/analytics/transfers.js';

// Factual GW transfer summary (Step 10). Synthetic data.

const t = (elementIn, elementOut, event, time) => ({ elementIn, elementInCostTenths: 50, elementOut, elementOutCostTenths: 55, event, time: new Date(time) });

const input = () => ({
  event: 5,
  eligible: [3, 1, 2, 4],
  transfersByEntry: new Map([
    [1, [t(20, 7, 5, '2026-09-12T09:00:00Z'), t(9, 8, 4, '2026-09-05T09:00:00Z')]],
    [2, [t(21, 8, 5, '2026-09-12T08:00:00Z'), t(20, 6, 5, '2026-09-11T08:00:00Z')]],
    [3, []],
  ]),
  rows: new Map([[1, { eventTransfers: 1, transferCost: 0, activeChip: null }], [2, { eventTransfers: 2, transferCost: 4, activeChip: null }], [3, { eventTransfers: 0, transferCost: 0, activeChip: 'wildcard' }]]),
  players: new Map([[20, { id: 20, webName: 'P20' }]]),
});

test('lists each eligible manager\'s transfers in this GW only, in time order', () => {
  const s = summarizeTransfers(input());
  assert.deepEqual(s.members.map((m) => [m.entryId, m.transfers.map((x) => [x.elementIn, x.elementOut])]), [[1, [[20, 7]]], [2, [[20, 6], [21, 8]]], [3, []]]);
  assert.deepEqual(s.members.map((m) => [m.transferCost, m.activeChip]), [[0, null], [4, null], [0, 'wildcard']]);
});

test('counts players in and out across managers, ordered by count then element id', () => {
  const s = summarizeTransfers(input());
  assert.deepEqual(s.playersIn.map((p) => [p.elementId, p.count, p.entryIds]), [[20, 2, [1, 2]], [21, 1, [2]]]);
  assert.deepEqual(s.playersIn[0].player, { id: 20, webName: 'P20' });
  assert.deepEqual(s.playersIn[1].player, { id: 21 }, 'unknown players fall back to their id');
  assert.deepEqual(s.playersOut.map((p) => [p.elementId, p.count]), [[6, 1], [7, 1], [8, 1]]);
  assert.deepEqual(s.totals, { transfers: 3, managersWithTransfers: 2, managersWithHits: 1, hitCost: 4 });
});

test('a manager without a synced transfer list is reported missing, not counted as zero', () => {
  const s = summarizeTransfers(input());
  assert.deepEqual(s.missingEntryIds, [4]);
  assert.ok(!s.members.some((m) => m.entryId === 4));
});

test('identical inputs in any order give identical output', () => {
  const a = summarizeTransfers(input());
  const i = input();
  i.eligible.reverse();
  i.transfersByEntry = new Map([...i.transfersByEntry].reverse().map(([k, v]) => [k, [...v].reverse()]));
  assert.deepEqual(summarizeTransfers(i), a);
});
