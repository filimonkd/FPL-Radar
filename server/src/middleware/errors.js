import { AppError } from '../errors.js';
import { FplError } from '../fpl/errors.js';
import { classifyFailure } from '../sync/classify.js';

// One place that turns errors into { error: { code, message, details? } } with a
// stable status (v0.2 §5 codes: GROUP_ARCHIVED, LEAGUE_ALREADY_CONFIGURED,
// SYNC_IN_PROGRESS …). Unknown errors become a generic 500 without internals.

const SYNC_STAGE_422 = new Set(['LEAGUE_NOT_ACCESSIBLE', 'INVALID_ENTRY_IDS', 'MY_ENTRY_NOT_MEMBER']);
const DUPLICATE_KEY_CODES = { slug: 'SLUG_TAKEN', fplLeagueId: 'LEAGUE_ALREADY_CONFIGURED' };

/** Maps any error to { status, code, message, details }. Pure; exported for tests. */
export function mapError(err) {
  if (err instanceof AppError) return { status: err.status, code: err.code, message: err.message, details: err.details };
  if (err?.name === 'ZodError') {
    return { status: 400, code: 'VALIDATION_FAILED', message: 'request validation failed', details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } };
  }
  if (err?.type === 'entity.parse.failed') return { status: 400, code: 'INVALID_JSON', message: 'request body is not valid JSON' };
  if (err?.type === 'entity.too.large') return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'request body too large' };
  if (err?.name === 'ValidationError' && err.errors) {
    return { status: 422, code: 'VALIDATION_FAILED', message: 'document validation failed', details: { issues: Object.entries(err.errors).map(([path, e]) => ({ path, message: e.message })) } };
  }
  switch (err?.code) {
    case 'NOT_FOUND': return { status: 404, code: 'NOT_FOUND', message: err.message };
    case 'DUPLICATE_MEMBER': return { status: 409, code: 'DUPLICATE_MEMBER', message: err.message, details: { entryIds: err.entryIds } };
    case 'GROUP_ARCHIVED': return { status: 409, code: 'GROUP_ARCHIVED', message: err.message };
    case 'SYNC_IN_PROGRESS': return { status: 409, code: 'SYNC_IN_PROGRESS', message: err.message };
    case 'CONCURRENT_DECISION': return { status: 409, code: 'CONCURRENT_DECISION', message: err.message };
    case 'SHUTTING_DOWN': return { status: 503, code: 'SHUTTING_DOWN', message: err.message };
    case 'LOCK_LOST': return { status: 503, code: 'LOCK_LOST', message: 'the operation lost its lock; retry' };
    case 11000: {
      const key = Object.keys(err.keyPattern ?? {})[0];
      return { status: 409, code: DUPLICATE_KEY_CODES[key] ?? 'CONFLICT', message: `duplicate ${key ?? 'key'}` };
    }
    default: break;
  }
  if (err?.name === 'SyncStageError') {
    if (SYNC_STAGE_422.has(err.code)) return { status: 422, code: err.code, message: err.message, details: err.detail };
    return { status: 502, code: 'SYNC_FAILED', message: err.message, details: { cause: err.code } };
  }
  if (err instanceof FplError) {
    // An FPL outage or block is reported as such, never as an empty league.
    return { status: 502, code: 'FPL_UNAVAILABLE', message: 'the FPL API could not be reached or refused the request', details: { cause: classifyFailure(err) } };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'internal error' };
}

export function errorHandler({ log = console.error } = {}) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    const { status, code, message, details } = mapError(err);
    if (status >= 500) log(`[${req.method} ${req.originalUrl}] ${code}:`, err);
    res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
  };
}
