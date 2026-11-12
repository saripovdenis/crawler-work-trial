/** Bounded access-order cache. Values larger than the byte budget are not kept. */
export class LruCache<K, V> {
  private entries = new Map<K, { value: V; bytes: number }>();
  private bytes = 0;
  evictions = 0;
  constructor(readonly limit: number, readonly maxBytes = Infinity) {}
  get size() { return this.entries.size; }
  get byteSize() { return this.bytes; }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: K, value: V, bytes = 1) {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (this.entries.size > this.limit || this.bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value!); this.evictions++;
    }
  }
  delete(key: K) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
}
