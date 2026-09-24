import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFplBaseUrl, DEFAULT_FPL_API_BASE_URL } from '../../../src/fpl/baseUrl.js';
import { parseEnv } from '../../../src/config/env.js';

test('defaults to the public FPL API', () => {
  assert.equal(resolveFplBaseUrl({ env: {} }), 'https://fantasy.premierleague.com/api');
  assert.equal(DEFAULT_FPL_API_BASE_URL, 'https://fantasy.premierleague.com/api');
});

test('FPL_API_BASE_URL overrides the default; blank is ignored; trailing slash trimmed', () => {
  assert.equal(resolveFplBaseUrl({ env: { FPL_API_BASE_URL: 'http://localhost:9000/api/' } }), 'http://localhost:9000/api');
  assert.equal(resolveFplBaseUrl({ env: { FPL_API_BASE_URL: '  ' } }), DEFAULT_FPL_API_BASE_URL);
});

test('an explicit flag wins over FPL_API_BASE_URL', () => {
  assert.equal(resolveFplBaseUrl({ flag: 'https://mirror.test/api', env: { FPL_API_BASE_URL: 'https://other.test/api' } }), 'https://mirror.test/api');
});

test('rejects non-http(s) values', () => {
  assert.throws(() => resolveFplBaseUrl({ env: { FPL_API_BASE_URL: 'ftp://x.test' } }), /FPL_API_BASE_URL must be an http\(s\) URL/);
  assert.throws(() => resolveFplBaseUrl({ env: { FPL_API_BASE_URL: 'not a url' } }), /FPL_API_BASE_URL/);
});

test('env contract includes FPL_API_BASE_URL with the default', () => {
  const base = { MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true', MONGODB_DB: 'd', JWT_SECRET: 's' };
  assert.equal(parseEnv(base).FPL_API_BASE_URL, DEFAULT_FPL_API_BASE_URL);
  assert.equal(parseEnv({ ...base, FPL_API_BASE_URL: 'https://mirror.test/api/' }).FPL_API_BASE_URL, 'https://mirror.test/api');
  assert.throws(() => parseEnv({ ...base, FPL_API_BASE_URL: 'ftp://x' }), /FPL_API_BASE_URL/);
});
