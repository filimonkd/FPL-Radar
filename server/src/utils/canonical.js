import { createHash } from 'node:crypto';

// Canonical JSON + SHA-256 (architecture v0.3 §6–§8). Pure and deterministic:
// object keys are sorted recursively, array order is kept, undefined object
// members are dropped, Dates become ISO strings and Maps become key-sorted
// objects. Non-finite numbers are rejected because JSON cannot represent them.

export function canonicalize(value) {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('canonical: invalid Date');
    return value.toISOString();
  }
  if (value instanceof Map) {
    return canonicalize(Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v])));
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonical: non-finite number ${value}`);
      return value;
    case 'string':
    case 'boolean':
      return value;
    case 'object': {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) out[key] = canonicalize(value[key]);
      }
      return out;
    }
    default:
      throw new TypeError(`canonical: unsupported type ${typeof value}`);
  }
}

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));

export const sha256 = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

export const contentHash = (value) => sha256(canonicalJson(value));
