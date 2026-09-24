// Error classification for the FPL client boundary.
// Every failure surfaced by the client is an FplError with a stable `kind`.

export const FplErrorKind = Object.freeze({
  TIMEOUT: 'timeout', // request exceeded timeoutMs
  NETWORK: 'network', // DNS, connection reset, TLS, etc.
  RATE_LIMITED: 'rate_limited', // upstream HTTP 429
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable', // upstream HTTP 5xx
  NOT_FOUND: 'not_found', // upstream HTTP 404
  HTTP: 'http', // any other non-2xx status
  INVALID_RESPONSE: 'invalid_response', // body is not JSON
  VALIDATION: 'validation', // JSON does not match the expected shape
  CIRCUIT_OPEN: 'circuit_open', // breaker rejected the call without a request
});

const RETRYABLE = new Set([
  FplErrorKind.TIMEOUT,
  FplErrorKind.NETWORK,
  FplErrorKind.RATE_LIMITED,
  FplErrorKind.UPSTREAM_UNAVAILABLE,
]);

export class FplError extends Error {
  constructor(kind, message, { status, url, retryAfterMs, issues, cause } = {}) {
    super(message, { cause });
    this.name = 'FplError';
    this.kind = kind;
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    this.issues = issues;
  }

  get retryable() {
    return RETRYABLE.has(this.kind);
  }

  // Failures that indicate the upstream is unhealthy (count toward the breaker).
  get upstreamFailure() {
    return RETRYABLE.has(this.kind);
  }
}

export function classifyStatus(status) {
  if (status === 404) return FplErrorKind.NOT_FOUND;
  if (status === 429) return FplErrorKind.RATE_LIMITED;
  if (status >= 500) return FplErrorKind.UPSTREAM_UNAVAILABLE;
  return FplErrorKind.HTTP;
}

// Retry-After per RFC 9110: delay-seconds or an HTTP-date.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
