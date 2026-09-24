import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envSourceHint, describeValue, readDotEnv } from '../../src/config/envSource.js';

const URI = 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';

test('no hint when the value in use matches .env', () => {
  assert.equal(envSourceHint('MONGODB_URI', { env: { MONGODB_URI: URI }, fileVars: { MONGODB_URI: URI } }), null);
});

test('flags a system variable that overrides .env', () => {
  const hint = envSourceHint('MONGODB_URI', { env: { MONGODB_URI: 'localhost:27017' }, fileVars: { MONGODB_URI: URI } });
  assert.match(hint, /overrides \.env/);
  assert.match(hint, /Remove-Item Env:MONGODB_URI/);
});

test('flags values that are not in .env at all', () => {
  assert.match(envSourceHint('MONGODB_URI', { env: { MONGODB_URI: URI }, fileVars: {} }), /not set in \.env/);
  assert.match(envSourceHint('MONGODB_URI', { env: { MONGODB_URI: URI }, fileVars: null }), /no \.env file/);
});

test('describeValue shows only the scheme, never credentials', () => {
  assert.equal(describeValue('mongodb+srv://user:secret@host/db'), 'starts with "mongodb+srv://" (length 33)');
  assert.equal(describeValue(' "mongodb://x"'), 'starts with " \\"mongodb://" (length 14)');
  assert.ok(!describeValue('mongodb://user:secret@h').includes('secret'));
});

test('readDotEnv tolerates a UTF-8 BOM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envsrc-'));
  const file = join(dir, '.env');
  writeFileSync(file, `\uFEFFMONGODB_URI=${URI}\n`);
  assert.equal(readDotEnv(file).MONGODB_URI, URI);
  assert.equal(readDotEnv(join(dir, 'missing')), null);
});
