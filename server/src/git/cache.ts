/**
 * Generic LRU (Least Recently Used) cache.
 *
 * Uses a Map for O(1) insertion-order tracking (Map preserves insertion order
 * in JS). On access, entries are deleted and re-inserted to move them to the
 * end (most recent). Eviction removes from the front (oldest).
 *
 * Supports optional invalidation predicates keyed by event type.
 */

export class LruCache<K, V> {
  private readonly map = new Map<K, V>()
  private readonly maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first key in insertion order)
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) {
        this.map.delete(oldest)
      }
    }
    this.map.set(key, value)
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  /** Delete all entries whose key matches the predicate. */
  invalidate(predicate: (key: K) => boolean): number {
    let count = 0
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) {
        this.map.delete(key)
        count++
      }
    }
    return count
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }

  /** Get or compute: returns cached value or calls factory, caches, and returns the result. */
  async getOrCompute(key: K, factory: () => Promise<V>): Promise<V> {
    const existing = this.get(key)
    if (existing !== undefined) return existing
    const value = await factory()
    this.set(key, value)
    return value
  }

  /** Inflight request collapsing: deduplicates concurrent identical requests. */
  private readonly inflight = new Map<K, Promise<V>>()

  async getOrComputeDedup(key: K, factory: () => Promise<V>): Promise<V> {
    const existing = this.get(key)
    if (existing !== undefined) return existing

    const pending = this.inflight.get(key)
    if (pending) return pending

    const promise = factory().then((value) => {
      this.set(key, value)
      this.inflight.delete(key)
      return value
    }).catch((err) => {
      this.inflight.delete(key)
      throw err
    })

    this.inflight.set(key, promise)
    return promise
  }
}
