import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRivals } from '../../../src/analytics/rivals.js';

// Step 16: rival analytics on hand-built synthetic data (entry IDs 1–4).

const managers = [1, 2, 3, 4].map((id) => ({ entryId: id, teamName: `T${id}`, playerName: `P${id}` }));
const members = [1, 2, 3, 4].map((entryId) => ({ entryId, isExcluded: false }));
// score per GW (GW1..GW5) and season total at GW5
const SCORES = { 1: [50, 60, 40, 70, 60], 2: [55, 45, 80, 75, 70], 3: [40, 40, 40, 40, 40], 4: [60, 60, 60, 60, null] };
function rows() {
  const out = [];
  for (const [id, list] of Object.entries(SCORES)) {
    let total = 0;
    list.forEach((sc, i) => {
      total += sc ?? 50;
      out.push({ entryId: Number(id), event: i + 1, score: sc, transferCost: Number(id) === 2 && i === 2 ? 8 : 0, totalPoints: total, bankTenths: 10 * Number(id), teamValueTenths: 1000 + Number(id), activeChip: Number(id) === 2 && i === 4 ? '3xc' : null });
    });
  }
  return out;
}
const pick = (elementId, pos, cap = false, vice = false) => ({ elementId, squadPosition: pos, isCaptain: cap, isViceCaptain: vice });
const squad = (entryId, xi, cap, event = 5) => ({ entryId, event, picks: [...xi.map((e, i) => pick(e, i + 1, e === cap, i === 1)), ...[901, 902, 903, 904].map((e, i) => pick(e + entryId * 10, 12 + i))] });
const XI1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const XI2 = [1, 2, 3, 4, 5, 6, 7, 20, 21, 22, 23]; // 7 shared with 1
const players = [...Array.from({ length: 23 }, (_, i) => ({ id: i + 1, webName: `pl${i + 1}`, teamId: (i % 4) + 1, epNextTenths: 20 })), { id: 23, webName: 'pl23', teamId: 4, epNextTenths: null }];
const upcoming = [
  { event: 6, teamH: 1, teamA: 2, teamHFdr: 2, teamAFdr: 4 },
  { event: 7, teamH: 3, teamA: 1, teamHFdr: 3, teamAFdr: 5 },
  { event: 8, teamH: 4, teamA: 2, teamHFdr: 2, teamAFdr: 2 },
  { event: 9, teamH: 1, teamA: 3, teamHFdr: 5, teamAFdr: 5 }, // outside the 3-GW window
];
const chipsLeft = [
  { entryId: 1, chips: [{ chipName: 'wildcard', available: true }, { chipName: '3xc', available: false }] },
  { entryId: 2, chips: [{ chipName: '3xc', available: true }, { chipName: 'bboost', available: true }, { chipName: 'freehit', available: false }] },
  { entryId: 3, chips: [] },
  { entryId: 4, chips: [{ chipName: 'freehit', available: true }] },
];
const base = (over = {}) => computeRivals({
  event: 5, myEntryId: 1, members, managers, rows: rows(),
  squads: [squad(1, XI1, 1), squad(2, XI2, 20), squad(3, XI1, 5, 4)],
  players, upcoming, transfersIn: [{ elementId: 20, count: 2, entryIds: [2, 3] }, { elementId: 1, count: 1, entryIds: [4] }, { elementId: 99, count: 1, entryIds: [77] }],
  chipsLeft, ...over,
});

test('leaderboard ranks by FPL season total with a top-3 podium and the GW top scorer', () => {
  const r = base();
  assert.deepEqual(r.leaderboard.map((x) => [x.entryId, x.total, x.rank]), [[2, 325, 1], [4, 290, 2], [1, 280, 3], [3, 200, 4]]);
  assert.deepEqual(r.podium.map((x) => x.entryId), [2, 4, 1]);
  assert.deepEqual(r.gwTop.map((x) => [x.entryId, x.score]), [[2, 70]]);
  assert.equal(r.leaderboard.find((x) => x.entryId === 4).gwScore, null, 'an unreconciled GW is null, not 0');
  assert.equal(r.leaderboard.find((x) => x.entryId === 1).isMe, true);
  assert.deepEqual(r.leaderboard.find((x) => x.entryId === 2).gwHit, 0);
  assert.deepEqual(r.captains.map((c) => [c.entryId, c.captain]), [[1, 1], [2, 20], [3, 5], [4, null]]);
  assert.equal(r.players.find((p) => p.id === 20).webName, 'pl20');
});

test('spy vs me: GW and overall differentials, XI overlap, bank, value, captain', () => {
  const r2 = base().rivals.find((x) => x.entryId === 2);
  assert.deepEqual([r2.gwDiff, r2.overallDiff], [10, 45]);
  assert.deepEqual([r2.overlap.shared, r2.overlap.of, r2.overlap.theirOnly], [7, 11, [20, 21, 22, 23]]);
  assert.deepEqual([r2.bankTenths, r2.valueTenths, r2.captain, r2.activeChip], [20, 1002, 20, '3xc']);
  const r4 = base().rivals.find((x) => x.entryId === 4);
  assert.equal(r4.gwDiff, null, 'no reconciled score → no differential');
  assert.equal(r4.overlap, null, 'no known squad → no overlap');
});

test('rival radar: closest above/below, form, hits, chips, head-to-head', () => {
  const r = base();
  assert.deepEqual([r.closest.myRank, r.closest.above.entryId, r.closest.above.gap, r.closest.below.entryId, r.closest.below.gap], [3, 4, 10, 3, -80]);
  const r2 = r.rivals.find((x) => x.entryId === 2);
  assert.deepEqual([r2.form, r2.formGws], [75, [3, 4, 5]]);
  assert.deepEqual([r2.hits, r2.hitGws], [8, 1]);
  assert.deepEqual(r2.chipsLeft, ['3xc', 'bboost']);
  assert.deepEqual(r2.h2h, { wins: 1, losses: 4, draws: 0, gws: 5 }, 'me 50,60,40,70,60 vs them 55,45,80,75,70');
  assert.deepEqual(r.rivals.find((x) => x.entryId === 4).h2h, { wins: 1, losses: 2, draws: 1, gws: 4 }, 'GW5 has no score, so it is skipped');
});

test('threat level follows the documented rule and explains itself', () => {
  const r = base();
  assert.deepEqual(r.threatBaseline, { value: 56.7, source: 'ME' });
  const t = (id) => r.rivals.find((x) => x.entryId === id).threat;
  assert.deepEqual([t(2).level, t(2).points, t(2).reasons], ['HIGH', 4, ['hot form (+18.3/GW)', 'Triple Captain left', 'Bench Boost left']]);
  assert.deepEqual([t(3).level, t(3).reasons], ['LOW', []]);
  assert.deepEqual([t(4).level, t(4).points], ['MEDIUM', 2], 'better form +1, free hit +1');
  const noChips = base({ chipsLeft: null });
  assert.equal(noChips.rivals.find((x) => x.entryId === 2).threat.complete, false);
  assert.equal(noChips.rivals.find((x) => x.entryId === 2).chipsLeft, null, 'unknown chips are not "none"');
  const noMe = base({ myEntryId: null });
  assert.equal(noMe.threatBaseline.source, 'GROUP_AVERAGE');
  assert.equal(noMe.closest, null);
  assert.equal(noMe.rivals.length, 4);
  assert.equal(noMe.rivals[0].h2h, null);
});

test('strategy lab: bandwagon, xPts from ep_next, FDR over the next 3 GWs', () => {
  const r = base();
  assert.deepEqual(r.strategy.bandwagon.map((b) => [b.elementId, b.count, b.boughtBy, b.ownedBy, b.of, b.iOwn]), [[20, 2, [2, 3], 1, 3, false], [1, 1, [4], 3, 3, true]], 'non-members ignored');
  const x = Object.fromEntries(r.strategy.xpts.map((m) => [m.entryId, [m.xPts, m.missing]]));
  assert.deepEqual(x[1], [24, 0], '11 × 2.0 + captain again');
  assert.deepEqual(x[2], [22, 1], 'unknown ep_next counted as missing, not zero');
  assert.deepEqual(x[4], [null, null]);
  const noEp = base({ players: players.map((p) => ({ ...p, epNextTenths: null })) });
  assert.deepEqual(noEp.strategy.xpts.find((m) => m.entryId === 1), { ...noEp.strategy.xpts.find((m) => m.entryId === 1), xPts: null, missing: 11 }, 'no estimates → unknown, not 0');
  assert.equal(r.strategy.xpts.at(-1).entryId, 4, 'unknown sorts last');
  assert.deepEqual(r.strategy.fdrWindow, [6, 7, 8]);
  const f = Object.fromEntries(r.strategy.fdr.map((m) => [m.entryId, m]));
  assert.ok(f[1].fdr >= 1 && f[1].fdr <= 5);
  assert.equal(f[4].fdr, null);
  assert.equal(f[4].fixtures, 0);
});

test('deterministic and excluded members left out', () => {
  assert.deepEqual(base(), base());
  const r = computeRivals({ ...{ event: 5, myEntryId: 1, managers, rows: rows(), squads: [], players, upcoming, transfersIn: [], chipsLeft }, members: members.map((m) => ({ ...m, isExcluded: m.entryId === 3 })) });
  assert.ok(!r.leaderboard.some((x) => x.entryId === 3));
  assert.equal(r.strategy.xpts.every((m) => m.xPts === null), true);
});
