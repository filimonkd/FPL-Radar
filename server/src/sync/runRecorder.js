import { syncRunRepo, rawResponseRepo } from '../repositories/index.js';

// Per-run request log and raw capture (architecture v0.3 §8, §9).
//
// Every FPL call made through `fetch()` becomes one syncRuns.requests[] entry
// { path, httpStatus, bodySha256, bytes, durationMs, schemaOk, fromCache,
// rawResponseId }. Bodies are stored in fplRawResponses only when they are
// evidence or a failure capture:
//   FINAL_EVIDENCE — history, picks, live and transfers of a FINALIZE run
//   SCHEMA_FAIL    — a response that failed validation (zod or the picks rules)
// Bootstrap bodies are never stored, only their hash (§9). Writes are chained so
// the log keeps call-completion order; flush() waits for them.

export const EVIDENCE_CALLS = Object.freeze(['entryHistory', 'entryPicks', 'eventLive', 'entryTransfers']);
const NEVER_STORED = new Set(['bootstrapStatic']);

export class RunRecorder {
  #chain = Promise.resolve();
  #stored = new Map(); // `${path}|${sha}` → rawResponseId (one body stored once per run)

  constructor({ runId, client, captureEvidence = false, clock = () => new Date() }) {
    this.runId = runId;
    this.client = client;
    this.captureEvidence = captureEvidence;
    this.clock = clock;
    this.writeErrors = [];
  }

  /**
   * Runs one client call and records it. Resolves to { data, hash, entry }.
   * @param {(client: object) => Promise<any>} call  e.g. (c) => c.getEntryHistory(id)
   */
  async fetch(call) {
    let entry = null;
    const client = this.client.withRequestLog((e) => { entry = e; });
    try {
      const data = await call(client);
      this.#record(entry, entry ? this.#evidenceReason(entry) : null);
      return { data, hash: entry?.response?.bodySha256 ?? null, entry };
    } catch (err) {
      if (entry) this.#record(entry, entry.schemaOk === false ? 'SCHEMA_FAIL' : null);
      err.requestEntry = entry;
      throw err;
    }
  }

  /** Stores a response that parsed but failed the mapper's rules (e.g. invalid picks) as SCHEMA_FAIL. */
  captureFailure(entry) {
    if (!entry?.response) return;
    this.#chain = this.#chain.then(() => this.#store(entry, 'SCHEMA_FAIL')).catch((err) => this.writeErrors.push(err));
  }

  /** Waits for every pending request-log and raw-capture write. */
  async flush() {
    await this.#chain;
  }

  #evidenceReason(entry) {
    return this.captureEvidence && entry.ok && EVIDENCE_CALLS.includes(entry.name) ? 'FINAL_EVIDENCE' : null;
  }

  #record(entry, reason) {
    this.#chain = this.#chain
      .then(async () => {
        const rawResponseId = reason ? await this.#store(entry, reason) : null;
        const r = entry.response;
        await syncRunRepo.pushRequest(this.runId, {
          path: entry.path,
          httpStatus: r?.status ?? null,
          bodySha256: r?.bodySha256 ?? null,
          bytes: r?.bytes ?? null,
          durationMs: entry.durationMs,
          schemaOk: entry.schemaOk,
          fromCache: entry.fromCache,
          rawResponseId,
        });
      })
      .catch((err) => this.writeErrors.push(err));
  }

  async #store(entry, reason) {
    const r = entry.response;
    if (!r || NEVER_STORED.has(entry.name)) return null;
    const key = `${entry.path}|${r.bodySha256}|${reason}`;
    if (this.#stored.has(key)) return this.#stored.get(key);
    const out = await rawResponseRepo.insert({
      syncRunId: this.runId, path: entry.path, httpStatus: r.status, contentType: r.contentType ?? null, body: r.body, reason, capturedAt: this.clock(),
    });
    const id = out.stored ? out.rawResponse.id : null;
    this.#stored.set(key, id);
    return id;
  }
}
