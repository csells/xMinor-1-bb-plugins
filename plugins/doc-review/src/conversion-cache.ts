// An on-disk cache of converted documents, one directory per entry.
//
// One directory per entry is what lets the preview transport stay narrow: a
// preview lease covers a whole directory, so each converted PDF gets a
// directory of its own and a lease on it exposes nothing else.
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";

export interface CacheOptions {
  root: string;
  /** Oldest entries go first once the cache grows past this. */
  maxBytes: number;
  /** Entries unused for this long are dropped on the next prune. */
  maxAgeMs: number;
  now?: () => number;
}

/** A stable cache key from the facts that identify one version of a file. */
export function cacheKey(parts: readonly (string | number | null)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
}

export class ConversionCache {
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #inFlight = new Map<string, Promise<string>>();
  #pruning: Promise<void> | null = null;

  constructor(options: CacheOptions) {
    this.#root = options.root;
    this.#maxBytes = options.maxBytes;
    this.#maxAgeMs = options.maxAgeMs;
    this.#now = options.now ?? Date.now;
  }

  get root(): string {
    return this.#root;
  }

  /**
   * The cached file for `key`, produced on a miss. `produce` works in a
   * private staging directory and returns the path of its output there; the
   * output is then moved into the entry under `fileName`. Concurrent calls
   * for one key share a single production.
   */
  async getOrCreate(
    key: string,
    fileName: string,
    produce: (stagingDir: string) => Promise<string>,
  ): Promise<string> {
    const entryDir = path.join(this.#root, key);
    const target = path.join(entryDir, fileName);
    if (await isNonEmptyFile(target)) {
      await this.#touch(entryDir);
      return target;
    }

    const pending = this.#inFlight.get(key);
    if (pending) return await pending;

    const production = this.#produce(entryDir, target, produce);
    this.#inFlight.set(key, production);
    try {
      return await production;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #produce(
    entryDir: string,
    target: string,
    produce: (stagingDir: string) => Promise<string>,
  ): Promise<string> {
    const staging = path.join(this.#root, `.staging-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      const output = await produce(staging);
      // A stale entry directory (a different file name, a half-written
      // leftover) is replaced wholesale.
      await rm(entryDir, { recursive: true, force: true });
      await mkdir(entryDir, { recursive: true });
      await rename(output, target);
      return target;
    } finally {
      await rm(staging, { recursive: true, force: true });
      void this.prune();
    }
  }

  /** Drops entries past the age limit, then the oldest past the size limit. */
  prune(): Promise<void> {
    this.#pruning ??= this.#prune().finally(() => {
      this.#pruning = null;
    });
    return this.#pruning;
  }

  async #prune(): Promise<void> {
    const names = await readdir(this.#root).catch(() => [] as string[]);
    const now = this.#now();
    const entries: { dir: string; usedAtMs: number; bytes: number }[] = [];
    for (const name of names) {
      const dir = path.join(this.#root, name);
      const info = await stat(dir).catch(() => null);
      if (!info?.isDirectory()) continue;
      if (name.startsWith(".staging-")) {
        // A crash mid-conversion leaves staging behind; an hour is far past
        // any conversion's timeout.
        if (now - info.mtimeMs > 60 * 60 * 1000) {
          await rm(dir, { recursive: true, force: true });
        }
        continue;
      }
      entries.push({ dir, usedAtMs: info.mtimeMs, bytes: await directorySize(dir) });
    }

    entries.sort((left, right) => left.usedAtMs - right.usedAtMs);
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      const expired = now - entry.usedAtMs > this.#maxAgeMs;
      if (!expired && total <= this.#maxBytes) continue;
      if (this.#inFlightFor(entry.dir)) continue;
      await rm(entry.dir, { recursive: true, force: true });
      total -= entry.bytes;
    }
  }

  #inFlightFor(dir: string): boolean {
    return this.#inFlight.has(path.basename(dir));
  }

  async #touch(dir: string): Promise<void> {
    const at = new Date(this.#now());
    await utimes(dir, at, at).catch(() => undefined);
  }
}

async function isNonEmptyFile(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile() && info.size > 0);
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += (await stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}
