/** A fixed-capacity least-recently-used cache. */
export class LruCache<K, V> {
  readonly capacity: number;
  #entries = new Map<K, V>();

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError(`capacity must be at least 1, got ${capacity}`);
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as V;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next().value as K;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
