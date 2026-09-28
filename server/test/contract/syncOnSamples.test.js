import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schemas from '../../src/fpl/schemas.js';
import { validate } from '../../src/fpl/validate.js';
import { seasonOfBootstrap, buildEvents, playersOf, chipRulesOf, picksOf, buildSeasonRows, liveElementsOf, transfersOf, profileFromEntry, profileFromStandings } from '../../src/sync/normalize.js';

// The sync normalizers on the real, anonymized 2026-27 smoke samples.
const DIR = fileURLToPath(new URL('../../fpl-contract/2026-27/', import.meta.url));
const load = (name, schema) => {
  const { ok, data } = validate(schemas[schema], JSON.parse(readFileSync(`${DIR}${name}.sample.json`, 'utf8')));
  assert.ok(ok, `${name} matches its schema`);
  return data;
};
const NAMES = ['bootstrap-static', 'fixtures', 'entry-history', 'entry-picks', 'event-live', 'entry-transfers', 'entry', 'leagues-classic-standings'];
const have = NAMES.every((n) => existsSync(`${DIR}${n}.sample.json`));

test('sync normalizers on real 2026-27 samples', { skip: have ? false : 'samples not present' }, () => {
  const bootstrap = load('bootstrap-static', 'bootstrapStatic');
  const fixtures = load('fixtures', 'fixtures');
  const history = load('entry-history', 'entryHistory');
  const picksRes = load('entry-picks', 'entryPicks');
  const live = load('event-live', 'eventLive');
  const gw = picksRes.entry_history.event;

  const season = seasonOfBootstrap(bootstrap);
  assert.equal(season, '2026-27');
  const { events } = buildEvents({ season, bootstrap, fixtures, now: new Date('2026-09-24T00:00:00Z') });
  assert.equal(events.length, 38);
  const ev = events.find((e) => e.gw === gw);
  assert.equal(ev.state, 'DATA_CHECKED');
  assert.ok(ev.fixtures.length > 0);
  assert.ok(chipRulesOf(bootstrap).valid, 'real chips[] validate');
  assert.ok(playersOf(bootstrap, season).every((p) => Number.isInteger(p.priceTenths)));

  const picks = picksOf(picksRes);
  assert.equal(picks.picks.length, 15);
  const { rows } = buildSeasonRows({
    season, entryId: 1, event: gw, history, picks, seasonSemantics: 'UNVERIFIED', eventStates: new Map(events.map((e) => [e.gw, e.state])),
    existingRows: [], hashes: { history: `sha256:${'a'.repeat(64)}`, picks: `sha256:${'b'.repeat(64)}` },
  });
  assert.equal(rows.length, history.current.length);
  assert.ok(rows.every((r) => ['RECONCILED', 'RECONCILED_NO_COST'].includes(r.points.reconciliationStatus)));
  assert.equal(rows.find((r) => r.event === gw).hasPicks, true);

  const teamOf = new Map(bootstrap.elements.map((p) => [p.id, p.team]));
  const elements = liveElementsOf(live, ev.fixtures, teamOf);
  assert.equal(elements.length, live.elements.length);
  assert.ok(elements.every((e) => typeof e.settled === 'boolean'));

  assert.ok(transfersOf(load('entry-transfers', 'entryTransfers')).every((t) => t.time instanceof Date));
  assert.equal(typeof profileFromEntry(load('entry', 'entry')).playerName, 'string');
  const standings = load('leagues-classic-standings', 'classicLeagueStandings');
  assert.ok(standings.standings.results.map(profileFromStandings).every((p) => Number.isInteger(p.entryId)));
});
