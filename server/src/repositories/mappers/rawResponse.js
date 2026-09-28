import { idString, toObjectId } from './common.js';

// fplRawResponses ↔ domain metadata. The gzipped body is only returned by
// rawResponseRepo.getBody (v0.3 §9).

export function rawResponseToDomain(doc) {
  if (!doc) return null;
  return {
    id: idString(doc._id),
    syncRunId: idString(doc.syncRunId),
    path: doc.path,
    httpStatus: doc.httpStatus ?? null,
    contentType: doc.contentType ?? null,
    bodySha256: doc.bodySha256,
    bytesRaw: doc.bytesRaw,
    bytesStored: doc.bytesStored,
    reason: doc.reason,
    retainedBySnapshotIds: (doc.retainedBySnapshotIds ?? []).map(idString),
    expireAt: doc.expireAt ?? null,
    capturedAt: doc.capturedAt,
  };
}

export function rawResponseToDocument(r) {
  const doc = {
    syncRunId: toObjectId(r.syncRunId, 'syncRunId'),
    path: r.path,
    httpStatus: r.httpStatus ?? null,
    contentType: r.contentType ?? null,
    bodyGzip: r.bodyGzip,
    bodySha256: r.bodySha256,
    bytesRaw: r.bytesRaw,
    bytesStored: r.bytesStored,
    reason: r.reason,
    retainedBySnapshotIds: (r.retainedBySnapshotIds ?? []).map((id) => toObjectId(id, 'snapshot id')),
    capturedAt: r.capturedAt,
  };
  if (r.id != null) doc._id = toObjectId(r.id, 'rawResponse id');
  if (r.expireAt != null) doc.expireAt = r.expireAt;
  return doc;
}
