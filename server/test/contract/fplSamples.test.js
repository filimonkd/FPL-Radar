import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schemas from '../../src/fpl/schemas.js';
import { validate } from '../../src/fpl/validate.js';
import { ENDPOINT_SCHEMA } from '../../src/fpl/smoke/runSmoke.js';
import { deriveShape } from '../../src/fpl/smoke/shape.js';

// Contract tests (architecture v0.2 §16): every committed, anonymized FPL
// sample must parse with its zod schema and fit its recorded shape.

const CONTRACT_DIR = fileURLToPath(new URL('../../fpl-contract/', import.meta.url));

async function samples() {
  if (!existsSync(CONTRACT_DIR)) return [];
  const out = [];
  for (const season of await readdir(CONTRACT_DIR)) {
    const dir = join(CONTRACT_DIR, season);
    for (const file of await readdir(dir).catch(() => [])) {
      if (file.endsWith('.sample.json')) out.push({ season, endpoint: file.replace('.sample.json', ''), dir });
    }
  }
  return out;
}

const found = await samples();

if (found.length === 0) {
  test('FPL contract samples', { skip: 'no samples committed yet (Step 2 smoke test has not recorded real responses)' }, () => {});
}

for (const { season, endpoint, dir } of found) {
  test(`${season}/${endpoint}: sample parses with its zod schema`, async () => {
    const sample = JSON.parse(await readFile(join(dir, `${endpoint}.sample.json`), 'utf8'));
    const schemaName = ENDPOINT_SCHEMA[endpoint];
    assert.ok(schemaName, `no schema mapped for ${endpoint}`);
    const { ok, issues } = validate(schemas[schemaName], sample);
    assert.ok(ok, issues.join('\n'));
  });

  test(`${season}/${endpoint}: sample fits the recorded shape`, async () => {
    const sample = JSON.parse(await readFile(join(dir, `${endpoint}.sample.json`), 'utf8'));
    const recorded = JSON.parse(await readFile(join(dir, `${endpoint}.shape.json`), 'utf8'));
    for (const [path, node] of Object.entries(deriveShape([sample]).paths)) {
      const r = recorded.paths[path];
      assert.ok(r, `path ${path} missing from recorded shape`);
      for (const t of node.types) assert.ok(r.types.includes(t), `${path}: type ${t} not in recorded ${r.types}`);
      if (node.nullable) assert.ok(r.nullable, `${path}: null not recorded as nullable`);
    }
  });
}
