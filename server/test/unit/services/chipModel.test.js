import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chipInputs, buildChipView, chipState, chipLabel } from '../../../src/services/chipModel.js';
import { parseSmokeReport } from '../../../src/services/smokeReport.js';

// Chips (Step 11): chip states from FPL's two sources, the engine's applied
// effects and availability windows. Synthetic data; the smoke parser also runs
// on the committed (anonymized) report.

// The 2026-27 bootstrap shape: each chip twice, windows 1/2–19 and 20–38 (smoke B5).
const RULES = ['wildcard', 'freehit', 'bboost', '3xc'].flatMap((chipName) => [
  { chipName, startEvent: chipName === 'wildcard' || chipName === 'freehit' ? 2 : 1, stopEvent: 19, number: 1, chipType: null, source: 'FPL_BOOTSTRAP' },
  { chipName, startEvent: 20, stopEvent: 38, number: 1, chipType: null, source: 'FPL_BOOTSTRAP' },
]);
const picks = () => Array.from({ length: 15 }, (_, i) => ({ elementId: i + 1, squadPosition: i + 1, fplMultiplier: i === 0 ? 2 : i < 11 ? 1 : 0, isCaptain: i === 0, isViceCaptain: i === 1 }));
const row = (entryId, activeChip = null, hasPicks = true) => ({ entryId, activeChip, hasPicks, picks: hasPicks ? picks() : [], autoSubs: [] });
const member = (entryId, synced = true) => ({ entryId, isExcluded: false, synced });

function loaded({ event = 5, eventState = 'DATA_CHECKED', chipRules = { source: 'FPL_BOOTSTRAP', rules: RULES } } = {}) {
  return {
    eventState,
    chipRules,
    members: [member(1), member(2), member(3), member(4), member(5), member(6, false), member(7)],
    rows: [row(1, 'bboost'), row(2, '3xc'), row(3), row(4), row(5, 'wildcard'), row(7, 'mystery')],
    played: [
      { entryId: 1, chipName: 'bboost', event },
      { entryId: 2, chipName: '3xc', event },
      { entryId: 3, chipName: 'wildcard', event: 2 },
      { entryId: 4, chipName: 'freehit', event }, // squad row shows no chip → disagreement
      { entryId: 7, chipName: 'mystery', event },
    ],
  };
}
const view = (l = loaded(), event = 5) => buildChipView(chipInputs(l, event));
const gw = (v, entryId) => v.gameweek.find((g) => g.entryId === entryId);

test('chip state compares FPL history with the GW squad, never inferring from missing data', () => {
  assert.deepEqual(chipState({ synced: false, declared: null, row: null }), { state: 'UNKNOWN', reason: 'NOT_SYNCED' });
  assert.deepEqual(chipState({ synced: true, declared: null, row: null }), { state: 'UNKNOWN', reason: 'NO_GW_ROW' });
  assert.deepEqual(chipState({ synced: true, declared: 'bboost', row: null }), { state: 'PLAYED' });
  assert.deepEqual(chipState({ synced: true, declared: 'bboost', row: { activeChip: 'bboost' } }), { state: 'PLAYED' });
  assert.deepEqual(chipState({ synced: true, declared: 'freehit', row: { activeChip: null } }), { state: 'SOURCE_DISAGREEMENT' });
  assert.deepEqual(chipState({ synced: true, declared: null, row: { activeChip: 'wildcard' } }), { state: 'ACTIVE_UNCONFIRMED' });
  assert.deepEqual(chipState({ synced: true, declared: null, row: { activeChip: null } }), { state: 'NONE' });
});

test('each documented chip type: declared, squad chip and the effect the engine applies', () => {
  const v = view();
  assert.deepEqual([gw(v, 1).state, gw(v, 1).declaredLabel, gw(v, 1).applied.scoringEffect, gw(v, 1).applied.benchBoost], ['PLAYED', 'Bench Boost', 'BENCH_BOOST', true]);
  assert.deepEqual([gw(v, 2).state, gw(v, 2).declaredLabel, gw(v, 2).applied.scoringEffect, gw(v, 2).applied.tripleCaptain], ['PLAYED', 'Triple Captain', 'TRIPLE_CAPTAIN', true]);
  assert.deepEqual([gw(v, 3).state, gw(v, 3).declared, gw(v, 3).applied.scoringEffect], ['NONE', null, 'NONE'], 'a wildcard in GW2 is not this GW\'s chip');
  assert.deepEqual([gw(v, 4).state, gw(v, 4).declaredLabel], ['SOURCE_DISAGREEMENT', 'Free Hit']);
  assert.deepEqual([gw(v, 5).state, gw(v, 5).squadChipLabel, gw(v, 5).applied.scoringEffect], ['ACTIVE_UNCONFIRMED', 'Wildcard', 'NONE'], 'wildcard / free hit do not change multipliers');
  assert.deepEqual([gw(v, 6).state, gw(v, 6).reason, gw(v, 6).applied], ['UNKNOWN', 'NOT_SYNCED', null]);
  assert.deepEqual([gw(v, 7).state, gw(v, 7).declaredLabel, gw(v, 7).applied.unknownChip, gw(v, 7).applied.scoringEffect], ['PLAYED', 'mystery', true, 'NONE'], 'unknown chip: raw label, no effect');
  assert.deepEqual(v.playedThisEvent.map((p) => [p.chipName, p.count, p.entryIds]), [['3xc', 1, [2]], ['bboost', 1, [1]], ['mystery', 1, [7]]]);
});

test('availability: used vs unused chips, the current window, unmapped names', () => {
  const v = view();
  const m1 = v.availability.managers.find((m) => m.entryId === 1);
  const bb = m1.chips.filter((c) => c.chipName === 'bboost');
  assert.deepEqual(bb.map((c) => [c.window, c.used, c.available, c.current]), [[[1, 19], 1, false, true], [[20, 38], 0, true, false]]);
  const tc = m1.chips.filter((c) => c.chipName === '3xc');
  assert.deepEqual(tc.map((c) => [c.used, c.available]), [[0, true], [0, true]], 'an unused chip stays available');
  assert.deepEqual(v.availability.managers.find((m) => m.entryId === 7).unmapped, [{ chipName: 'mystery', event: 5 }]);
  assert.ok(!v.availability.managers.some((m) => m.entryId === 6), 'unsynced managers are not given a clean slate');
  assert.deepEqual(v.missingEntryIds, [6]);
});

test('window boundaries: GW19 uses the first window, GW20 the second', () => {
  const l = loaded({ event: 19 });
  l.played = [{ entryId: 1, chipName: 'bboost', event: 19 }, { entryId: 2, chipName: 'bboost', event: 20 }];
  const at19 = buildChipView(chipInputs(l, 19));
  const w = (v, id) => v.availability.managers.find((m) => m.entryId === id).chips.filter((c) => c.chipName === 'bboost').map((c) => [c.used, c.current]);
  assert.deepEqual(w(at19, 1), [[1, true], [0, false]]);
  assert.deepEqual(w(at19, 2), [[0, true], [1, false]]);
  const at20 = buildChipView(chipInputs(l, 20));
  assert.deepEqual(w(at20, 2), [[0, false], [1, true]]);
});

test('incomplete / live GW is provisional; missing or fallback rules are flagged, never invented', () => {
  const live = view(loaded({ eventState: 'LIVE' }));
  assert.equal(live.provisional, true);
  assert.ok(live.warnings.some((w) => w.code === 'PROVISIONAL_EVENT_STATE'));
  const none = view(loaded({ chipRules: null }));
  assert.deepEqual([none.rules, none.availability], [null, null]);
  assert.deepEqual(none.warnings.map((w) => w.code), ['CHIP_RULES_UNAVAILABLE']);
  assert.equal(gw(none, 1).state, 'PLAYED', 'the GW state still reads FPL data');
  const fallback = view(loaded({ chipRules: { source: 'CONFIG_FALLBACK', rules: RULES.map((r) => ({ ...r, source: 'CONFIG_FALLBACK' })) } }));
  assert.deepEqual(fallback.warnings.map((w) => w.code), ['CONFIG_FALLBACK']);
  assert.equal(fallback.availability.source, 'CONFIG_FALLBACK');
});

test('deterministic: identical inputs in any order give the identical view and inputsHash', () => {
  const a = view();
  const l = loaded();
  l.members.reverse();
  l.rows.reverse();
  l.played.reverse();
  l.chipRules.rules = [...RULES].reverse();
  assert.deepEqual(view(l), a);
  assert.equal(chipLabel('unknownchip'), 'unknownchip');
});

test('smoke report parser reads the committed report and refuses anything else', () => {
  const md = readFileSync(fileURLToPath(new URL('../../../fpl-contract/2026-27/smoke-report.md', import.meta.url)), 'utf8');
  const r = parseSmokeReport(md);
  assert.equal(r.available, true);
  assert.equal(r.season, '2026-27');
  assert.ok(r.checks.length >= 30);
  assert.equal(r.checks[0].id, 'B1');
  assert.equal(r.counts.PASS, 29);
  assert.equal(r.counts.UNVERIFIED, 5);
  assert.match(r.exit, /^Exit code 2/);
  assert.deepEqual(parseSmokeReport('# something else'), { available: false });
  assert.deepEqual(parseSmokeReport(undefined), { available: false });
});
