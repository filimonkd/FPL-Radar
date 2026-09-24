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
