import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPoints, breakEven, transferCheck } from '../../../src/analytics/transfer.js';

// Team 1: GW6 home to 2 (FDR 2), GW7 blank, GW8 double (FDR 4 and 5), GW9 FDR 3, GW10 FDR 1.
// Team 5: GW6 blank, GW7–10 one game each at FDR 3.
const fixtures = [
  { event: 6, teamH: 1, teamA: 2, teamHFdr: 2, teamAFdr: 4 },
  { event: 8, teamH: 1, teamA: 3, teamHFdr: 4, teamAFdr: 2 },
  { event: 8, teamH: 4, teamA: 1, teamHFdr: 2, teamAFdr: 5 },
  { event: 9, teamH: 2, teamA: 1, teamHFdr: 3, teamAFdr: 3 },
  { event: 10, teamH: 1, teamA: 4, teamHFdr: null, teamAFdr: 2 },
  ...[7, 8, 9, 10].map((event) => ({ event, teamH: 5, teamA: 6, teamHFdr: 3, teamAFdr: 3 })),
];

test('projection: GW+1 is FPL ep_next; later GWs scale a per-game base by difficulty; blanks 0, doubles both', () => {
  const p = projectPoints({ teamId: 1, epNextTenths: 55 }, fixtures, 5);
  assert.equal(p.basis, 'EP_NEXT');
  assert.deepEqual(p.perGw, [
    { gw: 6, games: 1, points: 5.5, source: 'FPL' },
    { gw: 7, games: 0, points: 0, source: 'ESTIMATE' },
    { gw: 8, games: 2, points: 9.4, source: 'ESTIMATE' }, // 5.5 × 0.9 + 5.5 × 0.8
    { gw: 9, games: 1, points: 5.5, source: 'ESTIMATE' },
    { gw: 10, games: 1, points: 5.5, source: 'ESTIMATE' }, // unknown difficulty counts as 3
  ]);
  const blankFirst = projectPoints({ teamId: 5, epNextTenths: 0, formTenths: 40 }, fixtures, 5);
  assert.equal(blankFirst.basis, 'FORM', 'a blank GW+1 gives no per-game signal: fall back to form');
  assert.deepEqual(blankFirst.perGw.map((g) => g.points), [0, 4, 4, 4, 4]);
  const none = projectPoints({ teamId: 1, epNextTenths: null, formTenths: null }, fixtures, 5);
  assert.equal(none.basis, null);
  assert.ok(none.perGw.every((g) => g.points === null));
  assert.deepEqual(projectPoints({ teamId: 1, epNextTenths: 50 }, fixtures, 36).perGw.map((g) => g.gw), [37, 38], 'never past GW38');
});

test('break-even: a hit pays off once the cumulative gain reaches 4; a free transfer once it is above 0', () => {
  const out = { basis: 'EP_NEXT', perGw: [2, 2, 2, 2, 2].map((points, i) => ({ gw: 6 + i, points, source: i ? 'ESTIMATE' : 'FPL' })) };
  const buy = { basis: 'EP_NEXT', perGw: [3.5, 3.5, 3.5, 3.5, 3.5].map((points, i) => ({ gw: 6 + i, points, source: i ? 'ESTIMATE' : 'FPL' })) };
  const hit = breakEven(out, buy, { hit: true });
  assert.deepEqual(hit.perGw.map((g) => g.cumulative), [1.5, 3, 4.5, 6, 7.5]);
  assert.deepEqual([hit.verdict, hit.withinGws, hit.total, hit.net, hit.hitCost], ['PAYS_OFF', 3, 7.5, 3.5, 4]);
  assert.equal(hit.perGw[0].source, 'FPL');
  assert.equal(hit.perGw[1].source, 'ESTIMATE');
  const free = breakEven(out, buy, { hit: false });
  assert.deepEqual([free.verdict, free.withinGws, free.net], ['PAYS_OFF', 1, 7.5]);

  const worse = breakEven(buy, out, { hit: true });
  assert.deepEqual([worse.verdict, worse.withinGws, worse.total, worse.net], ['DOES_NOT_PAY', null, -7.5, -11.5]);
  const level = breakEven(out, out, { hit: false });
  assert.equal(level.verdict, 'DOES_NOT_PAY', 'no gain is not a pay-off');

  const gap = { basis: null, perGw: out.perGw.map((g) => ({ ...g, points: null })) };
  const unknown = breakEven(out, gap);
  assert.deepEqual([unknown.verdict, unknown.total, unknown.net], ['UNKNOWN', null, null]);
});

test('checks: bank after with the selling price, price difference, club limit, position, already owned', () => {
  const squad = [
    { elementId: 1, teamId: 7, position: 'MID' }, { elementId: 2, teamId: 7, position: 'DEF' }, { elementId: 3, teamId: 7, position: 'FWD' },
    { elementId: 4, teamId: 8, position: 'MID' },
  ];
  const out = { elementId: 4, teamId: 8, position: 'MID', sellingTenths: 62 };
  const c = transferCheck({ squad, out, in: { elementId: 9, teamId: 7, position: 'MID', priceTenths: 70 }, bankTenths: 5 });
  assert.deepEqual(c, { samePosition: true, alreadyOwned: false, clubCount: 4, clubLimitBroken: true, priceDiffTenths: 8, bankAfterTenths: -3, affordable: false });
  const ok = transferCheck({ squad, out: { ...squad[0], sellingTenths: 80 }, in: { elementId: 9, teamId: 7, position: 'MID', priceTenths: 70 }, bankTenths: 5 });
  assert.deepEqual([ok.clubCount, ok.clubLimitBroken, ok.bankAfterTenths, ok.affordable], [3, false, 15, true], 'selling a club-7 player frees the slot');
  assert.equal(transferCheck({ squad, out, in: { elementId: 1, teamId: 7, position: 'MID', priceTenths: 70 }, bankTenths: null }).alreadyOwned, true);
  assert.equal(transferCheck({ squad, out, in: { elementId: 9, teamId: 9, position: 'DEF', priceTenths: 40 }, bankTenths: null }).bankAfterTenths, null, 'bank unknown');
});
