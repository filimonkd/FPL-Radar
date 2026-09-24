// Token-bucket rate limiter. Callers await acquire(); requests are served FIFO.
// FPL does not publish rate limits, so defaults are deliberately conservative.

export const DEFAULT_RATE_LIMIT = Object.freeze({
  capacity: 5, // burst size
  refillPerSecond: 2, // sustained requests per second
});

export class RateLimiter {
  #tokens;
  #lastRefill;
  #queue = Promise.resolve();

  constructor({ capacity, refillPerSecond } = DEFAULT_RATE_LIMIT, { now = Date.now, sleep } = {}) {
    if (!(capacity >= 1) || !(refillPerSecond > 0)) {
      throw new RangeError('capacity must be >= 1 and refillPerSecond > 0');
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.sleep = sleep;
    this.#tokens = capacity;
    this.#lastRefill = now();
  }

  #refill() {
    const t = this.now();
    const elapsed = (t - this.#lastRefill) / 1000;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsed * this.refillPerSecond);
    this.#lastRefill = t;
  }

  // Serialises waiters so ordering is FIFO and tokens are never double-spent.
  acquire() {
    const turn = this.#queue.then(async () => {
      this.#refill();
      while (this.#tokens < 1) {
        const waitMs = Math.ceil(((1 - this.#tokens) / this.refillPerSecond) * 1000);
        await this.sleep(waitMs);
        this.#refill();
      }
      this.#tokens -= 1;
    });
    this.#queue = turn.catch(() => {});
    return turn;
  }

  get availableTokens() {
    this.#refill();
    return this.#tokens;
  }
}
