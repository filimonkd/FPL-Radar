import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validate } from '../../../src/fpl/validate.js';
import { createFplClient, FplErrorKind } from '../../../src/fpl/index.js';
import { fakeClock, jsonResponse, scriptedFetch, minimalBootstrap, testOptions } from './helpers.js';

const paths = (result) => result.issues.map((i) => i.split(':')[0]);

test('validator reports paths for type mismatches and missing fields', () => {
  const schema = z.looseObject({ id: z.int(), tags: z.array(z.string()), meta: z.looseObject({ ok: z.boolean() }) });
  assert.deepEqual(validate(schema, { id: 1, tags: ['a'], meta: { ok: true } }).issues, []);
  const bad = validate(schema, { id: '1', tags: ['a', 2], meta: {} });
  assert.equal(bad.ok, false);
  assert.deepEqual(paths(bad), ['id', 'tags[1]', 'meta.ok']);
  assert.deepEqual(paths(validate(schema, [])), ['<root>']);
});

test('validator allows nullables and keeps unknown fields', () => {
  const schema = z.looseObject({ kickoff: z.string().nullable() });
  const result = validate(schema, { kickoff: null, extra: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { kickoff: null, extra: 1 });
  assert.deepEqual(paths(validate(schema, { kickoff: 5 })), ['kickoff']);
});

test('validator caps the number of reported issues', () => {
  const result = validate(z.array(z.int()), Array.from({ length: 100 }, () => 'x'));
  assert.equal(result.issues.length, 20);
});

test('validator rejects non-finite numbers and non-integer ints', () => {
  assert.equal(validate(z.number(), NaN).ok, false);
  assert.equal(validate(z.number(), Infinity).ok, false);
  assert.equal(validate(z.int(), 1.5).ok, false);
});

// Synthetic payloads matching each schema, keyed by client call.
const cases = [
  {
    name: 'bootstrap-static',
    call: (c) => c.getBootstrapStatic(),
    url: '/bootstrap-static/',
    valid: minimalBootstrap(),
    invalid: { ...minimalBootstrap(), elements: [{ id: 1, web_name: 'P', team: '1', element_type: 3, now_cost: 50 }] },
  },
  {
    name: 'fixtures (all)',
    call: (c) => c.getFixtures(),
    url: '/fixtures/',
    valid: [{ id: 1, event: null, team_h: 1, team_a: 2, kickoff_time: null, finished: false, team_h_score: null, team_a_score: null }],
    invalid: { fixtures: [] },
  },
  {
    name: 'fixtures (by event)',
    call: (c) => c.getFixtures({ event: 3 }),
    url: '/fixtures/?event=3',
    valid: [{ id: 1, event: 3, team_h: 1, team_a: 2, kickoff_time: '2000-01-01T00:00:00Z', finished: true, team_h_score: 2, team_a_score: 0 }],
    invalid: [{ id: 1 }],
  },
  {
    name: 'event live',
    call: (c) => c.getEventLive(4),
    url: '/event/4/live/',
    valid: { elements: [{ id: 1, stats: { minutes: 90, total_points: 6 } }] },
    invalid: { elements: [{ id: 1, stats: null }] },
  },
  {
    name: 'element summary',
    call: (c) => c.getElementSummary(10),
    url: '/element-summary/10/',
    valid: { fixtures: [{ id: 1 }], history: [{ element: 10, round: 1 }] },
    invalid: { fixtures: [] },
  },
  {
    name: 'entry',
    call: (c) => c.getEntry(99),
    url: '/entry/99/',
    valid: { id: 99, name: 'Synthetic XI' },
    invalid: { id: 99 },
  },
  {
    name: 'entry history',
    call: (c) => c.getEntryHistory(99),
    url: '/entry/99/history/',
    valid: { current: [{ event: 1, points: 50, total_points: 50 }], past: [] },
    invalid: { current: [{ event: 1, points: '50', total_points: 50 }], past: [] },
  },
  {
    name: 'entry picks',
    call: (c) => c.getEntryPicks(99, 2),
    url: '/entry/99/event/2/picks/',
    valid: {
      picks: [{ element: 1, position: 1, multiplier: 2, is_captain: true, is_vice_captain: false }],
      entry_history: { event: 2, points: 60 },
    },
    invalid: { picks: [], entry_history: null },
  },
  {
    name: 'entry transfers',
    call: (c) => c.getEntryTransfers(99),
    url: '/entry/99/transfers/',
    valid: [{ element_in: 1, element_out: 2, event: 3, time: '2000-01-01T00:00:00Z' }],
    invalid: [{ element_in: 1, element_out: 2, event: 3 }],
  },
  {
    name: 'classic league standings',
    call: (c) => c.getClassicLeagueStandings(314, { page: 2 }),
    url: '/leagues-classic/314/standings/?page_standings=2',
    valid: {
      league: { id: 314, name: 'Synthetic League' },
      standings: { has_next: false, page: 2, results: [{ entry: 1, entry_name: 'A', rank: 1, total: 100 }] },
    },
    invalid: { league: { id: 314, name: 'L' }, standings: { has_next: 'no', page: 2, results: [] } },
  },
];

for (const c of cases) {
  test(`${c.name}: requests ${c.url} and accepts a valid payload`, async () => {
    const fetch = scriptedFetch([jsonResponse(c.valid)]);
    const client = createFplClient(testOptions(fakeClock(), { fetch }));
    assert.deepEqual(await c.call(client), c.valid);
    assert.equal(fetch.calls[0].url, `https://fpl.test/api${c.url}`);
  });

  test(`${c.name}: rejects an invalid payload with a validation error`, async () => {
    const fetch = scriptedFetch([jsonResponse(c.invalid)]);
    const client = createFplClient(testOptions(fakeClock(), { fetch }));
    await assert.rejects(c.call(client), (err) => {
      assert.equal(err.kind, FplErrorKind.VALIDATION);
      assert.equal(err.retryable, false);
      assert.ok(err.issues.length > 0);
      return true;
    });
    assert.equal(fetch.calls.length, 1);
  });
}

test('validation failures do not trip the circuit breaker', async () => {
  const fetch = scriptedFetch([jsonResponse({})]);
  const client = createFplClient(testOptions(fakeClock(), { fetch, breaker: { failureThreshold: 1 }, ttls: { entry: 0 } }));
  for (let i = 0; i < 3; i++) await assert.rejects(client.getEntry(1), { kind: FplErrorKind.VALIDATION });
  assert.equal(client.circuitState, 'closed');
});
