import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, endpoints, getShareToken, setShareToken, shareLink, tokenFromHash } from '../../src/lib/api.js';

// Step 13: the client's only network layer. Same-origin relative URLs, the
// share token in a header (never a URL), server errors surfaced verbatim.

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const TOKEN = 'A'.repeat(43);

function recorder(status = 200, body = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(body === null ? '' : JSON.stringify(body), { status }); };
  return { calls, fetchImpl };
}

beforeEach(() => store.clear());

test('requests are same-origin /api paths with JSON bodies and no credentials in the URL', async () => {
  const r = recorder();
  await api('/groups/abc/sync', { method: 'POST', body: { season: '2026-27', event: 5 }, fetchImpl: r.fetchImpl });
  const [{ url, init }] = r.calls;
  assert.equal(url, '/api/groups/abc/sync');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { season: '2026-27', event: 5 });
  assert.equal(init.headers['x-share-token'], undefined);
});

test('a viewer\'s share token travels only in X-Share-Token', async () => {
  setShareToken(TOKEN);
  assert.equal(getShareToken(), TOKEN);
  const r = recorder();
  await api('/auth/me', { fetchImpl: r.fetchImpl });
  assert.equal(r.calls[0].init.headers['x-share-token'], TOKEN);
  assert.ok(!r.calls[0].url.includes(TOKEN));
  setShareToken(null);
  assert.equal(getShareToken(), null);
});

test('share links keep the token in the fragment; malformed fragments are rejected', () => {
  assert.equal(shareLink('https://x.example', TOKEN), `https://x.example/share#${TOKEN}`);
  assert.equal(tokenFromHash(`#${TOKEN}`), TOKEN);
  assert.equal(tokenFromHash('#short'), null);
  assert.equal(tokenFromHash(`#${TOKEN}x`), null);
  assert.equal(tokenFromHash(''), null);
});

test('server errors become ApiError with status, code, message and details', async () => {
  const r = recorder(409, { error: { code: 'FINALIZE_BLOCKED', message: 'finalize blocked: STALE_SYNC', details: { reasons: ['STALE_SYNC'] } } });
  await assert.rejects(api('/x', { fetchImpl: r.fetchImpl }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.deepEqual([err.status, err.code, err.message, err.details.reasons], [409, 'FINALIZE_BLOCKED', 'finalize blocked: STALE_SYNC', ['STALE_SYNC']]);
    return true;
  });
  const bad = recorder(502, null);
  await assert.rejects(api('/x', { fetchImpl: bad.fetchImpl }), (err) => err.code === 'HTTP_ERROR' && err.status === 502);
});

test('endpoint map builds the documented routes with encoded queries', async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return new Response('{}', { status: 200 }); };
  await endpoints.result('g1', 5, '2026-27');
  await endpoints.ownership('g1', 5, '2026-27');
  await endpoints.ownership('g1', 5, '2026-27', 'picked');
  await endpoints.chips('g1', '2026-27', 5);
  await endpoints.groups(true);
  await endpoints.groups(false);
  await endpoints.status('2026-27');
  assert.deepEqual(urls, [
    '/api/groups/g1/gw/5/result?season=2026-27',
    '/api/groups/g1/gw/5/ownership?season=2026-27',
    '/api/groups/g1/gw/5/ownership?season=2026-27&view=picked',
    '/api/groups/g1/chips?season=2026-27&event=5',
    '/api/groups?includeArchived=true',
    '/api/groups?',
    '/api/status?season=2026-27',
  ]);
});
