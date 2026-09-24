import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveShape, diffShapes } from '../../../../src/fpl/smoke/shape.js';
import { anonymize, createIdMap, findLeaks } from '../../../../src/fpl/smoke/anonymize.js';
import { classifyResponse, classifyLeagueAccess } from '../../../../src/fpl/smoke/classify.js';
import { evaluateHistory } from '../../../../src/fpl/smoke/reconcileProbe.js';
import { chipRulesVerdict } from '../../../../src/fpl/smoke/runSmoke.js';

test('deriveShape records types, nullability, optional keys and array lengths', () => {
  const shape = deriveShape([
    { a: 1, list: [{ x: null }, { x: 2, y: 's' }] },
    { a: 2, list: [] },
  ]);
  assert.deepEqual(shape.paths.a.types, ['number']);
  assert.deepEqual(shape.paths['list[].x'], { types: ['number'], nullable: true });
  assert.equal(shape.paths['list[].y'].optional, true);
  assert.deepEqual(shape.paths.list.length, { min: 0, max: 2 });
});

test('diffShapes reports added, removed and retyped paths', () => {
  const base = deriveShape([{ a: 1, b: 'x' }]);
  const cur = deriveShape([{ a: 'one', c: true }]);
  const d = diffShapes(base, cur);
  assert.deepEqual(d.added, ['c']);
  assert.deepEqual(d.removed, ['b']);
  assert.deepEqual(d.retyped.map((r) => r.path), ['a']);
});

test('anonymize replaces manager names and remaps IDs consistently', () => {
  const ids = createIdMap();
  const standings = anonymize('leagues-classic-standings', {
    league: { id: 5555, name: 'Secret League' },
    standings: { has_next: false, page: 1, results: [{ id: 1, entry: 123456, entry_name: 'Secret FC', player_name: 'Jane Doe' }] },
  }, ids);
  const entry = anonymize('entry', { id: 123456, name: 'Secret FC', player_first_name: 'Jane', player_last_name: 'Doe', player_region_name: 'Somewhere' }, ids);
  assert.equal(standings.standings.results[0].entry, entry.id);
  assert.equal(standings.league.name, 'League 1');
  assert.deepEqual(findLeaks({ standings, entry }, [5555, 123456, 'Secret League', 'Secret FC', 'Jane Doe', 'Somewhere']), []);
  assert.equal(ids.entryAlias(123456), 'E1');
});

test('findLeaks catches surviving identifiers', () => {
  assert.deepEqual(findLeaks({ entry: 123456, n: 'Jane Doe' }, [123456, 'Jane Doe']), [123456, 'Jane Doe']);
});

test('bootstrap samples are trimmed to 20 elements', () => {
  const b = anonymize('bootstrap-static', { elements: Array.from({ length: 50 }, (_, i) => ({ id: i })) }, createIdMap());
  assert.equal(b.elements.length, 20);
});

test('classifyResponse distinguishes network, blocked, updating, http and json', () => {
  assert.equal(classifyResponse({ error: new Error('x') }), 'NETWORK');
  assert.equal(classifyResponse({ status: 429 }), 'BLOCKED');
  assert.equal(classifyResponse({ status: 403, text: '<title>Just a moment...</title>' }), 'BLOCKED');
  assert.equal(classifyResponse({ status: 503, text: 'The game is being updated.' }), 'UPDATING');
  assert.equal(classifyResponse({ status: 404, contentType: 'application/json', text: '{}', json: {} }), 'HTTP');
  assert.equal(classifyResponse({ status: 200, contentType: 'text/html', text: '<html>' }), 'INVALID_JSON');
  assert.equal(classifyResponse({ status: 200, contentType: 'application/json', text: '{}', json: {} }), 'OK');
  // Egress proxy denial and public-endpoint 401/403 are blocked, not "HTTP".
  assert.equal(classifyResponse({ status: 403, contentType: 'text/plain', text: 'Host not in allowlist: fantasy.premierleague.com.' }), 'BLOCKED');
  assert.equal(classifyResponse({ status: 403, text: 'nope', denyReason: 'host_not_allowed' }), 'BLOCKED');
  assert.equal(classifyResponse({ status: 403, contentType: 'application/json', text: '{}', json: {} }), 'BLOCKED');
  // ...but on standings a JSON 403 is a real answer, left for classifyLeagueAccess.
  assert.equal(classifyResponse({ status: 403, contentType: 'application/json', text: '{}', json: {}, mayRequireAuth: true }), 'HTTP');
});

test('classifyLeagueAccess follows v0.2 §10', () => {
  const ok = { classification: 'OK', status: 200, json: { standings: { results: [{}] } } };
  assert.equal(classifyLeagueAccess(ok), 'OK');
  assert.equal(classifyLeagueAccess({ ...ok, json: { standings: { results: [] } } }), 'EMPTY');
  assert.equal(classifyLeagueAccess({ classification: 'HTTP', status: 404 }), 'NOT_FOUND');
  assert.equal(classifyLeagueAccess({ classification: 'HTTP', status: 401 }), 'AUTH_REQUIRED');
  assert.equal(classifyLeagueAccess({ classification: 'HTTP', status: 302, location: 'https://users.premierleague.com/accounts/login/' }), 'AUTH_REQUIRED');
  assert.equal(classifyLeagueAccess({ classification: 'NETWORK' }), 'NETWORK');
});

test('evaluateHistory applies the v0.2 §2 hypotheses', () => {
  const r = evaluateHistory([
    { event: 1, points: 60, total_points: 60, event_transfers_cost: 0 },
    { event: 2, points: 70, total_points: 126, event_transfers_cost: 4 }, // gross
    { event: 3, points: 70, total_points: 200, event_transfers_cost: 4 }, // neither → mismatch
    { event: 5, points: 50, total_points: 250, event_transfers_cost: 0 }, // gap → incomplete
  ]);
  assert.deepEqual(r.rows.map((x) => x.outcome), ['NO_COST', 'GROSS', 'MISMATCH', 'INCOMPLETE']);
  assert.equal(r.semantics, 'GROSS_BEFORE_HITS');
  assert.equal(evaluateHistory([{ event: 1, points: 66, total_points: 66, event_transfers_cost: 4 }]).semantics, 'NET_AFTER_HITS');
  assert.equal(evaluateHistory([{ event: 1, points: 50, total_points: 50, event_transfers_cost: 0 }]).semantics, 'UNVERIFIED');
});

test('chip rule validation rejects overlaps and bad windows', () => {
  assert.equal(chipRulesVerdict(undefined)[0], 'FAIL');
  assert.equal(chipRulesVerdict([{ name: 'bboost', number: 1, start_event: 1, stop_event: 19 }, { name: 'bboost', number: 1, start_event: 19, stop_event: 38 }])[0], 'FAIL');
  assert.equal(chipRulesVerdict([{ name: 'bboost', number: 1, start_event: 1, stop_event: 19 }, { name: 'bboost', number: 1, start_event: 20, stop_event: 38 }])[0], 'PASS');
});
