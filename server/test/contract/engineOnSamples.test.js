import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reconcileSeason } from '../../src/analytics/reconcile.js';
import { deriveEffectiveSquad } from '../../src/analytics/effectiveSquad.js';
import { validateChipRules } from '../../src/analytics/chips.js';
import { deriveEventState } from '../../src/analytics/eventState.js';

// Runs the pure engine over the real, anonymized 2026-27 smoke samples.
const DIR = fileURLToPath(new URL('../../fpl-contract/2026-27/', import.meta.url));
const load = (name) => JSON.parse(readFileSync(`${DIR}${name}.sample.json`, 'utf8'));
const have = ['bootstrap-static', 'fixtures', 'entry-history', 'entry-picks', 'event-live'].every((n) => existsSync(`${DIR}${n}.sample.json`));

test('engine on real 2026-27 samples', { skip: have ? false : 'samples not present' }, async (t) => {
  const bootstrap = load('bootstrap-static');
  const history = load('entry-history');
  const picks = load('entry-picks');
  const live = load('event-live');
  const fixtures = load('fixtures');
  const gw = picks.entry_history.event;

  await t.test('reconcileSeason: every real row reconciles; none mismatch', () => {
    const { rows } = reconcileSeason({
      season: '2026-27',
      historyRows: history.current.map((r) => ({ event: r.event, points: r.points, eventTransfersCost: r.event_transfers_cost, totalPoints: r.total_points })),
      picksPoints: new Map([[gw, picks.entry_history.points]]),
      seasonSemantics: 'UNVERIFIED',
      eventStates: new Map([[gw, 'DATA_CHECKED']]),
    });
    assert.equal(rows.length, history.current.length);
    for (const r of rows) assert.ok(['RECONCILED', 'RECONCILED_NO_COST'].includes(r.reconciliationStatus), `GW${r.event}: ${r.reconciliationStatus}`);
  });

  await t.test('deriveEventState: the sampled GW is DATA_CHECKED', () => {
    const ev = bootstrap.events.find((e) => e.id === gw);
    const state = deriveEventState(
      { id: ev.id, deadlineTime: ev.deadline_time, finished: ev.finished, dataChecked: ev.data_checked },
      fixtures.map((f) => ({ event: f.event, finished: f.finished, finishedProvisional: f.finished_provisional })),
      new Date('2026-09-24T00:00:00Z'),
    );
    assert.equal(state, 'DATA_CHECKED');
  });

  await t.test('V3: Σ engine effective multiplier × live points = picks points (gross)', () => {
    const liveMap = new Map(live.elements.map((e) => [e.id, { minutes: e.stats.minutes, totalPoints: e.stats.total_points, fixturesSettled: true }]));
    const squad = deriveEffectiveSquad({
      picks: picks.picks.map((p) => ({ elementId: p.element, squadPosition: p.position, isCaptain: p.is_captain, isViceCaptain: p.is_vice_captain, fplMultiplier: p.multiplier })),
      activeChip: picks.active_chip,
      autoSubs: picks.automatic_subs.map((s) => ({ elementIn: s.element_in, elementOut: s.element_out, source: 'FPL' })),
      live: liveMap,
      grossGwPoints: picks.entry_history.points,
    });
    assert.equal(squad.reconstructedPoints, picks.entry_history.points);
    assert.deepEqual(squad.warnings, []);
    assert.notEqual(squad.effectiveCaptain.via, 'PENDING');
  });

  await t.test('validateChipRules accepts the real bootstrap chips[]', () => {
    const v = validateChipRules(bootstrap.chips);
    assert.equal(v.valid, true, v.problems.join('; '));
  });
});
