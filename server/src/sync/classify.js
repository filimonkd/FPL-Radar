import { FplError, FplErrorKind } from '../fpl/errors.js';
import { classifyResponse, classifyLeagueAccess } from '../fpl/smoke/classify.js';

// Stable failure codes recorded in syncRuns.failures[] (architecture v0.2 §10,
// §15; v0.3 §8). Blocked / auth decisions reuse the Step 2 smoke classifiers,
// so the sync and the smoke test can never disagree:
//   BLOCKED       — a concrete denial indicator (egress x-deny-reason, allowlist
//                   text, Cloudflare cf-mitigated or a challenge page)
//   AUTH_REQUIRED — 401/403 without such an indicator, or a login redirect/page
export const FailureCode = Object.freeze({
  BLOCKED: 'BLOCKED',
  UPDATING: 'UPDATING',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  SCHEMA_FAIL: 'SCHEMA_FAIL',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  HTTP_ERROR: 'HTTP_ERROR',
  LOCK_LOST: 'LOCK_LOST',
  INTERNAL: 'INTERNAL',
});

const KIND_CODES = {
  [FplErrorKind.TIMEOUT]: FailureCode.TIMEOUT,
  [FplErrorKind.NETWORK]: FailureCode.NETWORK,
  [FplErrorKind.CIRCUIT_OPEN]: FailureCode.CIRCUIT_OPEN,
  [FplErrorKind.VALIDATION]: FailureCode.SCHEMA_FAIL,
  [FplErrorKind.NOT_FOUND]: FailureCode.NOT_FOUND,
  [FplErrorKind.RATE_LIMITED]: FailureCode.RATE_LIMITED,
  [FplErrorKind.UPSTREAM_UNAVAILABLE]: FailureCode.UPSTREAM_UNAVAILABLE,
  [FplErrorKind.INVALID_RESPONSE]: FailureCode.INVALID_RESPONSE,
  [FplErrorKind.HTTP]: FailureCode.HTTP_ERROR,
};

/** A sync-level failure with a stable code (normalization / run-stage problems). */
export class SyncStageError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'SyncStageError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Maps any error from a sync step to a FailureCode.
 * @param {unknown} err
 * @param {{ league?: boolean }} [opts] league = the call was a league standings request
 */
export function classifyFailure(err, { league = false } = {}) {
  if (err instanceof SyncStageError) return err.code;
  if (err?.code === 'LOCK_LOST') return FailureCode.LOCK_LOST;
  if (!(err instanceof FplError)) return FailureCode.INTERNAL;
  const r = err.response;
  if (r) {
    const text = r.text ?? '';
    const classification = classifyResponse({
      status: r.status, contentType: r.contentType ?? '', text, json: undefined, denyReason: r.denyReason, cfMitigated: r.cfMitigated,
    });
    if (classification === 'BLOCKED') return FailureCode.BLOCKED;
    if (classification === 'UPDATING') return FailureCode.UPDATING;
    if (r.status === 401 || r.status === 403) return FailureCode.AUTH_REQUIRED;
    if (league) {
      const access = classifyLeagueAccess({ classification, status: r.status, location: r.location, contentType: r.contentType, text });
      if (access === 'AUTH_REQUIRED') return FailureCode.AUTH_REQUIRED;
    }
  }
  return KIND_CODES[err.kind] ?? FailureCode.INTERNAL;
}

/** Failure record for syncRuns.failures[] ({ entryId, code, message }). */
export function failureOf(err, { entryId = null, league = false, stage = null } = {}) {
  const code = classifyFailure(err, { league });
  const message = `${stage ? `${stage}: ` : ''}${err?.message ?? String(err)}`.slice(0, 500);
  return { entryId, code, message };
}
