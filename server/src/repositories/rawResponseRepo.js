import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { FplRawResponse, MAX_RAW_BYTES } from '../models/FplRawResponse.js';
import { rawResponseToDomain, rawResponseToDocument } from './mappers/rawResponse.js';
import { toObjectId } from './mappers/common.js';
import { requireTransaction, sessionOpt } from './internal/session.js';

// fplRawResponses (v0.3 §9, §10): insert, unset expiry (T4). Bodies are gzipped;
// bodySha256 is computed on the raw bytes so it matches syncRuns.requests[].
// Retention is TTL on expireAt; a document without expireAt is permanent.

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = Object.freeze({ FINAL_EVIDENCE: 14, SCHEMA_FAIL: 30, CHIP_RULES_INVALID: 30, SMOKE: 7 });
export const RAW_TOO_LARGE = 'RAW_TOO_LARGE';

export const bodySha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export const rawResponseRepo = {
  /**
   * Stores a raw FPL body. Bodies over 2 MB raw are not stored (RAW_TOO_LARGE);
   * only their hash and size are returned for the run log.
   * @returns {Promise<{ stored: true, rawResponse: object } | { stored: false, code: string, bodySha256: string, bytesRaw: number }>}
   */
  async insert({ syncRunId, path, httpStatus = null, contentType = null, body, reason, capturedAt = new Date() }, { session } = {}) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const hash = bodySha256(raw);
    if (raw.length > MAX_RAW_BYTES) return { stored: false, code: RAW_TOO_LARGE, bodySha256: hash, bytesRaw: raw.length };
    const days = RETENTION_DAYS[reason];
    if (!days) throw new TypeError(`unknown raw response reason ${reason}`);
    const bodyGzip = gzipSync(raw);
    const doc = rawResponseToDocument({
      syncRunId, path, httpStatus, contentType, bodyGzip, bodySha256: hash, bytesRaw: raw.length, bytesStored: bodyGzip.length,
      reason, retainedBySnapshotIds: [], capturedAt, expireAt: new Date(capturedAt.getTime() + days * DAY_MS),
    });
    const [created] = await FplRawResponse.create([doc], sessionOpt(session));
    return { stored: true, rawResponse: rawResponseToDomain(created.toObject()) };
  },

  /**
   * T4 step 5: the FINAL_EVIDENCE bodies behind a snapshot's sources become
   * permanent and record the snapshot that retains them.
   * @param {{ syncRunId: string, requestHashes: string[] }[]} sources
   */
  async unsetEvidenceExpiry(sources, snapshotId, { session } = {}) {
    requireTransaction(session, 'rawResponseRepo.unsetEvidenceExpiry');
    const clauses = sources
      .filter((s) => s.requestHashes?.length)
      .map((s) => ({ syncRunId: toObjectId(s.syncRunId, 'syncRunId'), bodySha256: { $in: s.requestHashes } }));
    if (clauses.length === 0) return 0;
    const r = await FplRawResponse.updateMany(
      { reason: 'FINAL_EVIDENCE', $or: clauses },
      { $unset: { expireAt: '' }, $addToSet: { retainedBySnapshotIds: toObjectId(snapshotId, 'snapshotId') } },
      { session },
    );
    return r.matchedCount;
  },

  async get(id, { session } = {}) {
    return rawResponseToDomain(await FplRawResponse.findById(toObjectId(id, 'rawResponse id'), { bodyGzip: 0 }).session(session ?? null).lean());
  },

  /** The decompressed raw body bytes, or null. */
  async getBody(id, { session } = {}) {
    const doc = await FplRawResponse.findById(toObjectId(id, 'rawResponse id'), { bodyGzip: 1 }).session(session ?? null).lean();
    if (!doc) return null;
    return gunzipSync(Buffer.from(doc.bodyGzip.buffer ?? doc.bodyGzip));
  },

  /** A run's stored bodies (index by_run), metadata only, ordered by capture time. */
  async listByRun(syncRunId, { session } = {}) {
    const docs = await FplRawResponse.find({ syncRunId: toObjectId(syncRunId, 'syncRunId') }, { bodyGzip: 0 })
      .sort({ capturedAt: 1, path: 1 }).session(session ?? null).lean();
    return docs.map(rawResponseToDomain);
  },
};
