import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSamples, sampleFetch, sampleFplClient, SAMPLE_BASE_URL } from '../../src/ops/sampleFpl.js';

// Step 14: the db:seed FPL source serves only committed samples, never the network.

const samples = loadSamples();
const fetchSample = sampleFetch(samples);
const get = async (path) => { const r = await fetchSample(`${SAMPLE_BASE_URL}${path}`); return { status: r.status, body: await r.json() }; };
const leagueId = samples.standings.league.id;
const [first, second] = samples.standings.standings.results;

test('serves the committed samples verbatim', async () => {
  assert.deepEqual((await get('/bootstrap-static/')).body, samples.bootstrap);
  assert.deepEqual((await get(`/leagues-classic/${leagueId}/standings/?page_standings=1`)).body, samples.standings);
  assert.deepEqual((await get(`/entry/${samples.entry.id}/history/`)).body, samples.history);
});

test('other league members reuse the sampled team under their own anonymized names; no numbers invented', async () => {
  const p = (await get(`/entry/${second.entry}/`)).body;
  assert.deepEqual([p.id, p.name, `${p.player_first_name} ${p.player_last_name}`], [second.entry, second.entry_name, second.player_name]);
  assert.equal(p.summary_overall_points, samples.entry.summary_overall_points);
  assert.deepEqual((await get(`/entry/${second.entry}/history/`)).body, samples.history);
  assert.ok((await get(`/entry/${second.entry}/transfers/`)).body.every((t) => t.entry === second.entry));
  assert.equal(first.entry, samples.entry.id);
});

test('anything not sampled is a 404, and non-sample URLs are refused outright', async () => {
  assert.equal((await get('/entry/1/')).status, 404, 'not a league member');
  assert.equal((await get(`/entry/${second.entry}/event/1/picks/`)).status, 404, 'only the sampled GW has picks');
  assert.equal((await get('/event/1/live/')).status, 404);
  assert.equal((await get(`/leagues-classic/${leagueId}/standings/?page_standings=2`)).status, 404);
  assert.equal((await get('/leagues-classic/1/standings/?page_standings=1')).status, 404);
  await assert.rejects(fetchSample('https://fantasy.premierleague.com/api/bootstrap-static/'), /refuses non-sample URL/);
});

test('the real FPL client (schemas, request log) reads the samples', async () => {
  const client = sampleFplClient(samples);
  try {
    const b = await client.getBootstrapStatic();
    assert.equal(b.events.length, 38, 'validated against the bootstrap schema');
    const picks = await client.getEntryPicks(samples.entry.id, samples.picks.entry_history.event);
    assert.equal(picks.picks.length, 15);
  } finally {
    client.close();
  }
});
