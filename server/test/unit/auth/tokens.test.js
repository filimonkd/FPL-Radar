import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { signAdminToken, verifyAdminToken, checkAdminPassword, newShareToken, SHARE_TOKEN } from '../../../src/auth/tokens.js';

const SECRET = 's'.repeat(40);

test('a signed admin token verifies to the admin principal', () => {
  assert.deepEqual(verifyAdminToken(SECRET, signAdminToken(SECRET)), { role: 'admin', actor: 'admin' });
});

test('tokens with a wrong secret, expired, unsigned or foreign claims are rejected', () => {
  assert.equal(verifyAdminToken('other-secret-xxxxxxxxxxxxxxxxxxxxxxxxx', signAdminToken(SECRET)), null);
  const past = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(verifyAdminToken(SECRET, signAdminToken(SECRET, { ttlSeconds: 60, nowSeconds: past })), null, 'expired');
  const none = jwt.sign({ role: 'admin' }, null, { algorithm: 'none', issuer: 'fpl-radar', audience: 'fpl-radar-admin', subject: 'admin' });
  assert.equal(verifyAdminToken(SECRET, none), null, 'alg none');
  const hs512 = jwt.sign({ role: 'admin' }, SECRET, { algorithm: 'HS512', issuer: 'fpl-radar', audience: 'fpl-radar-admin', subject: 'admin' });
  assert.equal(verifyAdminToken(SECRET, hs512), null, 'only HS256');
  const wrongAud = jwt.sign({ role: 'admin' }, SECRET, { algorithm: 'HS256', issuer: 'fpl-radar', audience: 'someone-else', subject: 'admin' });
  assert.equal(verifyAdminToken(SECRET, wrongAud), null);
  const viewerClaim = jwt.sign({ role: 'viewer' }, SECRET, { algorithm: 'HS256', issuer: 'fpl-radar', audience: 'fpl-radar-admin', subject: 'admin' });
  assert.equal(verifyAdminToken(SECRET, viewerClaim), null);
  for (const bad of [undefined, null, '', 'x'.repeat(5000), 'not.a.jwt']) assert.equal(verifyAdminToken(SECRET, bad), null);
});

test('the admin password is checked against a bcrypt hash only', async () => {
  const hash = await bcrypt.hash('correct horse battery', 4);
  assert.equal(await checkAdminPassword('correct horse battery', hash), true);
  assert.equal(await checkAdminPassword('wrong', hash), false);
  assert.equal(await checkAdminPassword('', hash), false);
  assert.equal(await checkAdminPassword('x'.repeat(300), hash), false);
  assert.equal(await checkAdminPassword(42, hash), false);
  assert.equal(await checkAdminPassword('correct horse battery', undefined), false, 'login disabled without a hash');
});

test('share tokens are 256-bit, URL-safe and unique', () => {
  const tokens = new Set(Array.from({ length: 200 }, newShareToken));
  assert.equal(tokens.size, 200);
  for (const t of tokens) assert.match(t, SHARE_TOKEN);
});
