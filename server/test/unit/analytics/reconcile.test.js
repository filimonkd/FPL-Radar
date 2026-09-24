import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSeason } from '../../../src/analytics/reconcile.js';

const hist = (event, points, totalPoints, eventTransfersCost = 0) => ({ event, points, totalPoints, eventTransfersCost });
const run = (historyRows, over = {}) => reconcileSeason({ season: '2026-27', entryId: 1, historyRows, seasonSemantics: 'UNVERIFIED', ...over });
const rowFor = (res, event) => res.rows.find((r) => r.event === event);

test('no hit: Tprev 50, R 60, C 0, T 110 → RECONCILED_NO_COST, net 60, gross 60', () => {
  const r = rowFor(run([hist(1, 50, 50), hist(2, 60, 110)]), 2);
  assert.equal(r.reconciliationStatus, 'RECONCILED_NO_COST');
  assert.equal(r.netGwPoints, 60);
  assert.equal(r.grossGwPoints, 60);
  assert.equal(r.reconciliationDetail.hypothesis, 'BOTH');
});

test('gross semantics: Tprev 100, R 70, C 4, T 166 → RECONCILED, GROSS, net 66, gross 70', () => {
  const res = run([hist(1, 100, 100), hist(2, 70, 166, 4)]);
  const r = rowFor(res, 2);
  assert.equal(r.reconciliationStatus, 'RECONCILED');
  assert.equal(r.reconciliationDetail.hypothesis, 'GROSS');
  assert.equal(r.pointsSemantics, 'GROSS_BEFORE_HITS');
  assert.deepEqual([r.netGwPoints, r.grossGwPoints], [66, 70]);
  assert.deepEqual(res.evidence, { gross: 1, net: 0 });
});

test('net semantics: Tprev 100, R 66, C 4, T 166 → RECONCILED, NET, net 66, gross 70', () => {
  const res = run([hist(1, 100, 100), hist(2, 66, 166, 4)]);
  const r = rowFor(res, 2);
  assert.equal(r.reconciliationStatus, 'RECONCILED');
  assert.equal(r.pointsSemantics, 'NET_AFTER_HITS');
  assert.deepEqual([r.netGwPoints, r.grossGwPoints], [66, 70]);
  assert.deepEqual(res.evidence, { gross: 0, net: 1 });
});

// v0.2 §16 lists "Tprev 100, R 70, C 4, T 170 → MISMATCH", but there Δ = 70 = R,
// so H_net holds under §2 and the row reconciles as NET. §2 is authoritative;
// a true mismatch needs Δ to match neither hypothesis (T 180 → Δ 80).
test('mismatch: Tprev 100, R 70, C 4, T 180 → MISMATCH, net null, gross null', () => {
  const r = rowFor(run([hist(1, 100, 100), hist(2, 70, 180, 4)]), 2);
  assert.equal(r.reconciliationStatus, 'MISMATCH');
  assert.equal(r.netGwPoints, null);
  assert.equal(r.grossGwPoints, null);
  assert.equal(r.reconciliationDetail.hypothesis, 'NONE');
});

test('spec example T 170 (Δ = R) is NET evidence under §2, not a mismatch', () => {
  const r = rowFor(run([hist(1, 100, 100), hist(2, 70, 170, 4)]), 2);
  assert.equal(r.reconciliationStatus, 'RECONCILED');
  assert.equal(r.pointsSemantics, 'NET_AFTER_HITS');
  assert.equal(rowFor(run([hist(1, 100, 100), hist(2, 70, 170, 4)], { seasonSemantics: 'GROSS_BEFORE_HITS' }), 2).reconciliationStatus, 'SEMANTICS_CONFLICT');
});

test('semantics conflict: season GROSS verified; row matches NET only → SEMANTICS_CONFLICT', () => {
  const r = rowFor(run([hist(1, 100, 100), hist(2, 66, 166, 4)], { seasonSemantics: 'GROSS_BEFORE_HITS' }), 2);
  assert.equal(r.reconciliationStatus, 'SEMANTICS_CONFLICT');
  assert.equal(r.netGwPoints, null);
});

test('conflicting proofs within an UNVERIFIED season conflict; C = 0 rows stay valid', () => {
  const res = run([hist(1, 100, 100), hist(2, 70, 166, 4), hist(3, 66, 232, 4), hist(4, 50, 282)]);
  assert.deepEqual(res.rows.map((r) => r.reconciliationStatus), ['RECONCILED_NO_COST', 'SEMANTICS_CONFLICT', 'SEMANTICS_CONFLICT', 'RECONCILED_NO_COST']);
});

test('CONFLICTED season marks every hit row SEMANTICS_CONFLICT', () => {
  const r = rowFor(run([hist(1, 100, 100), hist(2, 70, 166, 4)], { seasonSemantics: 'CONFLICTED' }), 2);
  assert.equal(r.reconciliationStatus, 'SEMANTICS_CONFLICT');
});

test('first row: first event of entry, no earlier row → Tprev 0 → reconciled', () => {
  const r = rowFor(run([hist(3, 55, 55)]), 3);
  assert.equal(r.previousTotalPoints, 0);
  assert.equal(r.reconciliationStatus, 'RECONCILED_NO_COST');
});

test('gap: rows for GW 3 and 5, not 4 → GW 5 INCOMPLETE', () => {
  const res = run([hist(3, 55, 55), hist(5, 60, 115)]);
  assert.equal(rowFor(res, 5).reconciliationStatus, 'INCOMPLETE');
  assert.equal(rowFor(res, 5).previousTotalPoints, null);
});

test('source disagreement: history R 70, picks 68 at DATA_CHECKED → SOURCE_DISAGREEMENT', () => {
  const r = rowFor(run([hist(1, 100, 100), hist(2, 70, 170)], {
    picksPoints: new Map([[2, 68]]), eventStates: new Map([[2, 'DATA_CHECKED']]),
  }), 2);
  assert.equal(r.reconciliationStatus, 'SOURCE_DISAGREEMENT');
  assert.equal(r.reconciliationDetail.picksPoints, 68);
});

test('picks disagreement before DATA_CHECKED does not block reconciliation', () => {
  const r = rowFor(run([hist(1, 100, 100), hist(2, 70, 170)], {
    picksPoints: new Map([[2, 68]]), eventStates: new Map([[2, 'LIVE']]),
  }), 2);
  assert.equal(r.reconciliationStatus, 'RECONCILED_NO_COST');
});

test('keyed by event: rows passed out of order → same output as sorted', () => {
  const rows = [hist(1, 50, 50), hist(2, 70, 116, 4), hist(3, 60, 176)];
  assert.deepEqual(run([rows[2], rows[0], rows[1]]), run(rows));
});

test('invariants: one row per event; net !== null ⇔ reconciled', () => {
  const res = run([hist(1, 50, 50), hist(2, 70, 116, 4), hist(3, 70, 999, 4), hist(5, 1, 1)]);
  assert.equal(res.rows.length, 4);
  for (const r of res.rows) {
    const reconciled = ['RECONCILED', 'RECONCILED_NO_COST'].includes(r.reconciliationStatus);
    assert.equal(r.netGwPoints !== null, reconciled, `GW${r.event}`);
    assert.equal(r.grossGwPoints !== null, reconciled, `GW${r.event}`);
  }
});

test('never throws on empty or odd input', () => {
  assert.deepEqual(run([]).rows, []);
  assert.doesNotThrow(() => run([hist(1, NaN, 10)]));
});
