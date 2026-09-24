// In-memory TTL cache with LRU eviction and single-flight de-duplication.
// Process-local by design; persistence belongs to later steps.

export class TtlCache {
  #entries = new Map(); // key -> { value, expiresAt }
  #inFlight = new Map(); // key -> Promise

  constructor({ maxEntries = 500, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency for LRU.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!(ttlMs > 0)) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.#entries.size > this.maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
  }

  delete(key) {
    this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    return this.#entries.size;
  }

  // Returns a cached value, or runs loader once for concurrent callers of the same key.
  // Failures are never cached.
  async getOrLoad(key, ttlMs, loader) {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };

    let pending = this.#inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const value = await loader();
          this.set(key, value, ttlMs);
          return value;
        } finally {
          this.#inFlight.delete(key);
        }
      })();
      this.#inFlight.set(key, pending);
    }
    return { value: await pending, cached: false };
  }
}
