import { FplError, FplErrorKind, classifyStatus, parseRetryAfter } from './errors.js';
import { withRetry, DEFAULT_RETRY } from './retry.js';
import { createRateLimiter, DEFAULT_RATE_LIMIT } from './rateLimiter.js';
import { CircuitBreaker, DEFAULT_BREAKER } from './circuitBreaker.js';
import { TtlCache } from './cache.js';
import { validate } from './validate.js';
import * as schemas from './schemas.js';
import { DEFAULT_FPL_API_BASE_URL } from './baseUrl.js';
import { sha256Bytes } from '../utils/canonical.js';

// FPL API client boundary. Independent of persistence: it only fetches,
// validates and caches in memory.
//
// Request pipeline (per call):
//   cache / single-flight (lru-cache) -> retry( circuit breaker( rate limit (bottleneck) -> fetch with timeout ) )
//   -> validate (zod)
//
// Returned objects may be shared with the cache: treat them as read-only.

export const DEFAULT_BASE_URL = DEFAULT_FPL_API_BASE_URL;
export const DEFAULT_TIMEOUT_MS = 10_000;

// Cache TTLs in ms. Values are app policy, not FPL guidance.
export const DEFAULT_TTLS = Object.freeze({
  bootstrapStatic: 5 * 60_000,
  fixtures: 5 * 60_000,
  eventLive: 60_000,
  eventStatus: 60_000,
  entry: 5 * 60_000,
  entryHistory: 5 * 60_000,
  entryPicks: 5 * 60_000,
  entryTransfers: 5 * 60_000,
  classicLeagueStandings: 2 * 60_000,
});

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function positiveInt(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

export function createFplClient(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retry = DEFAULT_RETRY,
    rateLimit = DEFAULT_RATE_LIMIT,
    breaker: breakerOptions = DEFAULT_BREAKER,
    ttls = {},
    maxCacheEntries = 500,
    userAgent = 'fpl-radar',
    onEvent, // logging hook: ({ type, ...details }) => void
    now = Date.now,
    sleep = realSleep,
    random = Math.random,
  } = options;

  const ttl = { ...DEFAULT_TTLS, ...ttls };
  const retryPolicy = { ...DEFAULT_RETRY, ...retry };

  const emit = (event) => {
    if (!onEvent) return;
    try {
      onEvent({ timestamp: now(), ...event });
    } catch {
      // A faulty logger must never break a request.
    }
  };

  const limiter = createRateLimiter({ ...DEFAULT_RATE_LIMIT, ...rateLimit });
  const breaker = new CircuitBreaker(
    { ...DEFAULT_BREAKER, ...breakerOptions },
    { now, onStateChange: (change) => emit({ type: 'circuit_state', ...change }) },
  );
  const cache = new TtlCache({ maxEntries: maxCacheEntries, now });

  // The rate limiter gates when each attempt starts; the timeout starts with the request.
  function fetchOnce(path, attempt) {
    return limiter.schedule(() => performRequest(path, attempt));
  }

  async function performRequest(path, attempt) {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = now();
    emit({ type: 'request', method: 'GET', url, attempt });

    try {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': userAgent },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new FplError(FplErrorKind.TIMEOUT, `FPL request timed out after ${timeoutMs}ms`, { url, cause: err });
        }
        throw new FplError(FplErrorKind.NETWORK, `FPL network error: ${err.message}`, { url, cause: err });
      }

      emit({ type: 'response', method: 'GET', url, attempt, status: res.status, durationMs: now() - started });

      let bytes;
      try {
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (controller.signal.aborted) {
          throw new FplError(FplErrorKind.TIMEOUT, `FPL response body timed out after ${timeoutMs}ms`, { url, cause: err });
        }
        throw new FplError(FplErrorKind.NETWORK, `FPL body read failed: ${err.message}`, { url, status: res.status, cause: err });
      }
      // What the response was, for the sync request log and raw capture (v0.3 §8, §9).
      const response = {
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodySha256: sha256Bytes(bytes),
        bytes: bytes.length,
        body: bytes, // the exact bytes bodySha256 was computed over
        get text() {
          return bytes.toString('utf8');
        },
        denyReason: res.headers.get('x-deny-reason'),
        cfMitigated: res.headers.get('cf-mitigated'),
        location: res.headers.get('location'),
      };

      if (!res.ok) {
        const kind = classifyStatus(res.status);
        throw new FplError(kind, `FPL responded ${res.status} for ${path}`, {
          url,
          status: res.status,
          retryAfterMs: kind === FplErrorKind.RATE_LIMITED
            ? parseRetryAfter(res.headers.get('retry-after'), now())
            : undefined,
          response,
        });
      }

      try {
        return { json: JSON.parse(response.text), response };
      } catch (err) {
        throw new FplError(FplErrorKind.INVALID_RESPONSE, `FPL returned a non-JSON body for ${path}`, {
          url,
          status: res.status,
          cause: err,
          response,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // One logical call → one request-log entry (retries included in durationMs).
  // The cache keeps the response metadata with the data, so a cache hit logs the
  // hash of the bytes that were actually fetched, with fromCache: true.
  async function request(name, path, log) {
    const key = path;
    const started = now();
    const record = (entry) => {
      if (!log) return;
      try {
        log({ name, path, durationMs: Math.max(0, Math.round(now() - started)), ...entry });
      } catch {
        // A faulty request logger must never break a request.
      }
    };
    try {
      const { value, cached } = await cache.getOrLoad(key, ttl[name], async () => {
        const { json, response } = await withRetry((attempt) => breaker.execute(() => fetchOnce(path, attempt)), {
          policy: retryPolicy,
          sleep,
          random,
          onRetry: ({ attempt, delayMs, error }) =>
            emit({ type: 'retry', path, attempt, delayMs, errorKind: error.kind, status: error.status }),
        });

        const { ok, data, issues } = validate(schemas[name], json);
        if (!ok) {
          throw new FplError(FplErrorKind.VALIDATION, `FPL ${name} response failed validation`, {
            url: `${baseUrl}${path}`,
            status: response.status,
            issues,
            response,
          });
        }
        return { data, response };
      });
      if (cached) emit({ type: 'cache_hit', path });
      record({ ok: true, fromCache: cached, schemaOk: true, response: value.response });
      return value.data;
    } catch (err) {
      emit({ type: 'error', path, errorKind: err.kind, status: err.status, message: err.message, issues: err.issues });
      record({
        ok: false, fromCache: false, schemaOk: err.kind === FplErrorKind.VALIDATION ? false : null, response: err.response ?? null, error: err,
      });
      throw err;
    }
  }

  const methods = (log) => ({
    getBootstrapStatic: async () => request('bootstrapStatic', '/bootstrap-static/', log),

    getFixtures: async ({ event } = {}) =>
      request('fixtures', event === undefined ? '/fixtures/' : `/fixtures/?event=${positiveInt('event', event)}`, log),

    getEventLive: async (event) => request('eventLive', `/event/${positiveInt('event', event)}/live/`, log),

    getEventStatus: async () => request('eventStatus', '/event-status/', log),

    getEntry: async (entryId) => request('entry', `/entry/${positiveInt('entryId', entryId)}/`, log),

    getEntryHistory: async (entryId) => request('entryHistory', `/entry/${positiveInt('entryId', entryId)}/history/`, log),

    getEntryPicks: async (entryId, event) =>
      request('entryPicks', `/entry/${positiveInt('entryId', entryId)}/event/${positiveInt('event', event)}/picks/`, log),

    getEntryTransfers: async (entryId) =>
      request('entryTransfers', `/entry/${positiveInt('entryId', entryId)}/transfers/`, log),

    getClassicLeagueStandings: async (leagueId, { page = 1 } = {}) =>
      request(
        'classicLeagueStandings',
        `/leagues-classic/${positiveInt('leagueId', leagueId)}/standings/?page_standings=${positiveInt('page', page)}`,
        log,
      ),
  });

  return {
    ...methods(undefined),

    /**
     * The same endpoint methods, reporting every call to `log(entry)`:
     * { name, path, ok, durationMs, fromCache, schemaOk, response, error? } where
     * response = { status, contentType, bodySha256, bytes, body (Buffer), text, denyReason, cfMitigated, location }
     * (null when no response arrived). Used by the sync to fill syncRuns.requests[].
     */
    withRequestLog: (log) => methods(log),

    // Introspection for health checks and tests.
    get circuitState() {
      return breaker.state;
    },
    clearCache: () => cache.clear(),
    // Stops the rate limiter; queued requests are dropped.
    close: () => limiter.stop(),
  };
}
