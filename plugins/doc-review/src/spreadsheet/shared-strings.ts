// The shared-string table: text of `t="s"` cells, by index.
//
// A typical table is a few megabytes and is kept in memory for the life of
// the reader. A table past EAGER_LIMIT_BYTES is never held: each sheet read
// collects the indexes it shows (at most the cell limit) and streams the
// part once to pick just those.
import type { Pacer } from "./pacer.js";
import { decodeOoxmlEscapes, parseXmlPart, trimXmlWhitespace, type XmlAttributes, XmlTokenizer } from "./xml.js";
import type { ZipArchive, ZipEntry } from "./zip.js";

/** Uncompressed size of the part up to which every string is kept in memory. */
const EAGER_LIMIT_BYTES = 48 * 1024 * 1024;

export interface SharedStrings {
  /** The string at an index, or undefined when it is not loaded (or does not exist). */
  get(index: number): string | undefined;
  /** Loads indexes `get` did not have; an empty map when everything is in memory. */
  fetch(indexes: readonly number[], pacer: Pacer): Promise<ReadonlyMap<number, string>>;
}

const NONE: SharedStrings = {
  get: () => undefined,
  fetch: async () => new Map(),
};

export async function loadSharedStrings(
  zip: ZipArchive,
  entry: ZipEntry | undefined,
  pacer: Pacer,
): Promise<SharedStrings> {
  if (!entry) return NONE;
  if (entry.uncompressedSize > EAGER_LIMIT_BYTES) return new StreamedSharedStrings(zip, entry);
  const strings: string[] = [];
  await parseXmlPart(zip, entry, new StringItemParser((_index, text) => strings.push(text)), pacer);
  return {
    get: (index) => strings[index],
    fetch: async () => new Map(),
  };
}

class StreamedSharedStrings implements SharedStrings {
  readonly #zip: ZipArchive;
  readonly #entry: ZipEntry;

  constructor(zip: ZipArchive, entry: ZipEntry) {
    this.#zip = zip;
    this.#entry = entry;
  }

  get(): string | undefined {
    return undefined;
  }

  async fetch(indexes: readonly number[], pacer: Pacer): Promise<ReadonlyMap<number, string>> {
    const wanted = new Set(indexes);
    const found = new Map<number, string>();
    if (wanted.size === 0) return found;
    let last = -1;
    for (const index of wanted) if (index > last) last = index;
    let tokenizer: XmlTokenizer | null = null;
    const parser = new StringItemParser(
      (index, text) => {
        if (wanted.has(index)) found.set(index, text);
        if (index >= last) tokenizer?.stop();
      },
      (index) => wanted.has(index),
    );
    tokenizer = new XmlTokenizer(parser);
    await parseXmlPart(this.#zip, this.#entry, parser, pacer, tokenizer);
    return found;
  }
}

/**
 * Reads `<si>` items: plain `<t>` or rich-text runs `<r><t>`, concatenated;
 * phonetic guides (`<rPh>`) are not part of the text.
 */
export class StringItemParser {
  readonly #onItem: (index: number, text: string) => void;
  readonly #wants: (index: number) => boolean;
  #index = -1;
  #inItem = false;
  #inPhonetic = false;
  #preserve = false;
  #parts: string[] = [];

  constructor(onItem: (index: number, text: string) => void, wants: (index: number) => boolean = () => true) {
    this.#onItem = onItem;
    this.#wants = wants;
  }

  open(name: string, attributes: XmlAttributes): boolean {
    if (name === "si") {
      this.#index += 1;
      this.#inItem = true;
      this.#parts = [];
    } else if (name === "rPh") {
      this.#inPhonetic = true;
    } else if (name === "t" && this.#inItem && !this.#inPhonetic && this.#wants(this.#index)) {
      this.#preserve = attributes.space === "preserve";
      return true;
    }
    return false;
  }

  text(text: string): void {
    this.#parts.push(textRun(text, this.#preserve));
  }

  close(name: string): void {
    if (name === "si") {
      this.#inItem = false;
      this.#onItem(this.#index, this.#parts.length === 1 ? (this.#parts[0] as string) : this.#parts.join(""));
    } else if (name === "rPh") {
      this.#inPhonetic = false;
    }
  }
}

/**
 * One `<t>` run as Excel shows it: edge whitespace survives only under
 * `xml:space="preserve"`, `_xHHHH_` escapes are decoded, and the CR LF pairs
 * Windows writers store as `_x000D_` plus a newline become one line break.
 */
export function textRun(text: string, preserve: boolean): string {
  return joinLineBreaks(decodeOoxmlEscapes(preserve ? text : trimXmlWhitespace(text)));
}

export function joinLineBreaks(text: string): string {
  return text.indexOf("\r\n") === -1 ? text : text.replace(/\r\n/g, "\n");
}
