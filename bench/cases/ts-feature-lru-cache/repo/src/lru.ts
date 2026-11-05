/** A fixed-capacity least-recently-used cache. */
export class LruCache<K, V> {
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(_key: K): V | undefined {
    throw new Error("not implemented");
  }

  set(_key: K, _value: V): void {
    throw new Error("not implemented");
  }

  get size(): number {
    return 0;
  }
}
