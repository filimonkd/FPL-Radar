import { Types } from 'mongoose';
import { contentHash } from '../../db/canonical.js';
import { canonicalize } from '../../utils/canonical.js';

// Shared mapper helpers (architecture v0.3 §10 rule 1): ObjectIds become
// 24-char hex strings in the domain, Dates stay Dates, tenths stay integers.

const HEX24 = /^[a-f0-9]{24}$/;

export const idString = (v) => (v == null ? null : String(v));

export function toObjectId(v, name = 'id') {
  if (v == null) return null;
  if (v instanceof Types.ObjectId) return v;
  if (typeof v === 'string' && HEX24.test(v)) return new Types.ObjectId(v);
  throw new TypeError(`${name} must be a 24-char hex ObjectId, got "${v}"`);
}

export function omitKeys(obj, keys) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

// Mixed payloads (standings, inputs, traces, warnings) are stored in canonical
// form: keys sorted, undefined members dropped, Dates as ISO strings, Maps as
// objects. What is read back therefore hashes exactly as what was written.
export const canonicalMixed = (value) => canonicalize(value);

export function provenanceToDomain(p) {
  if (!p) return null;
  return {
    lastConfirmedByRunId: idString(p.lastConfirmedByRunId),
    lastConfirmedAt: p.lastConfirmedAt,
    lastChangedByRunId: idString(p.lastChangedByRunId),
    lastChangedAt: p.lastChangedAt,
    contentHash: p.contentHash,
    sourceRequests: p.sourceRequests instanceof Map ? Object.fromEntries(p.sourceRequests) : { ...(p.sourceRequests ?? {}) },
    settled: p.settled ?? false,
  };
}

/** Adds `provenance` to a mapped domain object only when requested. */
export function attachProvenance(domain, doc, { withProvenance = false } = {}) {
  return withProvenance ? { ...domain, provenance: provenanceToDomain(doc.provenance) } : domain;
}

// contentHash = sha256(canonicalJSON(snapshotFields)), provenance and _id excluded (v0.3 §6).
export const snapshotContentHash = (fields) => contentHash(omitKeys(fields, ['_id', 'provenance']));

export const mapList = (list, fn) => (list ?? []).map(fn);
