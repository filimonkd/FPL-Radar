import { SyncRun, MAX_REQUESTS_PER_RUN } from '../models/SyncRun.js';
import { syncRunToDomain, syncRunToDocument, requestToDocument, failureToDocument, warningToDocument } from './mappers/syncRun.js';
import { toObjectId } from './mappers/common.js';
import { requireTransaction, sessionOpt } from './internal/session.js';

// syncRuns (v0.3 §8, §10): insert, push request, finish, mark abandoned, unset
// expiry (T4). The run document is the unit of provenance. Runs expire after
// 90 days unless a result snapshot references them (T4 unsets expireAt).

export const RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const REQUEST_LOG_TRUNCATED = 'REQUEST_LOG_TRUNCATED';
const FINAL_STATUSES = Object.freeze(['SUCCESS', 'PARTIAL', 'FAILED']);

export const syncRunRepo = {
  /**
   * Inserts a RUNNING run before any fetch (v0.3 §6 rule 7). Pass `id` when the
   * run id was generated first to own the lease (owner = runId, v0.3 §3).
   */
  async insert(run, { session } = {}) {
    const startedAt = run.startedAt ?? new Date();
    const doc = syncRunToDocument({
      ...run, status: 'RUNNING', requests: [], failures: [], warnings: [], startedAt, finishedAt: null,
      expireAt: new Date(startedAt.getTime() + RUN_RETENTION_MS),
    });
    const [created] = await SyncRun.create([doc], sessionOpt(session));
    return syncRunToDomain(created.toObject());
  },

  /**
   * Appends one request log entry to a RUNNING run. Past MAX_REQUESTS_PER_RUN
   * the entry is dropped and REQUEST_LOG_TRUNCATED is recorded once.
   * @returns {Promise<{ logged: boolean, truncated: boolean }>}
   */
  async pushRequest(runId, request, { session } = {}) {
    const _id = toObjectId(runId, 'runId');
    const entry = requestToDocument(request);
    const pushed = await SyncRun.updateOne(
      { _id, status: 'RUNNING', [`requests.${MAX_REQUESTS_PER_RUN - 1}`]: { $exists: false } },
      { $push: { requests: entry } },
      { ...sessionOpt(session), runValidators: true },
    );
    if (pushed.matchedCount === 1) return { logged: true, truncated: false };
    const r = await SyncRun.updateOne(
      { _id, status: 'RUNNING', [`requests.${MAX_REQUESTS_PER_RUN - 1}`]: { $exists: true }, 'warnings.code': { $ne: REQUEST_LOG_TRUNCATED } },
      { $push: { warnings: { code: REQUEST_LOG_TRUNCATED, detail: { limit: MAX_REQUESTS_PER_RUN } } } },
      sessionOpt(session),
    );
    const full = r.matchedCount === 1 || (await SyncRun.exists({ _id, status: 'RUNNING', [`requests.${MAX_REQUESTS_PER_RUN - 1}`]: { $exists: true } }).session(session ?? null));
    return { logged: false, truncated: Boolean(full) };
  },

  /** RUNNING → SUCCESS | PARTIAL | FAILED, appending warnings/failures. Returns false if the run was not RUNNING. */
  async finish(runId, { status, warnings = [], failures = [], finishedAt = new Date() }, { session } = {}) {
    if (!FINAL_STATUSES.includes(status)) throw new TypeError(`finish status must be one of ${FINAL_STATUSES.join(', ')}`);
    const r = await SyncRun.updateOne(
      { _id: toObjectId(runId, 'runId'), status: 'RUNNING' },
      {
        $set: { status, finishedAt },
        $push: { warnings: { $each: warnings.map(warningToDocument) }, failures: { $each: failures.map(failureToDocument) } },
      },
      { ...sessionOpt(session), runValidators: true },
    );
    return r.modifiedCount === 1;
  },

  /**
   * Crash recovery (v0.3 §5 lease step 5): the next acquirer of `lockId`, holding
   * `fencingToken`, marks every run still RUNNING under an older token ABANDONED.
   * Ordering is by fencing token, never by ObjectId. Returns the count.
   */
  async markAbandoned(lockId, fencingToken, { at = new Date(), session } = {}) {
    const r = await SyncRun.updateMany(
      { lockId, status: 'RUNNING', lockFencingToken: { $lt: fencingToken } },
      { $set: { status: 'ABANDONED', finishedAt: at } },
      sessionOpt(session),
    );
    return r.modifiedCount;
  },

  /** T4 step 5: runs referenced by a snapshot are retained permanently. */
  async unsetExpiry(runIds, { session } = {}) {
    requireTransaction(session, 'syncRunRepo.unsetExpiry');
    const r = await SyncRun.updateMany({ _id: { $in: runIds.map((id) => toObjectId(id, 'runId')) } }, { $unset: { expireAt: '' } }, { session });
    return r.matchedCount;
  },

  async get(runId, { session } = {}) {
    return syncRunToDomain(await SyncRun.findById(toObjectId(runId, 'runId')).session(session ?? null).lean());
  },

  /** Runs by id, ordered by startedAt (business order), then id for a stable listing. */
  async getMany(runIds, { session } = {}) {
    const docs = await SyncRun.find({ _id: { $in: runIds.map((id) => toObjectId(id, 'runId')) } }).session(session ?? null).lean();
    return docs.map(syncRunToDomain).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  },

  /** Most recent runs for a target (index target_recent). */
  async listRecent(target, { limit = 20, session } = {}) {
    const docs = await SyncRun.find({ target }).sort({ startedAt: -1 }).limit(limit).session(session ?? null).lean();
    return docs.map(syncRunToDomain);
  },
};
