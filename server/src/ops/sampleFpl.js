import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFplClient } from '../fpl/index.js';

// A fake FPL API that serves only the committed, anonymized contract samples
// (fpl-contract/<season>/*.sample.json, v0.2 §11), for `npm run db:seed`
// (v0.3 §11). It never calls the real FPL API.
//
// The samples hold one fully sampled team (entry.sample.json and its history,
// picks and transfers) plus a league table of anonymized members. So every
// other league member is served as a copy of that sampled team, under its own
// anonymized ID and names from the league table. No points are invented:
// every number comes from a sample file. Anything not sampled is a 404, as FPL
// would answer.

export const SAMPLE_BASE_URL = 'https://fpl-samples.invalid/api';

export function loadSamples(season = '2026-27') {
  const dir = fileURLToPath(new URL(`../../fpl-contract/${season}/`, import.meta.url));
  const read = (name) => JSON.parse(readFileSync(`${dir}${name}.sample.json`, 'utf8'));
  return {
    bootstrap: read('bootstrap-static'),
    fixtures: read('fixtures'),
    live: read('event-live'),
    eventStatus: read('event-status'),
    standings: read('leagues-classic-standings'),
    entry: read('entry'),
    history: read('entry-history'),
    picks: read('entry-picks'),
    transfers: read('entry-transfers'),
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => json({ detail: 'Not found.' }, 404);

export function sampleFetch(samples) {
  const s = samples;
  const leagueId = s.standings.league.id;
  const members = new Map(s.standings.standings.results.map((r) => [r.entry, r]));
  const livePicksEvent = s.picks.entry_history.event;
  const liveEvent = s.live.elements.length ? livePicksEvent : null;

  function profile(entryId) {
    const row = members.get(entryId);
    if (!row) return null;
    const cut = row.player_name.lastIndexOf(' ');
    return {
      ...s.entry,
      id: entryId,
      name: row.entry_name,
      player_first_name: cut > 0 ? row.player_name.slice(0, cut) : row.player_name,
      player_last_name: cut > 0 ? row.player_name.slice(cut + 1) : '',
    };
  }

  const handlers = [
    [/^\/bootstrap-static\/$/, () => s.bootstrap],
    [/^\/fixtures\/$/, () => s.fixtures],
    [/^\/fixtures\/\?event=(\d+)$/, (m) => s.fixtures.filter((f) => f.event === Number(m[1]))],
    [/^\/event\/(\d+)\/live\/$/, (m) => (Number(m[1]) === liveEvent ? s.live : undefined)],
    [/^\/event-status\/$/, () => s.eventStatus],
    [/^\/leagues-classic\/(\d+)\/standings\/\?page_standings=(\d+)$/, (m) => (Number(m[1]) === leagueId && m[2] === '1' ? s.standings : undefined)],
    [/^\/entry\/(\d+)\/$/, (m) => profile(Number(m[1])) ?? undefined],
    [/^\/entry\/(\d+)\/history\/$/, (m) => (members.has(Number(m[1])) ? s.history : undefined)],
    [/^\/entry\/(\d+)\/event\/(\d+)\/picks\/$/, (m) => (members.has(Number(m[1])) && Number(m[2]) === livePicksEvent ? s.picks : undefined)],
    [/^\/entry\/(\d+)\/transfers\/$/, (m) => (members.has(Number(m[1])) ? s.transfers.map((t) => ({ ...t, entry: Number(m[1]) })) : undefined)],
  ];

  return async (url) => {
    const path = url.startsWith(SAMPLE_BASE_URL) ? url.slice(SAMPLE_BASE_URL.length) : null;
    if (path === null) throw new Error(`sample FPL source refuses non-sample URL: ${url}`);
    for (const [re, h] of handlers) {
      const m = re.exec(path);
      if (m) {
        const body = h(m);
        return body === undefined ? notFound() : json(body);
      }
    }
    return notFound();
  };
}

/** A real FPL client (same parsing, validation and request log) over the samples. */
export function sampleFplClient(samples = loadSamples()) {
  return createFplClient({
    baseUrl: SAMPLE_BASE_URL,
    fetch: sampleFetch(samples),
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
}
