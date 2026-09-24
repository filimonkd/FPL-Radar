import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ids, parseIds } from '../../src/db/ids.js';

const GROUP = '66f0c1a2b3c4d5e6f7a8b9c0';

test('builds the v0.3 §4 _id formats', () => {
  assert.equal(ids.season('2026-27'), '2026-27');
  assert.equal(ids.event('2026-27', 5), '2026-27:5');
  assert.equal(ids.liveGameweek('2026-27', 5), '2026-27:5');
  assert.equal(ids.player('2026-27', 351), '2026-27:351');
  assert.equal(ids.manager(123456), 123456);
  assert.equal(ids.managerGameweek('2026-27', 123456, 5), '2026-27:123456:5');
  assert.equal(ids.managerSeason('2026-27', 123456), '2026-27:123456');
  assert.equal(ids.gwResult(GROUP, '2026-27', 5), `${GROUP}:2026-27:5`);
  assert.equal(ids.lock('sync:group', GROUP), `sync:group:${GROUP}`);
  assert.equal(ids.lock('migrate'), 'migrate');
});

test('rejects malformed components', () => {
  assert.throws(() => ids.season('2026/27'), TypeError);
  assert.throws(() => ids.season('2026-28'), TypeError);
  assert.throws(() => ids.event('2026-27', 0), TypeError);
  assert.throws(() => ids.event('2026-27', 39), TypeError);
  assert.throws(() => ids.managerGameweek('2026-27', 1.5, 5), TypeError);
  assert.throws(() => ids.gwResult('not-an-objectid', '2026-27', 5), TypeError);
});

test('parsers round-trip and reject ids that do not rebuild identically', () => {
  assert.deepEqual(parseIds.event('2026-27:5'), { season: '2026-27', gw: 5 });
  assert.deepEqual(parseIds.managerGameweek('2026-27:123456:5'), { season: '2026-27', entryId: 123456, event: 5 });
  assert.deepEqual(parseIds.managerSeason('2026-27:123456'), { season: '2026-27', entryId: 123456 });
  assert.deepEqual(parseIds.gwResult(`${GROUP}:2026-27:5`), { groupId: GROUP, season: '2026-27', gw: 5 });
  for (const bad of ['2026-27:05', '2026-27:0', '2026-27:40', '2026-27']) assert.throws(() => parseIds.event(bad), TypeError, bad);
  assert.throws(() => parseIds.managerGameweek('2026-27:0123456:5'), TypeError);
});
