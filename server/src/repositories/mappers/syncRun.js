import { idString, toObjectId, mapList } from './common.js';

// syncRuns ↔ domain run: the unit of provenance (v0.3 §8).

export const requestToDomain = (r) => ({
  path: r.path,
  httpStatus: r.httpStatus ?? null,
  bodySha256: r.bodySha256 ?? null,
  bytes: r.bytes ?? null,
  durationMs: r.durationMs,
  schemaOk: r.schemaOk ?? null,
  fromCache: r.fromCache ?? false,
  rawResponseId: idString(r.rawResponseId),
});

export const requestToDocument = (r) => ({ ...requestToDomain(r), rawResponseId: toObjectId(r.rawResponseId, 'rawResponseId') });

const failureToDomain = (f) => ({ entryId: f.entryId ?? null, code: f.code, message: f.message });
const warningToDomain = (w) => (w.detail === undefined ? { code: w.code } : { code: w.code, detail: w.detail });

export function syncRunToDomain(doc) {
  if (!doc) return null;
  return {
    id: idString(doc._id),
    job: doc.job,
    target: doc.target ?? null,
    season: doc.season ?? null,
    event: doc.event ?? null,
    trigger: doc.trigger,
    status: doc.status,
    lockId: doc.lockId ?? null,
    lockFencingToken: doc.lockFencingToken ?? null,
    requests: mapList(doc.requests, requestToDomain),
    failures: mapList(doc.failures, failureToDomain),
    warnings: mapList(doc.warnings, warningToDomain),
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt ?? null,
    expireAt: doc.expireAt ?? null,
  };
}

export function syncRunToDocument(r) {
  const doc = {
    job: r.job,
    target: r.target ?? null,
    season: r.season ?? null,
    event: r.event ?? null,
    trigger: r.trigger,
    status: r.status,
    lockId: r.lockId ?? null,
    lockFencingToken: r.lockFencingToken ?? null,
    requests: mapList(r.requests, requestToDocument),
    failures: mapList(r.failures, failureToDomain),
    warnings: mapList(r.warnings, warningToDomain),
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
  };
  if (r.id != null) doc._id = toObjectId(r.id, 'syncRun id');
  if (r.expireAt != null) doc.expireAt = r.expireAt;
  return doc;
}

export { failureToDomain as failureToDocument, warningToDomain as warningToDocument };
