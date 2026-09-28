import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../../src/shutdown.js';

// SIGTERM handling (v0.3 §11): order, idempotency, exit codes.

function fakes({ syncFails = false } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      server: { close: (cb) => { calls.push('server.close'); setImmediate(cb); } },
      sync: { shutdown: async () => { calls.push('sync.shutdown'); if (syncFails) throw new Error('db down'); return { abandoned: ['r1'] }; } },
      disconnect: async () => { calls.push('disconnect'); },
      closeClient: () => calls.push('client.close'),
      exit: (code) => calls.push(`exit:${code}`),
    },
  };
}

test('stops the server, abandons + releases runs, then disconnects and exits 0', async () => {
  const f = fakes();
  const shutdown = createShutdown(f.deps);
  assert.equal(await shutdown('SIGTERM'), 0);
  assert.deepEqual(f.calls, ['server.close', 'sync.shutdown', 'client.close', 'disconnect', 'exit:0']);
});

test('is idempotent: repeated signals share one shutdown', async () => {
  const f = fakes();
  const shutdown = createShutdown(f.deps);
  const [a, b] = await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
  await shutdown('SIGTERM');
  assert.equal(a, 0);
  assert.equal(b, 0);
  assert.equal(f.calls.filter((c) => c === 'sync.shutdown').length, 1);
  assert.equal(f.calls.filter((c) => c.startsWith('exit')).length, 1);
});

test('a failure during shutdown exits 1', async () => {
  const f = fakes({ syncFails: true });
  assert.equal(await createShutdown(f.deps)('SIGTERM'), 1);
  assert.ok(f.calls.includes('exit:1'));
});
