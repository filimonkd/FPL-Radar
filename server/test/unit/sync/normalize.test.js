import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seasonOfBootstrap, buildEvents, chipRulesOf, mergeLeagueMembers, sameMembers, picksOf, buildSeasonRows, liveElementsOf, transfersOf, profileFromEntry,
} from '../../../src/sync/normalize.js';
import { SyncStageError } from '../../../src/sync/classify.js';
import { syntheticEvent, syntheticFixture, syntheticPick, syntheticChips } from '../fpl/helpers.js';
import { historyCurrent } from '../../helpers/fplWorld.js';

// Pure FPL → domain normalization (Step 7). Synthetic payloads only.

const H = (label) => `sha256:${label.repeat(64).slice(0, 64)}`;
const NOW = new Date('2026-09-22T19:00:00Z');
const bootstrap = (events) => ({ events, teams: [], elements: [], element_types: [], chips: syntheticChips() });

test('seasonOfBootstrap derives 2026-27 from GW1', () => {
  assert.equal(seasonOfBootstrap(bootstrap([syntheticEvent(1, { deadline_time: '2026-08-15T10:00:00Z' })])), '2026-27');
  assert.equal(seasonOfBootstrap(bootstrap([syntheticEvent(1, { deadline_time: '2099-08-15T10:00:00Z' })])), '2099-00');
  assert.throws(() => seasonOfBootstrap(bootstrap([])), SyncStageError);
});

test('buildEvents groups fixtures by GW, keeps unscheduled ones apart and derives state', () => {
  const events = [
    syntheticEvent(1, { deadline_time: '2026-08-15T10:00:00Z', finished: true, data_checked: true }),
    syntheticEvent(2, { deadline_time: '2026-08-22T10:00:00Z', finished: true }),
    syntheticEvent(3, { deadline_time: '2026-09-30T10:00:00Z' }),
  ];
  const fixtures = [syntheticFixture(2, 1), syntheticFixture(1, 1), syntheticFixture(3, 2), syntheticFixture(9, null, { kickoff_time: null })];
  const out = buildEvents({ season: '2026-27', bootstrap: bootstrap(events), fixtures, now: NOW });
  assert.deepEqual(out.events.map((e) => [e.gw, e.state, e.fixtures.map((f) => f.id)]), [[1, 'DATA_CHECKED', [1, 2]], [2, 'FPL_PROCESSING', [3]], [3, 'UPCOMING', []]]);
  assert.deepEqual(out.unscheduledFixtures.map((f) => f.id), [9]);
  assert.ok(out.events[0].deadlineTime instanceof Date);
  assert.equal(out.unscheduledFixtures[0].kickoffTime, null);
});

test('dataCheckedObservedAt: set on first sight, kept while true, cleared on revert', () => {
  const ev = (dataChecked) => bootstrap([syntheticEvent(1, { deadline_time: '2026-08-15T10:00:00Z', finished: true, data_checked: dataChecked })]);
  const first = buildEvents({ season: '2026-27', bootstrap: ev(true), fixtures: [], now: NOW }).events[0];
  assert.equal(first.dataCheckedObservedAt.getTime(), NOW.getTime());
  const kept = buildEvents({ season: '2026-27', bootstrap: ev(true), fixtures: [], now: new Date('2026-09-30T00:00:00Z'), existing: new Map([[1, first]]) }).events[0];
  assert.equal(kept.dataCheckedObservedAt.getTime(), NOW.getTime(), 'a replay keeps the first observation');
  const reverted = buildEvents({ season: '2026-27', bootstrap: ev(false), fixtures: [], now: NOW, existing: new Map([[1, first]]) }).events[0];
  assert.equal(reverted.dataCheckedObservedAt, null);
  assert.equal(reverted.state, 'FPL_PROCESSING');
});

test('chip rules: valid sets map to FPL_BOOTSTRAP, an invalid set is rejected whole', () => {
  const ok = chipRulesOf(bootstrap([]));
  assert.equal(ok.valid, true);
  assert.equal(ok.chipRules.source, 'FPL_BOOTSTRAP');
  assert.deepEqual(ok.chipRules.rules[0], { chipName: 'wildcard', number: 1, startEvent: 2, stopEvent: 19, chipType: 'transfer' });
  const bad = chipRulesOf({ chips: [...syntheticChips(), { id: 3, name: 'x', number: 0, start_event: 1, stop_event: 2, chip_type: 't' }] });
  assert.equal(bad.valid, false);
  assert.ok(bad.problems.length > 0);
});

test('league members: new appended, missing marked leftLeague, manual ones untouched, returning ones restored', () => {
  const T = new Date('2026-08-01T00:00:00Z');
  const existing = [
    { entryId: 1, isExcluded: true, joinedEvent: 3, leftLeague: false, addedManually: false, addedAt: T },
    { entryId: 2, isExcluded: false, joinedEvent: null, leftLeague: true, addedManually: false, addedAt: T },
    { entryId: 3, isExcluded: false, joinedEvent: null, leftLeague: false, addedManually: true, addedAt: T },
    { entryId: 4, isExcluded: false, joinedEvent: null, leftLeague: false, addedManually: false, addedAt: T },
  ];
  const merged = mergeLeagueMembers(existing, [2, 1, 5]);
  assert.deepEqual(merged.map((m) => [m.entryId, m.leftLeague, m.isExcluded]), [[1, false, true], [2, false, false], [3, false, false], [4, true, false], [5, false, false]]);
  assert.equal(merged[0].addedAt, T);
  assert.equal(merged[4].addedAt, undefined, 'the repository stamps addedAt');
  assert.equal(sameMembers(existing, existing.map((m) => ({ ...m, addedAt: new Date() }))), true, 'addedAt does not count as a change');
  assert.equal(sameMembers(existing, merged), false);
});

test('picks: sorted by position, auto-subs tagged FPL, invalid squads rejected as SCHEMA_FAIL', () => {
  const picks = Array.from({ length: 15 }, (_, i) => syntheticPick(i)).reverse();
  const res = { active_chip: '3xc', automatic_subs: [{ element_in: 12, element_out: 3 }], entry_history: { points: 60 }, picks };
  const out = picksOf(res);
  assert.deepEqual(out.picks.map((p) => p.squadPosition), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.deepEqual(out.autoSubs, [{ elementIn: 12, elementOut: 3, source: 'FPL' }]);
  assert.equal(out.activeChip, '3xc');
  assert.equal(out.picksPoints, 60);
  const twoCaptains = picks.map((p) => ({ ...p, is_captain: p.element <= 2 }));
  assert.throws(() => picksOf({ ...res, picks: twoCaptains }), (e) => e instanceof SyncStageError && e.code === 'SCHEMA_FAIL');
  assert.throws(() => picksOf({ ...res, picks: picks.slice(1) }), /expected 15 picks/);
});

const history = (rows, chips = []) => ({ current: historyCurrent(rows), past: [], chips });
const base = { season: '2026-27', entryId: 7, event: 3, eventStates: new Map(), existingRows: [], hashes: { history: H('a'), picks: H('b') } };
const picks3 = () => picksOf({ active_chip: null, automatic_subs: [], entry_history: { points: 55 }, picks: Array.from({ length: 15 }, (_, i) => syntheticPick(i)) });

test('season rows: the whole season is reconciled; semantics stay UNVERIFIED without proof', () => {
  const h = history([{ event: 1, points: 50 }, { event: 2, points: 60 }, { event: 3, points: 55 }]);
  const out = buildSeasonRows({ ...base, history: h, picks: picks3(), seasonSemantics: 'UNVERIFIED' });
  assert.deepEqual(out.rows.map((r) => [r.event, r.points.reconciliationStatus, r.points.pointsSemantics, r.hasPicks]),
    [[1, 'RECONCILED_NO_COST', 'UNVERIFIED', false], [2, 'RECONCILED_NO_COST', 'UNVERIFIED', false], [3, 'RECONCILED_NO_COST', 'UNVERIFIED', true]]);
  assert.deepEqual(out.sourceRequests.get(3), { history: H('a'), picks: H('b') });
  assert.deepEqual(out.sourceRequests.get(1), { history: H('a') });
  assert.equal(out.rows[2].points.picksReportedPoints, 55);
  assert.equal(out.evidenceCandidates.size, 0);
});

test('season rows: a proving hit row is an evidence candidate only while its points are new', () => {
  const h = history([{ event: 1, points: 50 }, { event: 2, points: 70, cost: 4 }, { event: 3, points: 55 }]);
  const first = buildSeasonRows({ ...base, history: h, picks: picks3(), seasonSemantics: 'UNVERIFIED' });
  assert.deepEqual([...first.evidenceCandidates], [[2, 'GROSS']]);
  assert.deepEqual([first.rows[1].points.netGwPoints, first.rows[1].points.grossGwPoints, first.rows[1].points.pointsSemantics], [66, 70, 'GROSS_BEFORE_HITS']);
  const stored = first.rows.map((r) => ({ ...r, provenance: { sourceRequests: out3(r) } }));
  function out3(r) { return first.sourceRequests.get(r.event); }
  const replay = buildSeasonRows({ ...base, history: h, picks: picks3(), seasonSemantics: 'GROSS_BEFORE_HITS', existingRows: stored });
  assert.equal(replay.evidenceCandidates.size, 0, 'same points inputs → no new evidence');
});

test('season rows: a CONFLICTED season never yields net/gross for hit rows', () => {
  const h = history([{ event: 1, points: 50 }, { event: 2, points: 70, cost: 4 }]);
  const out = buildSeasonRows({ ...base, event: 2, history: h, picks: null, seasonSemantics: 'CONFLICTED' });
  assert.deepEqual([out.rows[1].points.reconciliationStatus, out.rows[1].points.netGwPoints, out.rows[1].points.pointsSemantics], ['SEMANTICS_CONFLICT', null, 'CONFLICTED']);
  assert.equal(out.rows[0].points.reconciliationStatus, 'RECONCILED_NO_COST', 'C = 0 rows stay valid');
});

test('season rows: other GWs keep their stored picks, auto-subs, Rpicks and picks hash', () => {
  const h = history([{ event: 1, points: 50 }, { event: 2, points: 60 }, { event: 3, points: 55 }]);
  const prev = picks3();
  const existingRows = [{
    event: 2, hasPicks: true, picks: prev.picks, autoSubs: [{ elementIn: 12, elementOut: 1, source: 'FPL' }],
    points: { reportedGwPoints: 60, transferCost: 0, totalPoints: 110, previousTotalPoints: 50, picksReportedPoints: 60 }, provenance: { sourceRequests: { history: H('c'), picks: H('d') } },
  }];
  const out = buildSeasonRows({ ...base, history: h, picks: picks3(), seasonSemantics: 'UNVERIFIED', existingRows });
  const gw2 = out.rows.find((r) => r.event === 2);
  assert.equal(gw2.hasPicks, true);
  assert.deepEqual(gw2.autoSubs, [{ elementIn: 12, elementOut: 1, source: 'FPL' }]);
  assert.equal(gw2.points.picksReportedPoints, 60);
  assert.deepEqual(out.sourceRequests.get(2), { history: H('a'), picks: H('d') });
});

test('season rows: activeChip comes from picks for the synced GW and from history chips elsewhere', () => {
  const h = history([{ event: 1, points: 50 }, { event: 2, points: 60 }, { event: 3, points: 55 }], [{ name: 'wildcard', event: 2 }]);
  const out = buildSeasonRows({ ...base, history: h, picks: { ...picks3(), activeChip: 'bboost' }, seasonSemantics: 'UNVERIFIED' });
  assert.deepEqual(out.rows.map((r) => r.activeChip), [null, 'wildcard', 'bboost']);
});

test('live elements: settled from their fixtures, or from the team fixtures without explain rows', () => {
  const fixtures = [
    { id: 1, teamH: 1, teamA: 2, finished: true },
    { id: 2, teamH: 3, teamA: 4, finished: false },
  ];
  const live = { elements: [
    { id: 2, stats: { minutes: 90, total_points: 6 }, explain: [{ fixture: 1, stats: [] }] },
    { id: 1, stats: { minutes: 0, total_points: 0 }, explain: [] },
    { id: 3, stats: { minutes: 45, total_points: 2 }, explain: [{ fixture: 2, stats: [] }] },
    { id: 4, stats: { minutes: 0, total_points: 0 }, explain: [] },
  ] };
  const out = liveElementsOf(live, fixtures, new Map([[1, 2], [2, 1], [3, 3], [4, 4]]));
  assert.deepEqual(out.map((e) => [e.elementId, e.settled]), [[1, true], [2, true], [3, false], [4, false]]);
});

test('transfers and profiles map to domain types', () => {
  assert.deepEqual(transfersOf([{ element_in: 1, element_in_cost: 50, element_out: 2, element_out_cost: 55, entry: 7, event: 3, time: '2026-08-30T10:00:00Z' }]),
    [{ elementIn: 1, elementInCostTenths: 50, elementOut: 2, elementOutCostTenths: 55, event: 3, time: new Date('2026-08-30T10:00:00Z') }]);
  assert.deepEqual(profileFromEntry({ id: 7, name: 'XI', player_first_name: 'A', player_last_name: 'B' }), { entryId: 7, playerName: 'A B', teamName: 'XI' });
});
