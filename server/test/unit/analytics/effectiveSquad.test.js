import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEffectiveSquad } from '../../../src/analytics/effectiveSquad.js';
import { makePicks, makeLive } from '../../helpers/builders.js';

const mult = (s) => Object.fromEntries(s.picks.map((p) => [p.elementId, p.effectiveMultiplier]));
const derive = (over = {}) => deriveEffectiveSquad({ picks: makePicks(), activeChip: null, autoSubs: [], live: makeLive(), ...over });
const didNotPlay = { minutes: 0, totalPoints: 0, fixturesSettled: true };

test('plain XI: no chip, captain plays → XI 1, captain 2, bench 0', () => {
  const s = derive();
  const m = mult(s);
  assert.equal(m[1], 2);
  for (let id = 2; id <= 11; id++) assert.equal(m[id], 1);
  for (let id = 12; id <= 15; id++) assert.equal(m[id], 0);
  assert.deepEqual(s.effectiveCaptain, { elementId: 1, via: 'CAPTAIN' });
  assert.equal(s.capMult, 2);
});

test('triple captain: 3xc, captain plays → captain 3', () => {
  const s = derive({ activeChip: '3xc' });
  assert.equal(mult(s)[1], 3);
  assert.equal(s.picks[0].pickedMultiplier, 3);
});

test('TC captain fails: 3xc, captain 0 min settled, VC plays → VC 3, captain 0, via VICE', () => {
  const s = derive({ activeChip: '3xc', live: makeLive({ 1: didNotPlay }), autoSubs: [{ elementIn: 12, elementOut: 1, source: 'FPL' }] });
  assert.equal(mult(s)[2], 3);
  assert.equal(mult(s)[1], 0);
  assert.equal(s.effectiveCaptain.via, 'VICE');
});

test('captain fails: captain 0 min settled, VC plays → VC 2, via VICE', () => {
  const s = derive({ live: makeLive({ 1: didNotPlay }) });
  assert.equal(mult(s)[2], 2);
  assert.deepEqual(s.effectiveCaptain, { elementId: 2, via: 'VICE' });
});

test('both fail: both 0 min settled → no ×2, via NONE', () => {
  const s = derive({ live: makeLive({ 1: didNotPlay, 2: didNotPlay }) });
  assert.ok(Object.values(mult(s)).every((m) => m <= 1));
  assert.deepEqual(s.effectiveCaptain, { elementId: null, via: 'NONE' });
  assert.equal(s.captainPoints, 0);
});

test("pending: captain's fixture not settled → via PENDING, picked multiplier kept", () => {
  const s = derive({ live: makeLive({ 1: { minutes: 0, totalPoints: 0, fixturesSettled: false } }) });
  assert.equal(s.effectiveCaptain.via, 'PENDING');
  assert.equal(mult(s)[1], 2);
  assert.equal(s.captainPoints, null);
  assert.ok(!s.warnings.includes('FPL_MULTIPLIER_DIFFERS'));
});

test('bench boost: all 15 effective 1, captain 2; auto-subs ignored', () => {
  const s = derive({ activeChip: 'bboost', autoSubs: [{ elementIn: 12, elementOut: 7, source: 'FPL' }] });
  const m = mult(s);
  assert.equal(m[1], 2);
  for (let id = 2; id <= 15; id++) assert.equal(m[id], 1);
  assert.equal(s.benchBoost, true);
  assert.equal(s.autoSubSource, 'NONE');
});

test('auto-sub: [{in: 12th, out: 7th}] → out 0, in 1', () => {
  const s = derive({ autoSubs: [{ elementIn: 12, elementOut: 7, source: 'FPL' }], live: makeLive({ 7: didNotPlay }) });
  assert.equal(mult(s)[7], 0);
  assert.equal(mult(s)[12], 1);
  assert.equal(s.picks.find((p) => p.elementId === 7).autoSubbed, 'OUT');
  assert.equal(s.picks.find((p) => p.elementId === 12).autoSubbed, 'IN');
  assert.equal(s.autoSubSource, 'FPL');
});

test('auto-sub captain: captain auto-subbed out → captain 0, VC promoted', () => {
  const s = derive({ autoSubs: [{ elementIn: 12, elementOut: 1, source: 'FPL' }], live: makeLive({ 1: didNotPlay }) });
  assert.equal(mult(s)[1], 0);
  assert.equal(mult(s)[2], 2);
  assert.equal(s.effectiveCaptain.via, 'VICE');
});

test("unknown chip: active_chip 'mystery' → no chip effect, warning UNKNOWN_CHIP", () => {
  const s = derive({ activeChip: 'mystery' });
  assert.equal(mult(s)[1], 2);
  assert.equal(mult(s)[12], 0);
  assert.ok(s.warnings.includes('UNKNOWN_CHIP'));
});

test('reconstruction: Σ mult × pts = gross → no warning; off by 2 → EFFECTIVE_POINTS_MISMATCH', () => {
  // 10 outfield × 2 + captain 2 × 2 = 24
  assert.equal(derive({ grossGwPoints: 24 }).reconstructedPoints, 24);
  assert.ok(!derive({ grossGwPoints: 24 }).warnings.includes('EFFECTIVE_POINTS_MISMATCH'));
  assert.ok(derive({ grossGwPoints: 26 }).warnings.includes('EFFECTIVE_POINTS_MISMATCH'));
});

test('FPL multiplier disagreement is a warning, never the source', () => {
  const s = derive({ picks: makePicks({ fplMultipliers: { 12: 1 } }) });
  assert.ok(s.warnings.includes('FPL_MULTIPLIER_DIFFERS'));
  assert.equal(mult(s)[12], 0);
});
