import { z } from 'zod';
import { DEFAULT_FPL_API_BASE_URL, fplBaseUrlSchema } from '../fpl/baseUrl.js';
import { envSourceHint } from './envSource.js';

// Environment contract (architecture v0.3 §17.4). Parsed once from process.env.

// Boolean MongoDB URI options the driver accepts only as exactly "true"/"false".
const BOOLEAN_URI_OPTIONS = ['directConnection', 'retryWrites', 'retryReads', 'tls', 'ssl', 'loadBalanced', 'journal'];

// Reports malformed boolean options with the exact (escaped) value, so stray
// characters such as a trailing quote or backtick are visible.
function checkUriOptions(uri, ctx) {
  const q = uri.indexOf('?');
  if (q === -1) return;
  for (const [key, value] of new URLSearchParams(uri.slice(q + 1))) {
    const name = BOOLEAN_URI_OPTIONS.find((o) => o.toLowerCase() === key.toLowerCase());
    if (name && value !== 'true' && value !== 'false') {
      ctx.addIssue({ code: 'custom', message: `option ${name} must be exactly "true" or "false", got ${JSON.stringify(value)}` });
    }
  }
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z
    .string({ error: 'is required' })
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://')
    .superRefine(checkUriOptions),
  MONGODB_DB: z.string({ error: 'is required' }).regex(/^[A-Za-z0-9_-]{1,63}$/, 'must be a valid database name'),
  JWT_SECRET: z.string({ error: 'is required' }).min(1, 'must not be empty'),
  FPL_API_BASE_URL: fplBaseUrlSchema.default(DEFAULT_FPL_API_BASE_URL),
});

export class EnvError extends Error {
  constructor(problems) {
    super(`Invalid environment:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

// Pure parse: returns a frozen config or throws EnvError listing every bad variable.
export function parseEnv(source) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`));
  }
  return Object.freeze(result.data);
}

let cached;

// Parses process.env once. On failure prints the readable list and exits.
export function loadEnv() {
  if (cached) return cached;
  try {
    cached = parseEnv(process.env);
    return cached;
  } catch (err) {
    if (!(err instanceof EnvError)) throw err;
    console.error(err.message);
    const names = [...new Set(err.problems.map((p) => p.split(' ')[0]))];
    for (const hint of names.map((n) => envSourceHint(n)).filter(Boolean)) console.error(`  note: ${hint}`);
    process.exit(1);
  }
}
