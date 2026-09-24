import { describe, expect, it } from "vitest";

import { contentDisposition, DocumentRegistry, parseRange } from "./documents";

describe("parseRange", () => {
  it("serves the whole body when there is no usable header", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("items=0-10", 100)).toBeNull();
    // A multi-range request legally degrades to the full body.
    expect(parseRange("bytes=0-10,20-30", 100)).toBeNull();
  });

  it("reads closed, open and suffix ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end past the last byte", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("rejects ranges that cannot be satisfied", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=50-10", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-10", 0)).toBe("unsatisfiable");
  });
});

describe("contentDisposition", () => {
  it("keeps a non-ASCII name in filename* and stays quotable", () => {
    const value = contentDisposition('Отчёт "Q3".pdf');
    expect(value.startsWith("inline; ")).toBe(true);
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent('Отчёт "Q3".pdf'));
    // The quoted fallback must not contain a quote or backslash of its own.
    const fallback = /filename="([^"]*)"/.exec(value)?.[1] ?? "";
    expect(fallback).not.toContain('"');
    expect(fallback).not.toContain("\\");
  });

  it("falls back to a usable name when nothing is ASCII", () => {
    expect(contentDisposition("Документ.pdf")).toContain(
      'filename="document.pdf"',
    );
    expect(contentDisposition("Отчёт.docx")).toContain(
      'filename="document.docx"',
    );
  });
});

describe("DocumentRegistry", () => {
  const document = {
    path: "/tmp/a.pdf",
    name: "a.pdf",
    sizeBytes: 10,
    contentType: "application/pdf",
  };

  it("resolves a registered document by its id", () => {
    const registry = new DocumentRegistry({ ttlMs: 1000, now: () => 0 });
    const { id } = registry.register(document);
    expect(registry.resolve(id)?.path).toBe("/tmp/a.pdf");
    expect(registry.resolve("other")).toBeNull();
  });

  it("stops resolving once the lease expires, and sweeps stale rows", () => {
    let now = 0;
    const registry = new DocumentRegistry({ ttlMs: 1000, now: () => now });
    const { id } = registry.register(document);
    now = 1001;
    expect(registry.resolve(id)).toBeNull();
    expect(registry.size).toBe(0);

    now = 2000;
    registry.register(document);
    now = 3001;
    registry.register(document);
    expect(registry.size).toBe(1);
  });

  it("keeps a link alive while it is being read", () => {
    let now = 0;
    const registry = new DocumentRegistry({ ttlMs: 1000, now: () => now });
    const { id } = registry.register(document);
    now = 900;
    expect(registry.resolve(id)?.contentType).toBe("application/pdf");
    now = 1800;
    expect(registry.resolve(id)).not.toBeNull();
    now = 2801;
    expect(registry.resolve(id)).toBeNull();
  });
});
