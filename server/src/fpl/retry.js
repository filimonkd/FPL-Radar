// Retry with exponential backoff and full jitter.
// Only errors with `retryable === true` are retried. A server-supplied
// Retry-After (err.retryAfterMs) is honoured, capped at maxDelayMs.

export const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
});

export function backoffDelay(attempt, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

export async function withRetry(fn, { policy = DEFAULT_RETRY, sleep, random = Math.random, onRetry } = {}) {
  const { maxAttempts } = policy;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!err?.retryable || attempt >= maxAttempts) throw err;
      const delayMs =
        err.retryAfterMs != null
          ? Math.min(err.retryAfterMs, policy.maxDelayMs)
          : backoffDelay(attempt, policy, random);
      onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
