import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlayersView } from '../../../src/services/playersModel.js';

const ev = (gw, finished, fixtures = [{ teamH: 1, teamA: 2, teamHFdr: 2, teamAFdr: 4 }]) => ({ gw, finished, state: finished ? 'FINALIZED' : 'LIVE', isCurrent: false, fixtures });
const live = (gw, minutes, points = 2) => ({ gw, elements: [{ elementId: 7, totalPoints: points, minutes, settled: true }] });

test('form windows skip the GW in progress; rotation skips blank GWs; missing data stays null', () => {
  const events = [ev(1, true), ev(2, true, []), ev(3, true), ev(4, true), ev(5, false), ev(6, false)];
  const v = buildPlayersView({
    season: '2026-27', event: 5, events,
    teams: [{ id: 2, name: 'Club 2', shortName: 'C2' }, { id: 1, name: 'Club 1', shortName: 'C1' }],
    players: [
      { elementId: 7, webName: 'A', teamId: 1, elementType: 3, priceTenths: 60, costChangeStartTenths: 5 },
      { elementId: 3, webName: 'B', teamId: 9, elementType: 5, priceTenths: 40 },
    ],
    live: [live(1, 30), live(2, 0, 0), live(3, 90), live(4, 45), live(5, 0, 0)],
  });
  assert.equal(v.statsThrough, 4, 'GW5 is not finished');
  assert.deepEqual(v.historyGws, [1, 2, 3, 4]);
  assert.deepEqual(v.teams.map((t) => t.id), [1, 2]);
  assert.deepEqual(v.players.map((p) => p.elementId), [3, 7]);
  const [b, a] = v.players;
  assert.deepEqual(a.last[3], { points: 4, minutes: 135, gws: 3, of: 3 }, 'GW2–4; GW5 in progress excluded');
  assert.deepEqual(a.rotation, { risk: true, short: 2, games: 3 }, 'GW2 was a blank: GW4 45, GW3 90, GW1 30');
  assert.equal(a.startPriceTenths, 55);
  assert.equal(a.position, 'MID');
  assert.deepEqual(a.fixtures.gws, [6, 7, 8]);
  assert.equal(b.position, null);
  assert.equal(b.team, null);
  assert.equal(b.startPriceTenths, null);
  assert.deepEqual(b.last[3], { points: null, minutes: null, gws: 0, of: 3 });
  assert.deepEqual(b.rotation, { risk: null, short: 0, games: 0 });
});
