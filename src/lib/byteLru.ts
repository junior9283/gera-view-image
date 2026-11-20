/**
 * LRU limitado por bytes: `get` move a entrada para o fim; ao passar de `maxBytes` saem as mais
 * antigas. A entrada recém-inserida sempre fica, mesmo que sozinha passe do orçamento.
 */
export class ByteLru<K, V> {
  private map = new Map<K, { v: V; size: number }>();
  bytes = 0;

  constructor(
    private maxBytes: number,
    private sizeOf: (v: V) => number,
  ) {}

  get(k: K): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: K, v: V): void {
    this.delete(k);
    const size = this.sizeOf(v);
    this.map.set(k, { v, size });
    this.bytes += size;
    for (const old of this.map.keys()) {
      if (this.bytes <= this.maxBytes || old === k) break;
      this.delete(old);
    }
  }

  delete(k: K): void {
    const e = this.map.get(k);
    if (!e) return;
    this.map.delete(k);
    this.bytes -= e.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}
