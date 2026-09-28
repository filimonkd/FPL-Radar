import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, EnvError } from '../../src/config/env.js';

const valid = {
  PORT: '4000',
  MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true',
  MONGODB_DB: 'fpl_rival_test',
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret',
};

test('valid env parses into a frozen, typed config', () => {
  const config = parseEnv(valid);
  assert.equal(config.PORT, 4000);
  assert.equal(config.MONGODB_DB, 'fpl_rival_test');
  assert.equal(config.NODE_ENV, 'test');
  assert.ok(Object.isFrozen(config));
});

test('defaults PORT and NODE_ENV', () => {
  const { PORT, NODE_ENV, ...rest } = valid;
  const config = parseEnv(rest);
  assert.equal(config.PORT, 4000);
  assert.equal(config.NODE_ENV, 'development');
});

test('missing MONGODB_URI fails with its name in the message', () => {
  const { MONGODB_URI, ...rest } = valid;
  assert.throws(() => parseEnv(rest), (err) => {
    assert.ok(err instanceof EnvError);
    assert.match(err.message, /MONGODB_URI/);
    return true;
  });
});

test('lists every invalid variable at once', () => {
  assert.throws(
    () => parseEnv({ ...valid, PORT: 'abc', MONGODB_URI: 'http://x', MONGODB_DB: undefined, JWT_SECRET: '' }),
    (err) => {
      for (const name of ['PORT', 'MONGODB_URI', 'MONGODB_DB', 'JWT_SECRET']) assert.match(err.message, new RegExp(name));
      assert.equal(err.problems.length, 4);
      return true;
    },
  );
});

test('malformed boolean URI options are reported with the exact value', () => {
  for (const bad of ['true"', 'true`', 'True', 'true;', 'true MONGODB_DB=x']) {
    assert.throws(
      () => parseEnv({ ...valid, MONGODB_URI: `mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=${bad}` }),
      (err) => err.problems.some((p) => p.includes('directConnection') && p.includes(JSON.stringify(bad))),
      bad,
    );
  }
  assert.doesNotThrow(() => parseEnv({ ...valid, MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=false&retryWrites=true' }));
});

test('production requires a strong JWT_SECRET and an ADMIN_PASSWORD_HASH', () => {
  const prod = { ...valid, NODE_ENV: 'production' };
  assert.throws(() => parseEnv(prod), (err) => /JWT_SECRET/.test(err.message) && /ADMIN_PASSWORD_HASH is required/.test(err.message));
  assert.throws(() => parseEnv({ ...prod, JWT_SECRET: 'change-me', ADMIN_PASSWORD_HASH: `$2b$12$${'a'.repeat(53)}` }), /JWT_SECRET/);
  const strong = { ...prod, JWT_SECRET: 'k'.repeat(32), ADMIN_PASSWORD_HASH: `$2b$12$${'a'.repeat(53)}`, TICK_SECRET: 't'.repeat(32), MONGODB_URI: 'mongodb+srv://app:pw@cluster0.example.mongodb.net/?retryWrites=true&w=majority' };
  const ok = parseEnv(strong);
  assert.equal(ok.NODE_ENV, 'production');
  assert.equal(ok.TICK_SECRET, 't'.repeat(32));
});

test('production fails fast without TICK_SECRET', () => {
  const strong = { ...valid, NODE_ENV: 'production', JWT_SECRET: 'k'.repeat(32), ADMIN_PASSWORD_HASH: `$2b$12$${'a'.repeat(53)}`, TICK_SECRET: 't'.repeat(32), MONGODB_URI: 'mongodb+srv://app:pw@cluster0.example.mongodb.net/' };
  const { TICK_SECRET, ...noTick } = strong;
  assert.throws(() => parseEnv(noTick), /TICK_SECRET is required in production/);
  assert.throws(() => parseEnv({ ...strong, TICK_SECRET: 'short' }), /TICK_SECRET must be at least 32 characters/);
  // Every problem is reported at once, and no secret value appears in the message.
  assert.throws(() => parseEnv({ ...noTick, JWT_SECRET: 'weak-secret-value', ADMIN_PASSWORD_HASH: undefined }), (err) => {
    assert.equal(err.problems.length, 3);
    assert.ok(!err.message.includes('weak-secret-value'));
    return true;
  });
  assert.equal(parseEnv(valid).TICK_SECRET, undefined, 'optional outside production');
});

test('ADMIN_PASSWORD_HASH must be a bcrypt hash, never a plain password', () => {
  assert.throws(() => parseEnv({ ...valid, ADMIN_PASSWORD_HASH: 'hunter2' }), /ADMIN_PASSWORD_HASH must be a bcrypt hash/);
  assert.equal(parseEnv(valid).ADMIN_PASSWORD_HASH, undefined, 'optional outside production');
});
