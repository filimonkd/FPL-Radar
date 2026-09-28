// npm run smoke:deploy -- https://<service>.onrender.com
// Post-deploy verification of a running instance (docs/DEPLOYMENT.md §4).
// Read-only: it never creates groups, syncs or finalizes, and never calls FPL.
// Optional env: TICK_SECRET (checks the tick with the real secret),
// SMOKE_ADMIN_PASSWORD (checks login, the cookie flags, /api/status, logout).
// Nothing secret is printed. Exits 1 if any check fails.
import { fileURLToPath } from 'node:url';

export async function deploySmoke(baseUrl, { tickSecret, adminPassword, season, log = console.log, fetchImpl = fetch } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true });
      log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
    } catch (err) {
      results.push({ name, ok: false });
      log(`FAIL ${name}: ${err.message}`);
    }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  const req = (path, init = {}) => fetchImpl(`${base}${path}`, { redirect: 'manual', ...init });

  await check('health 200 ok, production, migrations applied, not draining', async () => {
    const res = await req('/api/health');
    const body = await res.json();
    expect(res.status === 200 && body.status === 'ok', `status ${res.status} ${body.status}: ${JSON.stringify(body.checks)}`);
    expect(body.env === 'production', `env is ${body.env}`);
    expect(body.checks.migrations?.ok === true, 'migrations not reported ok');
    expect(body.checks.runtime?.ok === true, 'runtime not ok');
    return `version ${body.version}, ${body.checks.migrations.applied}/${body.checks.migrations.expected} migrations`;
  });

  await check('client served from the API origin with security headers', async () => {
    const res = await req('/', { headers: { origin: 'https://example.invalid' } });
    const html = await res.text();
    expect(res.status === 200 && html.includes('id="root"'), `GET / → ${res.status}`);
    expect(/default-src 'self'/.test(res.headers.get('content-security-policy') ?? ''), 'no CSP');
    expect(/max-age=/.test(res.headers.get('strict-transport-security') ?? ''), 'no HSTS');
    expect(res.headers.get('access-control-allow-origin') === null, 'CORS header present');
  });

  await check('unknown /api path is a JSON 404', async () => {
    const res = await req('/api/definitely-not-a-route');
    expect(res.status === 404 && (await res.json()).error?.code === 'NOT_FOUND', `→ ${res.status}`);
  });

  await check('admin API refuses anonymous requests', async () => {
    const res = await req('/api/groups');
    expect(res.status === 401, `→ ${res.status}`);
  });

  await check('tick rejects a wrong secret', async () => {
    const res = await req('/api/internal/tick', { method: 'POST', headers: { 'x-tick-secret': 'wrong' } });
    expect(res.status === 401, `→ ${res.status} (404 means TICK_SECRET is not set)`);
  });

  if (tickSecret) {
    await check('tick accepts the configured secret', async () => {
      const res = await req('/api/internal/tick', { method: 'POST', headers: { 'x-tick-secret': tickSecret } });
      expect(res.status === 204, `→ ${res.status}`);
    });
  }

  if (adminPassword) {
    await check('admin login sets an HttpOnly, Secure, SameSite=Strict cookie on /api', async () => {
      const res = await req('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: adminPassword }) });
      expect(res.status === 200, `login → ${res.status}`);
      const setCookie = res.headers.get('set-cookie') ?? '';
      for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api']) expect(setCookie.includes(flag), `cookie lacks ${flag}`);
      const cookie = setCookie.split(';')[0];
      const me = await req('/api/auth/me', { headers: { cookie } });
      expect((await me.json()).principal?.role === 'admin', 'not admin after login');
      if (season) {
        const st = await req(`/api/status?season=${encodeURIComponent(season)}`, { headers: { cookie } });
        expect(st.status === 200, `/api/status → ${st.status}`);
        const { status } = await st.json();
        log(`     storage ${JSON.stringify(status.storage)}; ${status.runs.length} recent runs`);
      }
      await req('/api/auth/logout', { method: 'POST', headers: { cookie } });
    });
  }

  return { ok: results.every((r) => r.ok), results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('usage: npm run smoke:deploy -- https://<service>.onrender.com [season]');
    process.exit(1);
  }
  const { ok } = await deploySmoke(url, {
    tickSecret: process.env.TICK_SECRET || undefined,
    adminPassword: process.env.SMOKE_ADMIN_PASSWORD || undefined,
    season: process.argv[3],
  });
  console.log(ok ? 'Deploy smoke: OK' : 'Deploy smoke: FAILED');
  process.exit(ok ? 0 : 1);
}
