import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

// Boundary rule (architecture v0.3 §10): src/analytics must stay pure.
const ANALYTICS_DIR = new URL('../../src/analytics/', import.meta.url).pathname;

const FORBIDDEN_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]((?:mongoose|mongodb)(?:\/[^'"]*)?|(?:\.\.\/)+(?:db|models|repositories)(?:\/[^'"]*)?)['"]/g;
const PROCESS_ENV = /\bprocess\s*\.\s*env\b|\bprocess\s*\[\s*['"]env['"]\s*\]/;

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && /\.(c|m)?jsx?$/.test(e.name))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

// Comments are ignored so documentation can name the forbidden modules.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

export function violations(rawSource) {
  const source = stripComments(rawSource);
  const found = [...source.matchAll(FORBIDDEN_IMPORT)].map((m) => `imports ${m[1]}`);
  if (PROCESS_ENV.test(source)) found.push('reads process.env');
  return found;
}

test('detector flags every forbidden dependency', () => {
  assert.deepEqual(violations("import mongoose from 'mongoose';"), ['imports mongoose']);
  assert.deepEqual(violations("import { ObjectId } from 'mongodb';"), ['imports mongodb']);
  assert.deepEqual(violations("import x from '../db/connection.js';"), ['imports ../db/connection.js']);
  assert.deepEqual(violations("const m = await import('../../models/Group.js');"), ['imports ../../models/Group.js']);
  assert.deepEqual(violations("export * from '../repositories/groupRepo.js';"), ['imports ../repositories/groupRepo.js']);
  assert.deepEqual(violations('const u = process.env.MONGODB_URI;'), ['reads process.env']);
  assert.deepEqual(violations("import { sum } from './math.js';"), []);
  assert.deepEqual(violations('// never read process.env here\n/* or import mongoose */'), []);
});

test('src/analytics has no db imports and does not read process.env', async () => {
  const files = await sourceFiles(ANALYTICS_DIR);
  assert.ok(files.length > 0, 'expected at least src/analytics/index.js');
  const problems = [];
  for (const file of files) {
    for (const v of violations(await readFile(file, 'utf8'))) problems.push(`${relative(ANALYTICS_DIR, file)}: ${v}`);
  }
  assert.deepEqual(problems, []);
});
