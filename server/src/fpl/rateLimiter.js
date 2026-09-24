import Bottleneck from 'bottleneck';

// Thin adapter over bottleneck 2.19 configured as a token bucket:
// `capacity` requests may start immediately, then one more every
// 1000 / refillPerSecond ms. Jobs start in FIFO order.
// FPL does not publish rate limits, so defaults are deliberately conservative.

export const DEFAULT_RATE_LIMIT = Object.freeze({
  capacity: 5, // burst size
  refillPerSecond: 2, // sustained requests per second
});

export function createRateLimiter({ capacity, refillPerSecond } = DEFAULT_RATE_LIMIT) {
  if (!(Number.isInteger(capacity) && capacity >= 1) || !(refillPerSecond > 0)) {
    throw new RangeError('capacity must be an integer >= 1 and refillPerSecond > 0');
  }
  const intervalMs = 1000 / refillPerSecond;
  const bottleneck = new Bottleneck({
    reservoir: capacity,
    reservoirIncreaseAmount: 1,
    reservoirIncreaseInterval: intervalMs,
    reservoirIncreaseMaximum: capacity,
    // Heartbeat granularity for the refill check; the timer is unref'd by bottleneck.
    heartbeatInterval: Math.max(5, Math.floor(intervalMs / 4)),
  });

  return {
    // Runs fn once a token is available; resolves/rejects with fn's outcome.
    schedule: (fn) => bottleneck.schedule(fn),
    availableTokens: () => bottleneck.currentReservoir(),
    stop: () => bottleneck.stop({ dropWaitingJobs: true }),
  };
}
