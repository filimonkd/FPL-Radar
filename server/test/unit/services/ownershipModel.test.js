import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownershipInputs, buildOwnershipView, toPlayerRef } from '../../../src/services/ownershipModel.js';

// Ownership view (Step 10): the engine's effective squads and ownership, fed
// exact inputs, with deterministic ordering. Synthetic data, hand-counted.

const pick = (elementId, squadPosition, { c = false, v = false, mult } = {}) => ({
  elementId, squadPosition, isCaptain: c, isViceCaptain: v, fplMultiplier: mult ?? (c ? 2 : squadPosition <= 11 ? 1 : 0),
});
// Squad of elements 1..15, captain / vice configurable, element at a position replaceable.
function squad({ captain = 1, vice = 2, replace = {} } = {}) {
  return Array.from({ length: 15 }, (_, i) => {
    const el = replace[i + 1] ?? i + 1;
    return pick(el, i + 1, { c: el === captain, v: el === vice });
  });
}
const member = (entryId, over = {}) => ({ entryId, isExcluded: false, joinedEvent: null, synced: true, ...over });
const gwRow = (entryId) => ({ entryId, event: 5, reconciliationStatus: 'RECONCILED_NO_COST' });
const player = (elementId) => ({ id: `2026-27:${elementId}`, season: '2026-27', elementId, webName: `P${elementId}`, teamId: 1, elementType: 3, priceTenths: 50, status: 'a' });

/**
 * Me = 1 (no chip), 2 = triple captain on element 1, 3 = captain 5 who plays
 * 0 minutes → FPL auto-sub 5 → 12 and vice 6 takes the armband; 4 = no picks;
 * 5 = excluded.
 */
function loaded({ minutes5 = 0, settled = true, eventState = 'DATA_CHECKED' } = {}) {
  const live = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, { minutes: i + 1 === 5 ? minutes5 : 90, totalPoints: i + 1 === 5 ? 0 : 2, fixturesSettled: settled }]));
  return {
    myEntryId: 1,
    eventState,
    members: [member(1), member(2), member(3), member(4), member(5, { isExcluded: true })],
    gwRows: [1, 2, 3, 4, 5].map(gwRow),
    squads: [
      { entryId: 3, picks: squad({ captain: 5, vice: 6 }), activeChip: null, autoSubs: [{ elementIn: 12, elementOut: 5, source: 'FPL' }], grossGwPoints: null },
      { entryId: 1, picks: squad(), activeChip: null, autoSubs: [], grossGwPoints: null },
      { entryId: 2, picks: squad(), activeChip: '3xc', autoSubs: [], grossGwPoints: null },
      { entryId: 5, picks: squad(), activeChip: null, autoSubs: [], grossGwPoints: null },
    ],
    live,
    players: new Map(Array.from({ length: 30 }, (_, i) => [i + 1, player(i + 1)])),
  };
}

const view = (l = loaded(), opts) => buildOwnershipView(ownershipInputs(l, 5), opts);
const rowFor = (v, elementId) => v.rows.find((r) => r.player.id === elementId);

test('denominators: excluded out, no-picks member reported missing, Me excluded from rivals', () => {
  const v = view();
  assert.deepEqual(v.eligible, [1, 2, 3, 4]);
  assert.deepEqual(v.ineligible, [{ entryId: 5, reason: 'EXCLUDED' }]);
  assert.deepEqual(v.denominators, { rivals: 2, all: 3 });
  assert.deepEqual(v.missingEntryIds, [4]);
});

test('captain, triple captain and vice-captain after captain failure (hand count)', () => {
  const v = view();
  const [c1, c2, c3] = v.captaincy;
  assert.deepEqual([c1.entryId, c1.effectiveCaptain, c1.capMult], [1, { elementId: 1, via: 'CAPTAIN' }, 2]);
  assert.deepEqual([c2.entryId, c2.tripleCaptain, c2.effectiveCaptain], [2, true, { elementId: 1, via: 'CAPTAIN' }]);
  assert.deepEqual([c3.entryId, c3.pickedCaptain, c3.pickedVice, c3.effectiveCaptain], [3, 5, 6, { elementId: 6, via: 'VICE' }]);
  assert.deepEqual(c3.autoSubbed, [{ elementId: 5, autoSubbed: 'OUT' }, { elementId: 12, autoSubbed: 'IN' }]);
  assert.equal(c3.autoSubSource, 'FPL');
});

test('picked vs effective ownership and EO (hand count over 3 managers)', () => {
  const v = view();
  const e1 = rowFor(v, 1);
  assert.deepEqual([e1.pickedCaptain.all.count, e1.pickedTriple.all.count, e1.effectiveCaptain.all.count], [2, 1, 2]);
  assert.equal(e1.pickedEo.all, (2 + 3 + 1) / 3);
  assert.equal(e1.effectiveEo.all, (2 + 3 + 1) / 3);
  const e5 = rowFor(v, 5);
  assert.equal(e5.pickedEo.all, (1 + 1 + 2) / 3, 'picked: 3 captained 5');
  assert.equal(e5.effectiveEo.all, (1 + 1 + 0) / 3, 'effective: auto-subbed out for 3; the others were not subbed');
  const e6 = rowFor(v, 6);
  assert.deepEqual([e6.effectiveCaptain.all.count, e6.effectiveEo.all], [1, (1 + 1 + 2) / 3]);
  const e12 = rowFor(v, 12);
  assert.deepEqual([e12.pickedXi.all.count, e12.pickedSquad.all.count, e12.pickedEo.all, e12.effectiveEo.all], [0, 3, 0, 1 / 3]);
  // Rival comparison: Me (1) vs rivals (2, 3).
  assert.deepEqual([e1.myPickedMultiplier, e1.pickedEo.rivals, e1.pickedExposure], [2, (3 + 1) / 2, 2 - 2]);
  assert.deepEqual([e5.myEffectiveMultiplier, e5.effectiveEo.rivals, e5.effectiveExposure], [1, (1 + 0) / 2, 0.5]);
});

test('an unsettled captain with 0 minutes is PENDING, and effective metrics are provisional', () => {
  const v = view(loaded({ settled: false }));
  const c3 = v.captaincy.find((c) => c.entryId === 3);
  assert.equal(c3.effectiveCaptain.via, 'PENDING');
  assert.equal(c3.captainPoints, null);
  assert.equal(v.effectiveProvisional, true);
  assert.deepEqual(v.pendingCaptaincy, [3]);
});

test('missing live data never scores: captains stay PENDING rather than failing', () => {
  const l = loaded();
  l.live = new Map();
  const v = view(l);
  assert.ok(v.captaincy.every((c) => c.effectiveCaptain.via === 'PENDING'));
  assert.equal(v.effectiveProvisional, true);
});

test('an invalid 15-pick squad is refused, reported, and counted as missing', () => {
  const l = loaded();
  l.squads.find((s) => s.entryId === 2).picks = squad().slice(0, 14);
  const v = view(l);
  assert.deepEqual(v.invalidPicks, [{ entryId: 2, violations: ['expected 15 picks, got 14'] }]);
  assert.deepEqual(v.missingEntryIds, [2, 4]);
  assert.deepEqual(v.denominators, { rivals: 1, all: 2 });
  const twoCaptains = loaded();
  twoCaptains.squads.find((s) => s.entryId === 3).picks = squad().map((p) => ({ ...p, isCaptain: p.elementId <= 2 }));
  assert.deepEqual(view(twoCaptains).invalidPicks.map((i) => i.entryId), [3]);
});

test('deterministic ordering: metric desc, then element id; view switches the metric', () => {
  const eff = view(loaded(), { view: 'effective' });
  const values = eff.rows.map((r) => [r.effectiveEo.all, r.player.id]);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i - 1][0] > values[i][0] || (values[i - 1][0] === values[i][0] && values[i - 1][1] < values[i][1]), JSON.stringify(values.slice(i - 1, i + 1)));
  }
  const picked = view(loaded(), { view: 'picked' });
  assert.equal(picked.view, 'picked');
  assert.equal(picked.rows[0].player.id, 1, 'element 1 has the highest picked EO');
  assert.equal(view(loaded({ eventState: 'LIVE' })).defaultView, 'picked');
  assert.equal(view(loaded()).defaultView, 'effective');
});

test('players are referenced by FPL element id (the engine contract), not the storage id', () => {
  assert.deepEqual(toPlayerRef(player(351)), { id: 351, webName: 'P351', teamId: 1, elementType: 3, priceTenths: 50, status: 'a' });
  assert.ok(view().rows.every((r) => Number.isInteger(r.player.id)));
});

test('repeated identical inputs, in any input order, give an identical view and inputsHash', () => {
  const a = view();
  const l = loaded();
  l.squads.reverse();
  l.members.reverse();
  l.live = new Map([...l.live].reverse());
  l.players = new Map([...l.players].reverse());
  const b = view(l);
  assert.deepEqual(b, a);
  const changed = loaded({ minutes5: 10 });
  assert.notEqual(view(changed).inputsHash, a.inputsHash);
});
