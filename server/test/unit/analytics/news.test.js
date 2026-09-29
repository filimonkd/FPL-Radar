import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerFlags, buildNewsFeed, PRICE_PRESSURE_NET } from '../../../src/analytics/news.js';

const P = (elementId, over = {}) => ({
  elementId, webName: `P${elementId}`, team: 'C1', position: 'MID', status: 'a', news: null, newsAdded: null, chanceNext: null,
  rotation: { risk: false }, transfersInEvent: 0, transfersOutEvent: 0, costChangeEventTenths: 0, ...over,
});

test('flags: out, doubt with chance, rotation, price dropped, price pressure', () => {
  assert.deepEqual(playerFlags(P(1)), []);
  assert.deepEqual(playerFlags(P(1, { status: 'i', chanceNext: 0 })), [{ code: 'OUT', label: 'Injured', chance: 0 }]);
  assert.deepEqual(playerFlags(P(1, { status: 's' })), [{ code: 'OUT', label: 'Suspended', chance: null }]);
  assert.deepEqual(playerFlags(P(1, { status: 'u' }))[0].label, 'Unavailable');
  assert.deepEqual(playerFlags(P(1, { status: 'd', chanceNext: 75 })), [{ code: 'DOUBT', chance: 75 }]);
  assert.deepEqual(playerFlags(P(1, { rotation: { risk: true } })), [{ code: 'ROTATION' }]);
  assert.deepEqual(playerFlags(P(1, { rotation: { risk: null } })), [], 'unknown rotation is not a flag');
  assert.deepEqual(playerFlags(P(1, { costChangeEventTenths: -1 })), [{ code: 'PRICE_DROPPED', changeTenths: -1 }]);
  assert.deepEqual(playerFlags(P(1, { costChangeEventTenths: 1 })), [], 'a rise is not an alert');
  assert.deepEqual(playerFlags(P(1, { transfersInEvent: PRICE_PRESSURE_NET + 10, transfersOutEvent: 10 })), [{ code: 'PRICE_PRESSURE', net: PRICE_PRESSURE_NET }]);
  assert.deepEqual(playerFlags(P(1, { transfersInEvent: PRICE_PRESSURE_NET - 1, transfersOutEvent: 0 })), []);
  assert.deepEqual(playerFlags(P(1, { transfersInEvent: null, transfersOutEvent: 0, costChangeEventTenths: null })), [], 'missing data is no flag');
  assert.deepEqual(playerFlags(P(1, { status: 'd', chanceNext: 50, rotation: { risk: true }, costChangeEventTenths: -1 })).map((f) => f.code), ['DOUBT', 'ROTATION', 'PRICE_DROPPED']);
});

test('feed: owned players only, newest news first, owners listed, my alerts', () => {
  const players = [
    P(1, { status: 'i', news: 'Knee injury', newsAdded: '2026-09-20T10:00:00Z' }),
    P(2, { status: 'd', chanceNext: 50, news: 'Knock', newsAdded: '2026-09-25T10:00:00Z' }),
    P(3, { rotation: { risk: true } }),
    P(4, { status: 'i', news: 'Unowned', newsAdded: '2026-09-28T10:00:00Z' }),
    P(5),
    P(6, { transfersInEvent: 90_000, transfersOutEvent: 1000 }),
    P(7, { news: 'Returned to training', newsAdded: '2026-09-26T10:00:00Z' }),
  ];
  const squads = [{ entryId: 20, elementIds: [1, 2, 5, 6] }, { entryId: 10, elementIds: [2, 3, 6, 7] }];
  const { items, mine } = buildNewsFeed({ players, squads, myEntryId: 10 });
  assert.deepEqual(items.map((x) => x.elementId), [7, 2, 1, 3, 6], 'dated news newest first; undated after, most severe first; 4 unowned, 5 nothing to say');
  assert.deepEqual(items.find((x) => x.elementId === 2).ownedBy, [10, 20]);
  assert.equal(items.find((x) => x.elementId === 1).ownedByMe, false);
  assert.deepEqual(items.find((x) => x.elementId === 7).flags, [], 'news without a flag is still shown');
  assert.deepEqual(mine.map((x) => x.elementId), [2, 3], 'price pressure on my own player is not an alert; news alone is not either');
  assert.deepEqual(buildNewsFeed({ players, squads, myEntryId: null }).mine, []);
  assert.deepEqual(buildNewsFeed({ players, squads: [] }).items, []);
});
