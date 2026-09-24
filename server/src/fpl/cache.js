import { LRUCache } from 'lru-cache';

// Thin adapter over lru-cache 11: per-entry TTL, LRU eviction and single-flight
// loading via LRUCache#fetch. Failures are never cached. Process-local by design.

export class TtlCache {
  #lru;

  constructor({ maxEntries = 500, now = () => performance.now() } = {}) {
    this.#lru = new LRUCache({
      max: maxEntries,
      perf: { now },
      ttlResolution: 0, // always read the clock; entries expire exactly at ttl
      fetchMethod: async (_key, _stale, { context }) => context(),
    });
  }

  get(key) {
    return this.#lru.get(key);
  }

  set(key, value, ttlMs) {
    if (!(ttlMs > 0)) return;
    this.#lru.set(key, value, { ttl: ttlMs });
  }

  delete(key) {
    this.#lru.delete(key);
  }

  clear() {
    this.#lru.clear();
  }

  get size() {
    return this.#lru.size;
  }

  // Returns a cached value, or runs loader once for concurrent callers of the same key.
  // ttlMs <= 0 disables caching for the call (no storage, no de-duplication).
  async getOrLoad(key, ttlMs, loader) {
    if (!(ttlMs > 0)) return { value: await loader(), cached: false };
    const status = {};
    const value = await this.#lru.fetch(key, { ttl: ttlMs, context: loader, status });
    return { value, cached: status.fetch === 'hit' };
  }
}
