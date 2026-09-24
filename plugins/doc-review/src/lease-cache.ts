// A small LRU of open resources — here, parsed workbooks — that are closed
// when evicted, but never while a request is still using them.
//
// Switching sheets re-reads one sheet from an already parsed workbook
// (shared strings, styles, theme); without this cache every tab click would
// parse the workbook again.

export interface Closable {
  close(): void;
}

interface Entry<T extends Closable> {
  value: Promise<T>;
  usedAtMs: number;
  leases: number;
  evicted: boolean;
}

export class LeaseCache<T extends Closable> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #maxEntries: number;
  readonly #idleMs: number;
  readonly #now: () => number;

  constructor(options: { maxEntries: number; idleMs: number; now?: () => number }) {
    this.#maxEntries = options.maxEntries;
    this.#idleMs = options.idleMs;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Runs `use` with the value for `key`, opening it on a miss. The value
   * stays open until `use` settles even if it is evicted meanwhile; a failed
   * open is not cached.
   */
  async use<R>(
    key: string,
    open: () => Promise<T>,
    use: (value: T) => Promise<R>,
  ): Promise<R> {
    this.sweep();
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { value: open(), usedAtMs: this.#now(), leases: 0, evicted: false };
      this.#entries.set(key, entry);
      const opened = entry;
      opened.value.catch(() => {
        if (this.#entries.get(key) === opened) this.#entries.delete(key);
      });
      this.#evictOverflow();
    }
    // Most recently used last, so eviction walks from the front.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    entry.usedAtMs = this.#now();
    entry.leases += 1;
    try {
      return await use(await entry.value);
    } finally {
      entry.leases -= 1;
      entry.usedAtMs = this.#now();
      if (entry.evicted && entry.leases === 0) void closeEntry(entry);
    }
  }

  /** Evicts entries idle past the limit. */
  sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.leases === 0 && now - entry.usedAtMs > this.#idleMs) {
        this.#evict(key, entry);
      }
    }
  }

  /** Evicts everything; values in use close when their requests finish. */
  clear(): void {
    for (const [key, entry] of this.#entries) this.#evict(key, entry);
  }

  get size(): number {
    return this.#entries.size;
  }

  #evictOverflow(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxEntries) return;
      this.#evict(key, entry);
    }
  }

  #evict(key: string, entry: Entry<T>): void {
    this.#entries.delete(key);
    entry.evicted = true;
    if (entry.leases === 0) void closeEntry(entry);
  }
}

async function closeEntry<T extends Closable>(entry: Entry<T>): Promise<void> {
  try {
    (await entry.value).close();
  } catch {
    // A value that failed to open has nothing to close.
  }
}
