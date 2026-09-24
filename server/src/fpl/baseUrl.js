import { z } from 'zod';

// FPL API base URL (FPL_API_BASE_URL). Shared by the env contract and the
// smoke-test CLI, which runs without the app's database settings.

export const DEFAULT_FPL_API_BASE_URL = 'https://fantasy.premierleague.com/api';

export const fplBaseUrlSchema = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .transform((u) => u.replace(/\/+$/, ''));

// Precedence: explicit value (e.g. --base-url) > FPL_API_BASE_URL > default.
export function resolveFplBaseUrl({ flag, env = process.env } = {}) {
  const raw = flag ?? (env.FPL_API_BASE_URL?.trim() || undefined) ?? DEFAULT_FPL_API_BASE_URL;
  const result = fplBaseUrlSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`FPL_API_BASE_URL ${result.error.issues[0].message}: "${raw}"`);
  }
  return result.data;
}
