// A short-lived registry of documents the viewer is allowed to stream.
//
// The HTTP route never accepts a path from the client: the frontend asks rpc
// for a document, the backend resolves and registers it, and the route serves
// only what is registered and unexpired.
import { randomUUID } from "node:crypto";

export interface RegisteredDocument {
  path: string;
  name: string;
  sizeBytes: number;
  /** Sent as Content-Type; the route never guesses from the name. */
  contentType: string;
  expiresAtMs: number;
}

export class DocumentRegistry {
  readonly #documents = new Map<string, RegisteredDocument>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs: number; now?: () => number }) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  /** Registers one document and returns the opaque id its URL carries. */
  register(document: {
    path: string;
    name: string;
    sizeBytes: number;
    contentType: string;
  }): {
    id: string;
    expiresAtMs: number;
  } {
    this.#sweep();
    const id = randomUUID();
    const expiresAtMs = this.#now() + this.#ttlMs;
    this.#documents.set(id, { ...document, expiresAtMs });
    return { id, expiresAtMs };
  }

  /**
   * The document for an id, or null when it is unknown or expired. A hit
   * extends the lease: a viewer still fetching page ranges of a long
   * document keeps its link alive, and an abandoned one lapses on schedule.
   */
  resolve(id: string): RegisteredDocument | null {
    const document = this.#documents.get(id);
    if (!document) return null;
    const now = this.#now();
    if (document.expiresAtMs <= now) {
      this.#documents.delete(id);
      return null;
    }
    document.expiresAtMs = Math.max(document.expiresAtMs, now + this.#ttlMs);
    return document;
  }

  clear(): void {
    this.#documents.clear();
  }

  get size(): number {
    return this.#documents.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, document] of this.#documents) {
      if (document.expiresAtMs <= now) this.#documents.delete(id);
    }
  }
}

/**
 * RFC 6266 disposition value: an ASCII-safe `filename=` for old clients plus
 * the real name in `filename*`, so Cyrillic and other non-ASCII names survive.
 */
export function contentDisposition(fileName: string): string {
  const ascii = [...fileName]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code >= 0x20 && code <= 0x7e && character !== '"' && character !== "\\"
      );
    })
    .join("")
    .trim();
  // A fully non-ASCII name leaves nothing useful behind ("Документ.pdf" would
  // become ".pdf"), so fall back rather than emit a bare extension.
  const stem = ascii.replace(/\.[^.]*$/, "");
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(ascii)?.[1] ?? "pdf";
  const fallback = /[A-Za-z0-9]/.test(stem) ? ascii : `document.${extension}`;
  const encoded = encodeURIComponent(fileName).replaceAll("'", "%27");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single-range `Range` header against a known size.
 * `null` → serve the whole body; "unsatisfiable" → 416.
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    const start = Math.max(0, size - suffix);
    return size === 0 ? "unsatisfiable" : { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}
