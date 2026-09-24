import { describe, expect, it } from "vitest";

import { LeaseCache } from "./lease-cache";

class Resource {
  closed = false;
  constructor(readonly name: string) {}
  close() {
    this.closed = true;
  }
}

describe("LeaseCache", () => {
  it("opens once per key and reuses the value", async () => {
    const cache = new LeaseCache<Resource>({ maxEntries: 2, idleMs: 1000 });
    let opens = 0;
    const open = async () => {
      opens += 1;
      return new Resource("a");
    };
    const first = await cache.use("a", open, async (value) => value);
    const second = await cache.use("a", open, async (value) => value);
    expect(second).toBe(first);
    expect(opens).toBe(1);
  });

  it("closes the least recently used value past the limit", async () => {
    const cache = new LeaseCache<Resource>({ maxEntries: 2, idleMs: 1000 });
    const a = await cache.use("a", async () => new Resource("a"), async (v) => v);
    const b = await cache.use("b", async () => new Resource("b"), async (v) => v);
    await cache.use("a", async () => new Resource("a2"), async (v) => v);
    await cache.use("c", async () => new Resource("c"), async (v) => v);
    await Promise.resolve();
    expect(b.closed).toBe(true);
    expect(a.closed).toBe(false);
    expect(cache.size).toBe(2);
  });

  it("never closes a value while a request still uses it", async () => {
    const cache = new LeaseCache<Resource>({ maxEntries: 1, idleMs: 1000 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen: Resource | null = null;
    const inUse = cache.use("a", async () => new Resource("a"), async (value) => {
      seen = value;
      await held;
      return value.closed;
    });
    await Promise.resolve();
    await Promise.resolve();
    await cache.use("b", async () => new Resource("b"), async (v) => v);
    release();
    expect(await inUse).toBe(false);
    await Promise.resolve();
    expect(seen!.closed).toBe(true);
  });

  it("does not cache a failed open", async () => {
    const cache = new LeaseCache<Resource>({ maxEntries: 2, idleMs: 1000 });
    await expect(
      cache.use("a", async () => {
        throw new Error("broken file");
      }, async (v) => v),
    ).rejects.toThrow("broken file");
    const value = await cache.use("a", async () => new Resource("a"), async (v) => v);
    expect(value.name).toBe("a");
  });

  it("sweeps values idle past the limit", async () => {
    let now = 0;
    const cache = new LeaseCache<Resource>({
      maxEntries: 4,
      idleMs: 1000,
      now: () => now,
    });
    const a = await cache.use("a", async () => new Resource("a"), async (v) => v);
    now = 1500;
    cache.sweep();
    await Promise.resolve();
    expect(a.closed).toBe(true);
    expect(cache.size).toBe(0);
  });
});
