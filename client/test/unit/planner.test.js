import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBlocker, bestXi, evaluate, newDraft, loadDrafts, saveDrafts } from '../../src/lib/planner.js';

// Step 21: Wildcard / Free Hit planner rules. Synthetic players only.

const POS = ['GKP', 'DEF', 'MID', 'FWD'];
// 20 players: ids 1–20; position cycles GKP, DEF, MID, FWD; team = ceil(id / 3) (3 per club); £5.0m each.
const players = Array.from({ length: 20 }, (_, i) => ({
  elementId: i + 1, webName: `P${i + 1}`, position: POS[i % 4], teamId: Math.ceil((i + 1) / 3), team: `T${Math.ceil((i + 1) / 3)}`,
  priceTenths: 50, epNextTenths: (i % 7) * 10,
  fixtures: { fixtures: i % 5 === 0 ? [] : i % 5 === 1 ? [{ gw: 6, fdr: 2 }, { gw: 6, fdr: 3 }] : [{ gw: 6, fdr: 4 }] },
}));
// More players to build a full 2/5/5/3 squad with at most 3 per club.
const extra = (id, position, teamId, ep = 20) => ({ elementId: id, webName: `X${id}`, position, teamId, team: `T${teamId}`, priceTenths: 60, epNextTenths: ep, fixtures: { fixtures: [{ gw: 6, fdr: 3 }] } });
const pool = [
  extra(101, 'GKP', 11, 30), extra(102, 'GKP', 12, 10),
  ...[103, 104, 105, 106, 107].map((id, i) => extra(id, 'DEF', 13 + i, 20 + i * 5)),
  ...[108, 109, 110, 111, 112].map((id, i) => extra(id, 'MID', 13 + i, 40 + i * 5)),
  ...[113, 114, 115].map((id, i) => extra(id, 'FWD', 18 + i, 50 + i * 5)),
];
const byId = new Map([...players, ...pool].map((p) => [p.elementId, p]));
const full = pool.map((p) => p.elementId);

test('adding: position slots, 3 per club and duplicates are enforced; budget is not', () => {
  const d = newDraft({ id: 'a', name: 'WC', squad: [1, 5], budgetTenths: 60 }); // two GKPs (teams 1, 2)
  assert.equal(addBlocker(d, byId, byId.get(9)), 'GKP is full (2)');
  assert.equal(addBlocker(d, byId, byId.get(1)), 'already in your squad');
  const club = newDraft({ id: 'b', name: 'x', squad: [1, 2, 3] }); // all team 1
  assert.equal(addBlocker(club, byId, byId.get(4) /* team 2 */), null);
  assert.equal(addBlocker(club, byId, { ...byId.get(4), teamId: 1, team: 'T1' }), 'already 3 from T1');
  assert.equal(addBlocker(newDraft({ id: 'c', name: 'x', budgetTenths: 10 }), byId, byId.get(2)), null, 'over budget is allowed, and shown');
});

test('best XI: one keeper, formation minimums, then the best of the rest by expected points', () => {
  const xi = bestXi(full.map((id) => byId.get(id)));
  assert.equal(xi.length, 11);
  const pos = (p) => xi.filter((id) => byId.get(id).position === p).length;
  assert.deepEqual([pos('GKP'), pos('DEF'), pos('MID'), pos('FWD')], [1, 3, 4, 3], 'weakest DEF and MID benched');
  assert.ok(xi.includes(101) && !xi.includes(102), 'better keeper starts');
  assert.ok(!xi.includes(103) && !xi.includes(104) && !xi.includes(108));
});

test('evaluate: a valid full squad with totals, captain doubled, FDR and DGW/BGW counts', () => {
  const d = newDraft({ id: 'w', name: 'WC', squad: full, xi: bestXi(full.map((id) => byId.get(id))), budgetTenths: 1000 });
  const e = evaluate(d, byId, 6);
  assert.deepEqual([e.size, e.cost, e.bankTenths, e.xiSize, e.valid, e.problems, e.missing], [15, 900, 100, 11, true, [], []]);
  assert.equal(e.captainId, 112, 'highest expected points (6.0, tied with 115: lower id)');
  // XI eps (tenths): GKP 30 + DEF 30,35,40 + MID 45,50,55,60 + FWD 50,55,60 = 510; + captain 60 = 570.
  assert.equal(e.xPts, 57);
  assert.deepEqual([e.avgFdr, e.doubles, e.blanks], [3, 0, 0]);
});

test('evaluate: missing slots, too many, clubs, budget and XI shape are reported', () => {
  const partial = evaluate(newDraft({ id: 'p', name: 'x', squad: [1, 2, 3] }), byId, 6);
  assert.deepEqual(partial.missing, ['1 GKP', '4 DEF', '4 MID', '3 FWD']);
  assert.equal(partial.valid, false);
  assert.equal(partial.xPts, null, 'no XI yet');

  const clubs = evaluate(newDraft({ id: 'c', name: 'x', squad: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], xi: [] }), byId, 6);
  assert.ok(clubs.problems.includes('Too many GKP: 4/2'));
  assert.ok(clubs.problems.includes('Starting XI has 0 players (needs 11)'));
  assert.ok(clubs.problems.includes('Starting XI needs at least 1 GKP'));

  const rich = newDraft({ id: 'r', name: 'x', squad: full, xi: full.slice(0, 11), budgetTenths: 800 });
  const e = evaluate(rich, byId, 6);
  assert.ok(e.problems.includes('Over budget by £10.0m'));
  assert.ok(e.problems.includes('Starting XI allows at most 1 GKP'));
  assert.ok(e.problems.includes('Starting XI needs at least 1 FWD'));

  const four = evaluate(newDraft({ id: 'f', name: 'x', squad: [1, 2, 3, 4, 101] }), byId, 6); // 3 of team 1 + id 4 (team 2)
  assert.ok(!four.problems.some((p) => p.includes('players from')));
});

test('DGW/BGW counts are for the next GW, over the starting XI', () => {
  const e = evaluate(newDraft({ id: 'g', name: 'x', squad: [1, 2, 6, 11], xi: [1, 2, 6, 11] }), byId, 6);
  // id 1 (i 0): blank; id 2 (i 1): double; id 6 (i 5): blank; id 11 (i 10): blank.
  assert.deepEqual([e.doubles, e.blanks], [1, 3]);
});

test('drafts round-trip through storage; bad or missing storage is survivable', () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  try {
    assert.deepEqual(loadDrafts('g', '2026-27'), { drafts: [], activeId: null });
    const d = newDraft({ id: 'd1', name: 'Wildcard', squad: [1], xi: [], budgetTenths: 1000 });
    assert.equal(saveDrafts('g', '2026-27', { drafts: [d], activeId: 'd1' }), true);
    assert.deepEqual(loadDrafts('g', '2026-27'), { drafts: [d], activeId: 'd1' });
    assert.deepEqual(loadDrafts('g', '2025-26'), { drafts: [], activeId: null }, 'per season');
    mem.set('fpl-radar:planner:g:2026-27', '{not json');
    assert.deepEqual(loadDrafts('g', '2026-27'), { drafts: [], activeId: null });
    mem.set('fpl-radar:planner:g:2026-27', JSON.stringify({ drafts: [{ id: 'x' }, d], activeId: 'gone' }));
    assert.deepEqual(loadDrafts('g', '2026-27'), { drafts: [d], activeId: 'd1' }, 'malformed drafts dropped');
    globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.deepEqual(loadDrafts('g', '2026-27'), { drafts: [], activeId: null });
    assert.equal(saveDrafts('g', '2026-27', { drafts: [], activeId: null }), false);
  } finally {
    delete globalThis.localStorage;
  }
});
