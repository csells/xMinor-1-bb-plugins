// A small streaming XML tokenizer for SpreadsheetML parts.
//
// OOXML parts are machine-written, namespace-heavy and sometimes huge, so this
// is deliberately not a general XML parser: no DTDs, no validation, and
// namespace prefixes are simply dropped (`<x:row>` from .NET writers and
// Strict OOXML both reduce to `row`). Input arrives as decoded text chunks;
// markup split across chunks waits for the next one.
import type { Pacer } from "./pacer.js";
import type { ZipArchive, ZipEntry } from "./zip.js";

export type XmlAttributes = Readonly<Record<string, string>>;

export interface XmlHandler {
  /**
   * A start tag, by local name. Return true to receive the element's text
   * content (up to the next tag) through `text`.
   */
  open(name: string, attributes: XmlAttributes, prefix: string): boolean | void;
  /** An end tag; self-closing elements get `open` and then `close`. */
  close(name: string): void;
  text?(text: string): void;
}

const LT = 60; // <
const GT = 62; // >
const SLASH = 47; // /
const BANG = 33; // !
const QUESTION = 63; // ?
const COLON = 58; // :
const EQUALS = 61; // =
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;

const NO_ATTRIBUTES: XmlAttributes = Object.freeze({});

export class XmlTokenizer {
  readonly #handler: XmlHandler;
  #buffer = "";
  #pos = 0;
  #capturing = false;
  /** Raw (still entity-encoded) text of the element being captured. */
  #raw: string[] = [];
  /** Text already decoded, from CDATA sections. */
  #decoded = "";
  #stopped = false;

  constructor(handler: XmlHandler) {
    this.#handler = handler;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Stops after the current event; `remainder()` returns what is left. */
  stop(): void {
    this.#stopped = true;
  }

  /** Unprocessed input after `stop()`, starting right after the last event. */
  remainder(): string {
    return this.#buffer.slice(this.#pos);
  }

  write(chunk: string): void {
    if (this.#stopped) return;
    this.#buffer = this.#pos < this.#buffer.length ? this.#buffer.slice(this.#pos) + chunk : chunk;
    this.#pos = 0;
    this.#run();
  }

  #run(): void {
    const buffer = this.#buffer;
    const length = buffer.length;
    let pos = this.#pos;
    while (pos < length && !this.#stopped) {
      const lt = buffer.indexOf("<", pos);
      if (lt === -1) {
        if (this.#capturing) this.#raw.push(buffer.slice(pos));
        pos = length;
        break;
      }
      if (lt > pos && this.#capturing) this.#raw.push(buffer.slice(pos, lt));
      pos = lt;
      const end = this.#markup(buffer, lt);
      if (end === -1) break;
      pos = end;
    }
    this.#pos = pos;
  }

  /** Handles the markup at `lt`; returns the index after it, or -1 when it is incomplete. */
  #markup(buffer: string, lt: number): number {
    const next = buffer.charCodeAt(lt + 1);
    if (next !== next) return -1; // NaN: the chunk ends right after "<"
    if (next === SLASH) {
      const gt = buffer.indexOf(">", lt + 2);
      if (gt === -1) return -1;
      this.#flushText();
      this.#handler.close(localName(buffer, lt + 2, gt));
      return gt + 1;
    }
    if (next === BANG) return this.#declaration(buffer, lt);
    if (next === QUESTION) {
      const end = buffer.indexOf("?>", lt + 2);
      return end === -1 ? -1 : end + 2;
    }

    const gt = findTagEnd(buffer, lt + 1);
    if (gt === -1) return -1;
    this.#flushText();
    let nameEnd = lt + 1;
    let colon = -1;
    for (; nameEnd < gt; nameEnd += 1) {
      const code = buffer.charCodeAt(nameEnd);
      if (code <= 32 || code === SLASH) break;
      if (code === COLON) colon = nameEnd;
    }
    const name = buffer.slice(colon === -1 ? lt + 1 : colon + 1, nameEnd);
    const prefix = colon === -1 ? "" : buffer.slice(lt + 1, colon + 1);
    const selfClosing = buffer.charCodeAt(gt - 1) === SLASH;
    const attributesEnd = selfClosing ? gt - 1 : gt;
    const attributes =
      nameEnd < attributesEnd ? parseAttributes(buffer, nameEnd, attributesEnd) : NO_ATTRIBUTES;
    const capture = this.#handler.open(name, attributes, prefix);
    if (selfClosing) this.#handler.close(name);
    else if (capture === true) this.#capturing = true;
    return gt + 1;
  }

  /** Comments, CDATA and DOCTYPE. */
  #declaration(buffer: string, lt: number): number {
    if (buffer.startsWith("<![CDATA[", lt)) {
      const end = buffer.indexOf("]]>", lt + 9);
      if (end === -1) return -1;
      if (this.#capturing) {
        this.#decoded += decodeEntities(normalizeLineEnds(this.#raw.join(""))) + normalizeLineEnds(buffer.slice(lt + 9, end));
        this.#raw = [];
      }
      return end + 3;
    }
    if (buffer.startsWith("<!--", lt)) {
      const end = buffer.indexOf("-->", lt + 4);
      return end === -1 ? -1 : end + 3;
    }
    // Too short to tell a comment or CDATA from a DOCTYPE yet.
    if (buffer.length - lt < 9) return -1;
    const bracket = buffer.indexOf("[", lt);
    const gt = buffer.indexOf(">", lt);
    if (gt === -1) return -1;
    if (bracket !== -1 && bracket < gt) {
      const end = buffer.indexOf("]>", bracket);
      return end === -1 ? -1 : end + 2;
    }
    return gt + 1;
  }

  #flushText(): void {
    if (!this.#capturing) return;
    this.#capturing = false;
    const raw = this.#raw.length === 1 ? this.#raw[0] : this.#raw.join("");
    const text = this.#decoded + decodeEntities(normalizeLineEnds(raw ?? ""));
    this.#raw = [];
    this.#decoded = "";
    this.#handler.text?.(text);
  }
}

/**
 * Index of the `>` closing a start tag that begins at `from`, skipping `>`
 * inside quoted attribute values; -1 when the tag is not complete yet.
 */
function findTagEnd(buffer: string, from: number): number {
  let cursor = from;
  for (;;) {
    const gt = buffer.indexOf(">", cursor);
    if (gt === -1) return -1;
    let quote = -1;
    for (let i = cursor; i < gt; i += 1) {
      const code = buffer.charCodeAt(i);
      if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
        quote = i;
        break;
      }
    }
    if (quote === -1) return gt;
    const close = buffer.indexOf(buffer[quote] as string, quote + 1);
    if (close === -1) return -1;
    cursor = close + 1;
  }
}

/** Name of an end tag without its prefix. Scans forward: a backward search would run through the whole buffer when the name has no colon. */
function localName(buffer: string, start: number, end: number): string {
  let stop = end;
  while (stop > start && buffer.charCodeAt(stop - 1) <= 32) stop -= 1;
  let begin = start;
  for (let i = start; i < stop; i += 1) {
    if (buffer.charCodeAt(i) === COLON) begin = i + 1;
  }
  return buffer.slice(begin, stop);
}

/**
 * Attributes by local name. Namespace declarations are dropped so that
 * `xmlns:r` can never shadow a cell's `r`.
 */
export function parseAttributes(source: string, start: number, end: number): XmlAttributes {
  const attributes: Record<string, string> = {};
  let i = start;
  while (i < end) {
    let code = source.charCodeAt(i);
    if (code <= 32) {
      i += 1;
      continue;
    }
    const nameStart = i;
    let colon = -1;
    while (i < end && (code = source.charCodeAt(i)) !== EQUALS && code > 32) {
      if (code === COLON) colon = i;
      i += 1;
    }
    const nameEnd = i;
    while (i < end && source.charCodeAt(i) <= 32) i += 1;
    if (source.charCodeAt(i) !== EQUALS) continue;
    i += 1;
    while (i < end && source.charCodeAt(i) <= 32) i += 1;
    const quote = source.charCodeAt(i);
    if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) break;
    const valueEnd = source.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", i + 1);
    if (valueEnd === -1 || valueEnd > end) break;
    const prefix = colon === -1 ? "" : source.slice(nameStart, colon);
    if (prefix !== "xmlns" && !(colon === -1 && nameEnd - nameStart === 5 && source.startsWith("xmlns", nameStart))) {
      const raw = normalizeLineEnds(source.slice(i + 1, valueEnd));
      attributes[source.slice(colon === -1 ? nameStart : colon + 1, nameEnd)] =
        raw.indexOf("&") === -1 ? raw : decodeEntities(raw);
    }
    i = valueEnd + 1;
  }
  return attributes;
}

/**
 * XML 1.0 end-of-line handling: a parser reads CR LF and lone CR as LF.
 * Characters written as `&#13;` come after this step and survive it.
 */
function normalizeLineEnds(text: string): string {
  return text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n");
}

const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Predefined XML entities and numeric character references. */
export function decodeEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(ENTITY, (match, decimal?: string, hex?: string, named?: string) => {
    if (named) return NAMED_ENTITIES[named] ?? match;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

const OOXML_ESCAPE = /_x([0-9a-fA-F]{4})_/g;

/**
 * OOXML stores characters XML cannot carry as `_xHHHH_` (`_x000D_` is a
 * carriage return); a literal `_x0041_` is itself escaped as `_x005F_x0041_`.
 */
export function decodeOoxmlEscapes(text: string): string {
  if (text.indexOf("_x") === -1) return text;
  return text.replace(OOXML_ESCAPE, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** XML whitespace; `xml:space="preserve"` is what keeps it at the edges of a text run. */
export function trimXmlWhitespace(text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

/** xsd:boolean. */
export function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "on";
}

/** A finite number from an attribute, or undefined. */
export function numberAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Decodes a part's bytes; the encoding comes from its byte-order mark unless given. */
export class XmlTextDecoder {
  #decoder: TextDecoder | null;

  constructor(encoding?: string) {
    this.#decoder = encoding ? new TextDecoder(encoding) : null;
  }

  /** UTF-8 (so far, or by default): the byte-level skim can read it. */
  get isUtf8(): boolean {
    return this.#decoder === null || this.#decoder.encoding === "utf-8";
  }

  decode(chunk: Buffer): string {
    this.#decoder ??= new TextDecoder(sniffEncoding(chunk));
    return this.#decoder.decode(chunk, { stream: true });
  }

  end(): string {
    return this.#decoder?.decode() ?? "";
  }
}

function sniffEncoding(chunk: Buffer): string {
  const first = chunk[0];
  const second = chunk[1];
  if (first === 0xff && second === 0xfe) return "utf-16le";
  if (first === 0xfe && second === 0xff) return "utf-16be";
  if (first === LT && second === 0) return "utf-16le";
  if (first === 0 && second === LT) return "utf-16be";
  return "utf-8";
}

/**
 * Longest text the tokenizer takes in one go: about 4 ms of dense cell XML
 * with number formatting on this class of server CPU.
 */
const SLICE_CHARS = 16 * 1024;

/**
 * Feeds text in slices, yielding between them. When a handler stops the
 * tokenizer, returns the text it did not take; otherwise "".
 */
export async function writePaced(tokenizer: XmlTokenizer, text: string, pacer: Pacer): Promise<string> {
  for (let offset = 0; offset < text.length; offset += SLICE_CHARS) {
    tokenizer.write(text.slice(offset, offset + SLICE_CHARS));
    if (tokenizer.stopped) return tokenizer.remainder() + text.slice(offset + SLICE_CHARS);
    await pacer.pace();
  }
  return "";
}

/** Streams a whole part through a handler, yielding between slices. */
export async function parseXmlPart(
  zip: ZipArchive,
  entry: ZipEntry,
  handler: XmlHandler,
  pacer: Pacer,
  tokenizer: XmlTokenizer = new XmlTokenizer(handler),
): Promise<void> {
  const decoder = new XmlTextDecoder();
  for await (const chunk of zip.read(entry, pacer.signal)) {
    await writePaced(tokenizer, decoder.decode(chunk), pacer);
    if (tokenizer.stopped) return;
  }
  tokenizer.write(decoder.end());
}
