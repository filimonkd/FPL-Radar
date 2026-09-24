import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, contentHash, sha256 } from '../../src/utils/canonical.js';
import * as dbCanonical from '../../src/db/canonical.js';

test('key order does not change canonical JSON or hash', () => {
  const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'x' } };
  const b = { a: { c: 'x', d: [3, { x: 2, y: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(contentHash(a), contentHash(b));
});

test('array order is significant; undefined members dropped; Dates and Maps normalized', () => {
  assert.notEqual(contentHash([1, 2]), contentHash([2, 1]));
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonicalJson({ t: new Date('2026-09-22T19:04:11Z') }), '{"t":"2026-09-22T19:04:11.000Z"}');
  assert.equal(canonicalJson(new Map([[2, 'b'], [1, 'a']])), '{"1":"a","2":"b"}');
});

test('rejects values JSON cannot represent', () => {
  assert.throws(() => canonicalJson({ x: NaN }), TypeError);
  assert.throws(() => canonicalJson({ x: Infinity }), TypeError);
  assert.throws(() => canonicalJson({ x: () => 1 }), TypeError);
});

test('sha256 format and the db/ re-export', () => {
  assert.match(sha256('abc'), /^sha256:[a-f0-9]{64}$/);
  assert.equal(sha256('abc'), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(dbCanonical.contentHash({ a: 1 }), contentHash({ a: 1 }));
});
