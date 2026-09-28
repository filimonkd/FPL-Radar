import { toObjectId, snapshotContentHash } from '../mappers/common.js';

// Idempotent snapshot writes (architecture v0.3 §6):
//   1. deterministic _id + upsert, 2. embedded lists replaced wholesale,
//   3. content hash: always stamp lastConfirmedByRunId/At; change the data and
//      lastChangedByRunId/At only when contentHash differs.
// Sent through the native Model.collection.bulkWrite with a pipeline update
// ($cond on $provenance.contentHash), as §12 specifies for content-hash upserts.
// Every document is first validated by its Mongoose model (hooks included), and
// the $jsonSchema validator checks it again on write.

const DUPLICATE_ID = 'duplicate _id in one snapshot batch';

/** settled = the writing run started after DATA_CHECKED was observed for that GW (v0.3 §6 rule 4). */
export function settledFor(run, dataCheckedObservedAt) {
  if (!dataCheckedObservedAt || !run.startedAt) return false;
  return new Date(run.startedAt).getTime() > new Date(dataCheckedObservedAt).getTime();
}

/** Normalizes the run context every snapshot write carries. */
export function runContext(run) {
  if (!run?.runId) throw new TypeError('a snapshot write needs run.runId');
  return {
    runId: toObjectId(run.runId, 'runId'),
    startedAt: run.startedAt ?? null,
    at: run.at ?? new Date(),
  };
}

const literal = (v) => ({ $literal: v });

/**
 * Validates `doc` (data fields incl. _id, no provenance) through the model and
 * returns the cast data fields plus their contentHash.
 */
export async function prepareSnapshot(Model, doc, provenance) {
  const hydrated = new Model({ ...doc, provenance });
  await hydrated.validate();
  const { provenance: _p, ...data } = hydrated.toObject({ flattenMaps: true, depopulate: true, versionKey: false });
  return { data, contentHash: snapshotContentHash(data) };
}

/** Pipeline $set for provenance: confirm always, change only when `changed`. */
export function provenanceStage(prefix, run, contentHash, changed, { sourceRequests, settled }) {
  const p = (k) => `$${prefix}.${k}`;
  return {
    lastConfirmedByRunId: run.runId,
    lastConfirmedAt: run.at,
    lastChangedByRunId: { $cond: [changed, run.runId, p('lastChangedByRunId')] },
    lastChangedAt: { $cond: [changed, run.at, p('lastChangedAt')] },
    contentHash,
    sourceRequests: literal(sourceRequests),
    settled: literal(settled), // $literal: a bare boolean in a pipeline stage can read as a projection flag
  };
}

export const hashDiffers = (path, contentHash) => ({ $ne: [{ $ifNull: [`$${path}`, null] }, contentHash] });

/**
 * @param {import('mongoose').Model} Model
 * @param {{ doc: object, sourceRequests?: Record<string,string>, settled?: boolean }[]} items
 * @param {{ runId: any, startedAt?: Date, at?: Date }} run
 * @returns {Promise<{ inserted: any[], changed: any[], unchanged: any[], settledRowChanges: { id: any, oldHash: string, newHash: string }[] }>}
 */
export async function upsertSnapshots(Model, items, run, { session, ordered = true } = {}) {
  const ctx = runContext(run);
  const prepared = [];
  const seen = new Set();
  for (const item of items) {
    const sourceRequests = { ...(item.sourceRequests ?? {}) };
    const settled = item.settled ?? false;
    const provisional = {
      lastConfirmedByRunId: ctx.runId, lastConfirmedAt: ctx.at, lastChangedByRunId: ctx.runId, lastChangedAt: ctx.at,
      contentHash: `sha256:${'0'.repeat(64)}`, sourceRequests, settled,
    };
    const { data, contentHash } = await prepareSnapshot(Model, item.doc, provisional);
    const key = String(data._id);
    if (seen.has(key)) throw new Error(`${DUPLICATE_ID}: ${key}`);
    seen.add(key);
    prepared.push({ data, contentHash, sourceRequests, settled });
  }
  if (prepared.length === 0) return { inserted: [], changed: [], unchanged: [], settledRowChanges: [] };

  const existing = new Map(
    (await Model.find({ _id: { $in: prepared.map((p) => p.data._id) } }, { 'provenance.contentHash': 1, 'provenance.settled': 1 })
      .session(session ?? null).lean())
      .map((d) => [String(d._id), d.provenance]),
  );

  const ops = prepared.map(({ data, contentHash, sourceRequests, settled }) => {
    const changed = hashDiffers('provenance.contentHash', contentHash);
    const $set = {};
    for (const [k, v] of Object.entries(data)) {
      if (k !== '_id') $set[k] = { $cond: [changed, literal(v), `$${k}`] };
    }
    $set.provenance = provenanceStage('provenance', ctx, contentHash, changed, { sourceRequests, settled });
    return { updateOne: { filter: { _id: data._id }, update: [{ $set }], upsert: true } };
  });
  await Model.collection.bulkWrite(ops, { ordered, ...(session ? { session } : {}) });

  const out = { inserted: [], changed: [], unchanged: [], settledRowChanges: [] };
  for (const { data, contentHash } of prepared) {
    const before = existing.get(String(data._id));
    if (!before) out.inserted.push(data._id);
    else if (before.contentHash === contentHash) out.unchanged.push(data._id);
    else {
      out.changed.push(data._id);
      if (before.settled) out.settledRowChanges.push({ id: data._id, oldHash: before.contentHash, newHash: contentHash });
    }
  }
  return out;
}

/** sourceRequests may be one map for the batch or a function of each value. */
export const requestsFor = (sourceRequests, value) => (typeof sourceRequests === 'function' ? sourceRequests(value) : sourceRequests);
