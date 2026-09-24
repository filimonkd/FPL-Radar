import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipAvailability, validateChipRules } from '../../../src/analytics/chips.js';

const rule = (chipName, startEvent, stopEvent, source = 'FPL_BOOTSTRAP') => ({ chipName, startEvent, stopEvent, number: 1, source });

test('bootstrap windows: bboost 1–19 and 20–38, played GW 7 → first used, second available', () => {
  const res = chipAvailability([rule('bboost', 1, 19), rule('bboost', 20, 38)], [{ entryId: 1, chipName: 'bboost', event: 7 }], 8, [1]);
  const [first, second] = res.managers[0].chips;
  assert.deepEqual([first.used, first.available, first.current, first.playedEvents], [1, false, true, [7]]);
  assert.deepEqual([second.used, second.available, second.current], [0, true, false]);
  assert.equal(res.source, 'FPL_BOOTSTRAP');
});

test("unmapped chip: played 'newchip' → unmapped, no window affected", () => {
  const res = chipAvailability([rule('bboost', 1, 19)], [{ entryId: 1, chipName: 'newchip', event: 3 }], 3, [1]);
  assert.deepEqual(res.managers[0].unmapped, [{ chipName: 'newchip', event: 3 }]);
  assert.equal(res.managers[0].chips[0].used, 0);
});

test('fallback source: rules from CONFIG_FALLBACK → output source flagged', () => {
  assert.equal(chipAvailability([rule('bboost', 1, 19, 'CONFIG_FALLBACK')], [], 1, [1]).source, 'CONFIG_FALLBACK');
});

test('invalid bootstrap: overlapping windows → validator rejects the whole set', () => {
  const bad = validateChipRules([
    { name: 'bboost', number: 1, start_event: 1, stop_event: 19 },
    { name: 'bboost', number: 1, start_event: 19, stop_event: 38 },
    { name: 'wildcard', number: 1, start_event: 2, stop_event: 19 },
  ]);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.rules, []);
  assert.match(bad.problems.join(), /bboost: overlapping windows/);
});

test('validator accepts the observed 2026-27 bootstrap chips and rejects bad windows', () => {
  const observed = ['wildcard', 'freehit', 'bboost', '3xc'].flatMap((name) => [
    { name, number: 1, start_event: name === 'wildcard' || name === 'freehit' ? 2 : 1, stop_event: 19, chip_type: 'x' },
    { name, number: 1, start_event: 20, stop_event: 38, chip_type: 'x' },
  ]);
  const ok = validateChipRules(observed);
  assert.equal(ok.valid, true);
  assert.equal(ok.rules.length, 8);
  assert.equal(validateChipRules([{ name: 'x', number: 0, start_event: 1, stop_event: 2 }]).valid, false);
  assert.equal(validateChipRules([{ name: 'x', number: 1, start_event: 30, stop_event: 40 }]).valid, false);
  assert.equal(validateChipRules([]).valid, false);
});
