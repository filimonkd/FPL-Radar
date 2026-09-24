import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

// Diagnostics for where an environment variable came from. `node --env-file`
// never overrides a variable that already exists in the shell/system
// environment, so a stale system value silently wins over .env.

export const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

export function readDotEnv(file = ROOT_ENV_FILE) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // tolerate a UTF-8 BOM
  return parseEnv(text);
}

// Returns a human hint when the value in use did not come from .env, or null.
export function envSourceHint(name, { env = process.env, fileVars = readDotEnv() } = {}) {
  const value = env[name];
  if (value === undefined) return null;
  if (fileVars === null) return `${name} comes from your shell/system environment (no .env file found).`;
  if (!(name in fileVars)) return `${name} comes from your shell/system environment; it is not set in .env.`;
  if (fileVars[name] !== value) {
    return (
      `${name} is also set in your shell/system environment, and that value overrides .env ` +
      '(node --env-file never replaces existing variables). Remove the system variable ' +
      `(PowerShell: Remove-Item Env:${name}; permanently: System Properties → Environment Variables) ` +
      'or make it match.'
    );
  }
  return null;
}

// Safe preview for error messages: shows only the scheme part, never credentials.
export function describeValue(value) {
  const i = value.indexOf('://');
  const head = i >= 0 ? value.slice(0, i + 3) : value.slice(0, 12);
  return `starts with ${JSON.stringify(head)}${i >= 0 || value.length <= 12 ? '' : '…'} (length ${value.length})`;
}
