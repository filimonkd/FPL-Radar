// npm run check:bundle — fails if the built client (client/dist) carries anything
// server-side: env variable names, secrets, credentials or MongoDB URIs. Run
// after `npm run build` (CI does). Vite only inlines VITE_* variables, and the
// client uses none, so any match here is a leak.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../../client/dist/', import.meta.url));

export const FORBIDDEN = [
  [/MONGODB_URI|MONGODB_DB|JWT_SECRET|ADMIN_PASSWORD_HASH|TICK_SECRET|FPL_API_BASE_URL/, 'server env variable name'],
  [/mongodb(\+srv)?:\/\//, 'MongoDB connection string'],
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/, 'bcrypt hash'],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, 'JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|AGE-SECRET-KEY-1/, 'private key'],
  [/fantasy\.premierleague\.com/, 'direct FPL API URL (the browser must go through /api)'],
  [/process\.env\b/, 'process.env reference'],
];

export function scan(text) {
  return FORBIDDEN.filter(([re]) => re.test(text)).map(([, what]) => what);
}

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let all;
  try {
    all = files(DIST);
  } catch {
    console.error('client/dist not found: run `npm run build` first.');
    process.exit(1);
  }
  const problems = all.flatMap((f) => scan(readFileSync(f, 'latin1')).map((what) => `${relative(DIST, f)}: ${what}`));
  if (problems.length) {
    console.error(`Client bundle check FAILED:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Client bundle check OK (${all.length} files, no secrets or server env names).`);
}
