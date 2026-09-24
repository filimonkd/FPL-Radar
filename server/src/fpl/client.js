import { FplError, FplErrorKind, classifyStatus, parseRetryAfter } from './errors.js';
import { withRetry, DEFAULT_RETRY } from './retry.js';
import { RateLimiter, DEFAULT_RATE_LIMIT } from './rateLimiter.js';
import { CircuitBreaker, DEFAULT_BREAKER } from './circuitBreaker.js';
import { TtlCache } from './cache.js';
import { validate } from './validate.js';
import * as schemas from './schemas.js';

// FPL API client boundary. Independent of persistence: it only fetches,
// validates and caches in memory.
//
// Request pipeline (per call):
//   cache / single-flight -> retry( circuit breaker( rate limit -> fetch with timeout ) ) -> validate
//
// Returned objects may be shared with the cache: treat them as read-only.

export const DEFAULT_BASE_URL = 'https://fantasy.premierleague.com/api';
export const DEFAULT_TIMEOUT_MS = 10_000;

// Cache TTLs in ms. Values are app policy, not FPL guidance.
export const DEFAULT_TTLS = Object.freeze({
  bootstrapStatic: 5 * 60_000,
  fixtures: 5 * 60_000,
  eventLive: 60_000,
  elementSummary: 10 * 60_000,
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

  const limiter = new RateLimiter({ ...DEFAULT_RATE_LIMIT, ...rateLimit }, { now, sleep });
  const breaker = new CircuitBreaker(
    { ...DEFAULT_BREAKER, ...breakerOptions },
    { now, onStateChange: (change) => emit({ type: 'circuit_state', ...change }) },
  );
  const cache = new TtlCache({ maxEntries: maxCacheEntries, now });

  async function fetchOnce(path, attempt) {
    await limiter.acquire();

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

      if (!res.ok) {
        const kind = classifyStatus(res.status);
        throw new FplError(kind, `FPL responded ${res.status} for ${path}`, {
          url,
          status: res.status,
          retryAfterMs: kind === FplErrorKind.RATE_LIMITED
            ? parseRetryAfter(res.headers.get('retry-after'), now())
            : undefined,
        });
      }

      try {
        return await res.json();
      } catch (err) {
        if (controller.signal.aborted) {
          throw new FplError(FplErrorKind.TIMEOUT, `FPL response body timed out after ${timeoutMs}ms`, { url, cause: err });
        }
        throw new FplError(FplErrorKind.INVALID_RESPONSE, `FPL returned a non-JSON body for ${path}`, {
          url,
          status: res.status,
          cause: err,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(name, path) {
    const key = path;
    try {
      const { value, cached } = await cache.getOrLoad(key, ttl[name], async () => {
        const body = await withRetry((attempt) => breaker.execute(() => fetchOnce(path, attempt)), {
          policy: retryPolicy,
          sleep,
          random,
          onRetry: ({ attempt, delayMs, error }) =>
            emit({ type: 'retry', path, attempt, delayMs, errorKind: error.kind, status: error.status }),
        });

        const issues = validate(schemas[name], body);
        if (issues.length > 0) {
          throw new FplError(FplErrorKind.VALIDATION, `FPL ${name} response failed validation`, {
            url: `${baseUrl}${path}`,
            issues,
          });
        }
        return body;
      });
      if (cached) emit({ type: 'cache_hit', path });
      return value;
    } catch (err) {
      emit({ type: 'error', path, errorKind: err.kind, status: err.status, message: err.message, issues: err.issues });
      throw err;
    }
  }

  return {
    getBootstrapStatic: async () => request('bootstrapStatic', '/bootstrap-static/'),

    getFixtures: async ({ event } = {}) =>
      request('fixtures', event === undefined ? '/fixtures/' : `/fixtures/?event=${positiveInt('event', event)}`),

    getEventLive: async (event) => request('eventLive', `/event/${positiveInt('event', event)}/live/`),

    getElementSummary: async (elementId) =>
      request('elementSummary', `/element-summary/${positiveInt('elementId', elementId)}/`),

    getEntry: async (entryId) => request('entry', `/entry/${positiveInt('entryId', entryId)}/`),

    getEntryHistory: async (entryId) => request('entryHistory', `/entry/${positiveInt('entryId', entryId)}/history/`),

    getEntryPicks: async (entryId, event) =>
      request('entryPicks', `/entry/${positiveInt('entryId', entryId)}/event/${positiveInt('event', event)}/picks/`),

    getEntryTransfers: async (entryId) =>
      request('entryTransfers', `/entry/${positiveInt('entryId', entryId)}/transfers/`),

    getClassicLeagueStandings: async (leagueId, { page = 1 } = {}) =>
      request(
        'classicLeagueStandings',
        `/leagues-classic/${positiveInt('leagueId', leagueId)}/standings/?page_standings=${positiveInt('page', page)}`,
      ),

    // Introspection for health checks and tests.
    get circuitState() {
      return breaker.state;
    },
    clearCache: () => cache.clear(),
  };
}
