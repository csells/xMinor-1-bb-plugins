import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cacheKey, ConversionCache } from "./conversion-cache";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pdf-viewer-cache-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function writer(content: string, calls: { count: number }) {
  return async (staging: string) => {
    calls.count += 1;
    const output = path.join(staging, "out.pdf");
    await writeFile(output, content);
    return output;
  };
}

describe("cacheKey", () => {
  it("is stable and sensitive to every part", () => {
    expect(cacheKey(["a", 1, null])).toBe(cacheKey(["a", 1, null]));
    expect(cacheKey(["a", 1])).not.toBe(cacheKey(["a", 2]));
    expect(cacheKey(["ab", "c"])).not.toBe(cacheKey(["a", "bc"]));
  });
});

describe("ConversionCache", () => {
  it("produces once and serves the entry afterwards", async () => {
    const cache = new ConversionCache({ root, maxBytes: 1e9, maxAgeMs: 1e9 });
    const calls = { count: 0 };
    const first = await cache.getOrCreate("k1", "Отчёт.pdf", writer("pdf", calls));
    const second = await cache.getOrCreate("k1", "Отчёт.pdf", writer("pdf", calls));
    expect(first).toBe(path.join(root, "k1", "Отчёт.pdf"));
    expect(second).toBe(first);
    expect(calls.count).toBe(1);
    expect(await readFile(first, "utf8")).toBe("pdf");
  });

  it("shares one production between concurrent callers", async () => {
    const cache = new ConversionCache({ root, maxBytes: 1e9, maxAgeMs: 1e9 });
    const calls = { count: 0 };
    const results = await Promise.all(
      [1, 2, 3].map(() => cache.getOrCreate("k", "a.pdf", writer("x", calls))),
    );
    expect(new Set(results).size).toBe(1);
    expect(calls.count).toBe(1);
  });

  it("leaves no staging behind, on success or failure", async () => {
    const cache = new ConversionCache({ root, maxBytes: 1e9, maxAgeMs: 1e9 });
    await cache.getOrCreate("ok", "a.pdf", writer("x", { count: 0 }));
    await expect(
      cache.getOrCreate("bad", "a.pdf", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const names = await readdir(root);
    expect(names.filter((name) => name.startsWith(".staging-"))).toEqual([]);
    expect(names).not.toContain("bad");
  });

  it("drops the oldest entries past the size limit and expired ones", async () => {
    let now = Date.now();
    const cache = new ConversionCache({
      root,
      maxBytes: 10,
      maxAgeMs: 60_000,
      now: () => now,
    });
    const make = (text: string) => async (staging: string) => {
      const output = path.join(staging, "o");
      await writeFile(output, text);
      return output;
    };
    await cache.getOrCreate("old", "a.pdf", make("123456"));
    await cache.getOrCreate("new", "a.pdf", make("123456"));
    // Make "old" older than "new" regardless of file-system time resolution.
    const past = new Date(now - 30_000);
    await utimes(path.join(root, "old"), past, past);
    await cache.prune();
    expect(await readdir(root)).toEqual(["new"]);

    now += 120_000;
    await cache.prune();
    expect(await readdir(root)).toEqual([]);
  });

  it("replaces an entry directory left half-written", async () => {
    const cache = new ConversionCache({ root, maxBytes: 1e9, maxAgeMs: 1e9 });
    await cache.getOrCreate("k", "a.pdf", writer("x", { count: 0 }));
    // An empty file is not a valid entry and must be produced again.
    await writeFile(path.join(root, "k", "a.pdf"), "");
    const calls = { count: 0 };
    const file = await cache.getOrCreate("k", "a.pdf", writer("fresh", calls));
    expect(calls.count).toBe(1);
    expect((await stat(file)).size).toBe(5);
  });
});
