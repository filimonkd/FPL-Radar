// npm run fpl:smoke -- --league <id> [--league <id>] --entry <id> [--entry <id>] [--gw <n>]
//                      [--update-baseline] [--out <dir>] [--delay-ms <n>] [--base-url <url>]
// Base URL: --base-url, else FPL_API_BASE_URL, else https://fantasy.premierleague.com/api.
//
// Real-FPL smoke test (architecture v0.2 §11, inherited by v0.3). Writes, under
// server/fpl-contract/<season>/ (or --out):
//   smoke-report.md            always
//   <endpoint>.shape.json      on first recording or with --update-baseline
//   <endpoint>.sample.json     anonymized, same condition
// Exit codes: 0 all pass · 1 schema break · 2 assumption failed/unverified · 3 network or blocked.
// Never fabricates samples: files are written only from real 2xx JSON responses.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runSmoke } from '../src/fpl/smoke/runSmoke.js';
import { deriveShape, diffShapes } from '../src/fpl/smoke/shape.js';
import { anonymize, createIdMap, findLeaks } from '../src/fpl/smoke/anonymize.js';
import { renderReport } from '../src/fpl/smoke/report.js';
import { resolveFplBaseUrl } from '../src/fpl/baseUrl.js';

const { values } = parseArgs({
  options: {
    league: { type: 'string', multiple: true, default: [] },
    entry: { type: 'string', multiple: true, default: [] },
    gw: { type: 'string' },
    out: { type: 'string' },
    'update-baseline': { type: 'boolean', default: false },
    'delay-ms': { type: 'string', default: '1000' },
    'base-url': { type: 'string' },
  },
});

const toId = (flag) => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--${flag} must be a positive integer, got "${v}"`);
    process.exit(64);
  }
  return n;
};

const leagues = values.league.map(toId('league'));
const entries = values.entry.map(toId('entry'));
const gw = values.gw ? toId('gw')(values.gw) : null;
if (!leagues.length || !entries.length) {
  console.warn('Warning: §11 expects both private leagues (--league) and at least one hit-taking --entry; missing inputs are reported as UNVERIFIED.');
}

let baseUrl;
try {
  baseUrl = resolveFplBaseUrl({ flag: values['base-url'] });
} catch (err) {
  console.error(err.message);
  process.exit(64);
}
console.log(`FPL API: ${baseUrl}`);

const ids = createIdMap();
const run = await runSmoke({
  leagues,
  entries,
  gw,
  ids,
  delayMs: Number(values['delay-ms']),
  baseUrl,
});

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = values.out ?? join(serverDir, 'fpl-contract', run.season ?? '2026-27');
await mkdir(outDir, { recursive: true });

// Real identifiers that must never appear in committed files.
const secrets = [...leagues, ...entries];
for (const body of run.bodies['entry'] ?? []) secrets.push(body.player_first_name, body.player_last_name, body.name);
for (const body of run.bodies['leagues-classic-standings'] ?? []) {
  secrets.push(body.league?.name);
  for (const r of body.standings?.results ?? []) secrets.push(r.entry, r.entry_name, r.player_name);
}

const shapes = {};
const diffs = {};
const samples = {};
for (const [endpoint, bodies] of Object.entries(run.bodies)) {
  const anonymized = bodies.map((b) => anonymize(endpoint, b, ids, { liveKeepIds: run.liveKeepIds }));
  shapes[endpoint] = deriveShape(anonymized);
  samples[endpoint] = anonymized[0];
  const shapeFile = join(outDir, `${endpoint}.shape.json`);
  const baseline = existsSync(shapeFile) ? JSON.parse(await readFile(shapeFile, 'utf8')) : null;
  diffs[endpoint] = { baseline: Boolean(baseline), ...diffShapes(baseline, shapes[endpoint]) };
}

const leaks = Object.entries(samples).flatMap(([endpoint, s]) => findLeaks(s, secrets).map((l) => `${endpoint}: ${typeof l === 'number' ? 'an ID' : 'a name'}`));
if (leaks.length) {
  console.error(`Refusing to write samples: anonymization left identifying data (${leaks.join('; ')}).`);
  process.exit(1);
}

let baselineWritten = false;
for (const endpoint of Object.keys(shapes)) {
  const shapeFile = join(outDir, `${endpoint}.shape.json`);
  if (!existsSync(shapeFile) || values['update-baseline']) {
    await writeFile(shapeFile, `${JSON.stringify(shapes[endpoint], null, 2)}\n`);
    await writeFile(join(outDir, `${endpoint}.sample.json`), `${JSON.stringify(samples[endpoint], null, 2)}\n`);
    baselineWritten = true;
  }
}

await writeFile(join(outDir, 'smoke-report.md'), renderReport(run, { shapes, diffs, baselineWritten }));
console.log(`smoke-report: ${join(outDir, 'smoke-report.md')}`);
console.log(`exit ${run.exitCode}: ${run.exitReason}`);
process.exit(run.exitCode);
