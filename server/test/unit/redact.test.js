import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { redact, redactError } from '../../src/utils/redact.js';
import { errorHandler } from '../../src/middleware/errors.js';

// Step 12: nothing that reaches the logs carries a password, JWT, cookie,
// share token, tick secret, bcrypt hash or database credential.

const TOKEN = jwt.sign({ role: 'admin' }, 'k'.repeat(32));
const HASH = `$2b$12$${'a'.repeat(53)}`;
const SHARE = 'A'.repeat(43);

test('redact strips credentials and tokens, keeps the useful part', () => {
  assert.equal(redact('connect mongodb+srv://app:S3cr3t!@cluster0.x.mongodb.net/?w=majority'), 'connect mongodb+srv://***@cluster0.x.mongodb.net/?w=majority');
  assert.equal(redact(`token ${TOKEN} rejected`), 'token [jwt] rejected');
  assert.equal(redact(`Authorization: Bearer ${SHARE}`), 'Authorization: Bearer [redacted]');
  assert.equal(redact(`hash ${HASH}`), 'hash [bcrypt]');
  assert.equal(redact(`cookie fpl_admin=${SHARE}; Path=/api`), 'cookie fpl_admin=[redacted]; Path=/api');
  assert.equal(redact(`x-share-token: ${SHARE}`), 'x-share-token: [redacted]');
  assert.equal(redact('{"shareToken":"abc123","password":"hunter2"}'), '{"shareToken":"[redacted]","password":"[redacted]"}');
  assert.equal(redact(`X-Tick-Secret: ${'t'.repeat(32)}`), 'X-Tick-Secret: [redacted]');
  assert.equal(redact('plain message about group 5'), 'plain message about group 5');
});

test('redactError keeps name, code and stack frames but no secrets', () => {
  const err = Object.assign(new Error('auth failed for mongodb://u:pw@h/ with password=hunter2'), { code: 18 });
  const out = redactError(err);
  assert.match(out, /^Error \[18\]: auth failed for mongodb:\/\/\*\*\*@h\/ with password=\[redacted\]/);
  assert.match(out, /\n\s+at /);
  assert.ok(!out.includes('pw@') && !out.includes('hunter2'));
});

test('the 500 handler logs a redacted error with the path only (no query, body or cookies)', () => {
  const lines = [];
  const handler = errorHandler({ log: (...a) => lines.push(a.join(' ')) });
  const res = { status() { return this; }, json(b) { this.body = b; return this; } };
  const req = { method: 'POST', path: '/api/groups', originalUrl: `/api/groups?token=${SHARE}`, headers: { cookie: `fpl_admin=${TOKEN}` }, body: { password: 'hunter2' } };
  handler(new Error(`boom ${TOKEN}`), req, res, () => {});
  assert.deepEqual(res.body, { error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[POST \/api\/groups\] INTERNAL_ERROR: Error: boom \[jwt\]/);
  for (const s of [TOKEN, SHARE, 'hunter2']) assert.ok(!lines[0].includes(s));
});
