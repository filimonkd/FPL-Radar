import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { BASE_URL } from './fplWorld.js';

// Runs the real production entry point (src/server.js, NODE_ENV=production)
// against a test database and a synthetic FPL API served over HTTP. Used by the
// client's browser test; never touches the real FPL API.

const SERVER = fileURLToPath(new URL('../../src/server.js', import.meta.url));

/** Serves a fplWorld over HTTP at http://127.0.0.1:<port>/api. */
export async function serveWorld(world) {
  const server = createServer(async (req, res) => {
    const r = await world.fetch(BASE_URL + req.url.replace(/^\/api/, ''));
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/api`, close: () => new Promise((r) => server.close(r)) };
}

export async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** Spawns the server; resolves { base, out(), stop() } once it listens. */
export async function startProdServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  await new Promise((resolve, reject) => {
    const onData = () => { if (/Server listening on/.test(out)) resolve(); };
    child.stdout.on('data', onData);
    exited.then(({ code }) => reject(new Error(`server exited (${code}) before listening:\n${out}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    out: () => out,
    async stop() { child.kill('SIGTERM'); return exited; },
  };
}
