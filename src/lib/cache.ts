/** Small in-memory TTL + LRU cache. Process-local; fine for a single stateless instance. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number; storedAt: number }>();

  constructor(
    private readonly maxEntries = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): { value: V; storedAt: number } | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, hit);
    return { value: hit.value, storedAt: hit.storedAt };
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs, storedAt: this.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Returns the cached value or computes, stores and returns it. Concurrent misses share one call. */
  async getOrLoad(key: string, ttlMs: number, load: () => Promise<V>): Promise<{ value: V; storedAt: number; cached: boolean }> {
    const hit = this.get(key);
    if (hit) return { ...hit, cached: true };
    let p = this.inflight.get(key);
    if (!p) {
      p = load().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const value = await p;
    this.set(key, value, ttlMs);
    return { value, storedAt: this.now(), cached: false };
  }

  private readonly inflight = new Map<string, Promise<V>>();
}
