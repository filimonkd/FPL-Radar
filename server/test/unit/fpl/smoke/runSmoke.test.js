import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSmoke, EXIT } from '../../../../src/fpl/smoke/runSmoke.js';
import { createIdMap } from '../../../../src/fpl/smoke/anonymize.js';
import { renderReport } from '../../../../src/fpl/smoke/report.js';
import { world, worldFetch, LEAGUE, ENTRY, GW } from './syntheticFpl.js';

const NOW = new Date(Date.UTC(2026, 7, 31));

function smoke(fetch, extra = {}) {
  return runSmoke({
    fetch,
    baseUrl: 'https://fpl.test/api',
    leagues: [LEAGUE],
    entries: [ENTRY],
    ids: createIdMap(),
    now: () => NOW,
    sleep: async () => {},
    ...extra,
  });
}
const byId = (run, id) => run.checks.filter((c) => c.id === id);

test('consistent world: all Step 2 checks pass, V3 is deferred, exit 0', async () => {
  const run = await smoke(worldFetch(world({ now: NOW })));
  const notPass = run.checks.filter((c) => c.status !== 'PASS' && c.id !== 'V3');
  assert.deepEqual(notPass, []);
  assert.equal(byId(run, 'V3')[0].status, 'DEFERRED_TO_STEP_3');
  assert.equal(run.exitCode, EXIT.PASS);
  assert.match(run.exitReason, /1 deferred to Step 3/);
  const md = renderReport(run, {});
  assert.match(md, /\| V3 \|.*\*\*DEFERRED_TO_STEP_3\*\*/);
  assert.match(md, /1 DEFERRED_TO_STEP_3/);
  assert.equal(run.gw, GW);
  assert.equal(run.gwSource, 'latest data_checked event');
  assert.equal(run.season, '2026-27');
});

test('reconciliation semantics are proven from a hit row', async () => {
  const run = await smoke(worldFetch(world({ now: NOW })));
  assert.equal(run.reconciliation.combined.semantics, 'GROSS_BEFORE_HITS');
  assert.equal(byId(run, 'H3')[0].status, 'PASS');
});

test('network failure: exit 3 and every unreachable endpoint is listed', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  const run = await smoke(fetch, { gw: GW });
  assert.equal(run.exitCode, EXIT.NETWORK_OR_BLOCKED);
  const paths = run.requests.map((r) => r.path);
  for (const p of ['/bootstrap-static/', '/fixtures/', '/event-status/', `/event/${GW}/live/`]) assert.ok(paths.includes(p), p);
  assert.ok(run.requests.every((r) => r.classification === 'NETWORK'));
  assert.equal(Object.keys(run.bodies).length, 0, 'no bodies means no samples can be written');
  assert.match(run.exitReason, /ECONNREFUSED/);
});

test('egress proxy denial on every request → exit 3, nothing classified as AUTH_REQUIRED', async () => {
  const denied = () => new Response('Host not in allowlist: fantasy.premierleague.com.', {
    status: 403, headers: { 'content-type': 'text/plain', 'x-deny-reason': 'host_not_allowed' },
  });
  const run = await smoke(async () => denied(), { gw: GW });
  assert.equal(run.exitCode, EXIT.NETWORK_OR_BLOCKED);
  assert.ok(run.requests.every((r) => r.classification === 'BLOCKED'));
  assert.notEqual(run.checks.find((c) => c.id === 'L1').status, 'FAIL');
});

test('an arbitrary upstream 403 is reported as HTTP, not BLOCKED', async () => {
  const forbidden = new Response('{"detail":"Forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } });
  const run = await smoke(worldFetch(world({ now: NOW }), { '/event-status/': forbidden }));
  const req = run.requests.find((r) => r.endpoint === 'event-status');
  assert.equal(req.classification, 'HTTP');
  assert.equal(req.status, 403);
  assert.notEqual(run.exitCode, EXIT.NETWORK_OR_BLOCKED);
  assert.equal(byId(run, 'S1')[0].status, 'UNVERIFIED');
});

test('Cloudflare challenge is classified as blocked (exit 3)', async () => {
  const challenge = new Response('<html><title>Just a moment...</title></html>', {
    status: 403, headers: { 'content-type': 'text/html', 'cf-ray': 'x' },
  });
  const run = await smoke(worldFetch(world({ now: NOW }), { '/bootstrap-static/': challenge }));
  assert.equal(run.exitCode, EXIT.NETWORK_OR_BLOCKED);
  assert.equal(run.requests[0].classification, 'BLOCKED');
});

test('private league needing login → AUTH_REQUIRED, no login attempted', async () => {
  const forbidden = new Response('{"detail":"Authentication credentials were not provided."}', {
    status: 403, headers: { 'content-type': 'application/json' },
  });
  const fetch = worldFetch(world({ now: NOW }), { [`/leagues-classic/${LEAGUE}/standings/?page_standings=1`]: forbidden });
  const run = await smoke(fetch);
  const l1 = byId(run, 'L1')[0];
  assert.equal(l1.status, 'FAIL');
  assert.match(l1.detail, /AUTH_REQUIRED.*MANUAL/);
  assert.ok(!fetch.calls.some((p) => /login/i.test(p)));
  assert.equal(run.exitCode, EXIT.ASSUMPTION_FAILED);
});

test('schema break is recorded, not hidden (exit 1)', async () => {
  const data = world({ now: NOW });
  data[`/entry/${ENTRY}/transfers/`] = [{ element_in: 3, element_out: 16, event: 2 }]; // no time
  const run = await smoke(worldFetch(data));
  assert.equal(run.exitCode, EXIT.SCHEMA_BREAK);
  assert.ok(run.schema['entry-transfers'][0].issues.some((i) => i.includes('time')));
});

test('"game is being updated" body is recorded and treated as unreachable', async () => {
  const updating = new Response('The game is being updated.', { status: 503, headers: { 'content-type': 'text/html' } });
  const run = await smoke(worldFetch(world({ now: NOW }), { '/event-status/': updating }));
  const req = run.requests.find((r) => r.endpoint === 'event-status');
  assert.equal(req.gameUpdating, true);
  assert.equal(run.exitCode, EXIT.NETWORK_OR_BLOCKED);
});

test('report uses aliases only and never real IDs or names', async () => {
  const ids = createIdMap();
  const run = await smoke(worldFetch(world({ now: NOW })), { ids });
  const md = renderReport(run, {});
  assert.ok(!md.includes(String(ENTRY)) && !md.includes(String(LEAGUE)));
  assert.ok(!/Real (Team|Person|League)|Realfirst|Reallast/.test(md));
  assert.match(md, /E1/);
  assert.match(md, /L1/);
});
