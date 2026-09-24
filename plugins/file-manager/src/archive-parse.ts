// src/archive-parse.ts — the pure half of archive browsing (§8.13): turning
// what an archive's table of contents says into `ArchiveEntry` rows.
//
// Nothing here opens a file, spawns a process or reads a clock. The I/O lives
// in src/archive-listing.ts; this module is only ever handed bytes and lines,
// which is what lets every quirk below be pinned by a unit test against the
// exact output the tools print.
//
// Three readers, one per family:
//
//   * zip — the central directory, read in-process by yauzl. Member names
//     arrive as raw bytes, because the charset *is* the problem: a zip made
//     by Windows Explorer on a Russian system stores CP866 ("OEM") names with
//     no UTF-8 flag, and every tool on a Linux box guesses differently —
//     `7z l` turns them into U+FFFD, Info-ZIP's answer depends on the distro's
//     patches and the locale. So the guess is made here, once, on purpose.
//   * tar — GNU tar's `--list --verbose` under `--quoting-style=c` in the C
//     locale. Every name comes back in double quotes with C escapes, so a
//     space, a newline, a quote, a leading dash or a stray byte can never be
//     mistaken for a column boundary, and the exact bytes come back out.
//   * 7z and rar — `7z l -slt`: one `Key = Value` block per member, blocks
//     separated by a blank line.
import { crc32 } from "node:zlib";

import type { ArchiveEntry, ArchiveEntryKind, ArchiveStopReason } from "../contract";

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * CP866's upper half, bytes 0x80–0xFF: the DOS "OEM" code page of Russian
 * Windows, which is what Explorer's "Send to → Compressed folder" writes. A
 * table rather than `TextDecoder("ibm866")` so the answer does not depend on
 * how much ICU the Node build that runs bb happens to carry.
 */
const CP866_HIGH =
  "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ" +
  "абвгдежзийклмноп░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■ ";

export function decodeCp866(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += byte < 0x80 ? String.fromCharCode(byte) : (CP866_HIGH[byte - 0x80] ?? "�");
  }
  return text;
}

// `ignoreBOM` keeps a leading U+FEFF as part of the name instead of silently
// eating it: a name is shown exactly as stored, oddities included.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * A name stored with no declared charset: UTF-8 when the bytes are valid
 * UTF-8, CP866 otherwise. Never throws — every byte string decodes to
 * *something*.
 *
 * The order is safe for the case it exists for. Real Russian text in CP866 is
 * almost never valid UTF-8 by accident: capitals and `а`–`п` are 0x80–0xAF,
 * which UTF-8 only allows as continuation bytes, so a name that starts with
 * one — or has one anywhere not right after a lead byte — fails the test.
 */
export function decodeLegacyName(bytes: Uint8Array): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return decodeCp866(bytes);
  }
}

/** One parsed zip extra field, as yauzl hands it over. */
export interface ZipExtraField {
  id: number;
  data: Uint8Array;
}

/** General purpose bit 11: the name (and comment) are UTF-8. */
const ZIP_UTF8_FLAG = 0x0800;
/** Info-ZIP Unicode Path: version byte, CRC-32 of the raw name, UTF-8 name. */
const UNICODE_PATH_FIELD = 0x7075;

/**
 * The name Info-ZIP's Unicode Path extra field carries, or null.
 *
 * WinRAR and Info-ZIP write it beside a legacy-encoded name. It only counts
 * when its CRC matches the raw name it sits next to — a tool that renamed the
 * member and left the field behind would otherwise put a stale name on
 * screen. That rule is the zip spec's, not a precaution of ours.
 */
function unicodePathName(raw: Uint8Array, extraFields: readonly ZipExtraField[]): string | null {
  const field = extraFields.find((candidate) => candidate.id === UNICODE_PATH_FIELD);
  if (field === undefined || field.data.length < 5 || field.data[0] !== 1) return null;
  const view = new DataView(field.data.buffer, field.data.byteOffset, field.data.byteLength);
  if (view.getUint32(1, true) !== crc32(raw)) return null;
  return lenientUtf8.decode(field.data.subarray(5));
}

/**
 * Decode a zip member name from its raw bytes (§8.13):
 *
 *   1. an Info-ZIP Unicode Path field whose CRC matches — the writer's own
 *      statement of the real name;
 *   2. the UTF-8 flag — decoded as UTF-8, lossily, because the writer said so;
 *   3. otherwise valid UTF-8 is UTF-8 (plenty of tools write UTF-8 without
 *      setting the flag), and anything else is CP866.
 *
 * Backslashes become slashes afterwards: .NET's `ZipFile` wrote Windows
 * separators into member names for years, and a tree built from them would
 * show `dir\file.txt` as one flat name.
 */
export function decodeZipName(
  raw: Uint8Array,
  flags: number,
  extraFields: readonly ZipExtraField[],
): string {
  const name =
    unicodePathName(raw, extraFields) ??
    ((flags & ZIP_UTF8_FLAG) !== 0 ? lenientUtf8.decode(raw) : decodeLegacyName(raw));
  return name.replaceAll("\\", "/");
}

/** "dir/" → "dir": a folder's own trailing separator says nothing more. */
function withoutTrailingSlash(name: string): string {
  return name.length > 1 && name.endsWith("/") ? name.slice(0, -1) : name;
}

/* ------------------------------------------------------------------ */
/* zip — one central directory record                                  */
/* ------------------------------------------------------------------ */

/** The slice of a yauzl `Entry` this module reads. */
export interface ZipRecord {
  fileNameRaw: Uint8Array;
  generalPurposeBitFlag: number;
  extraFields: readonly ZipExtraField[];
  versionMadeBy: number;
  externalFileAttributes: number;
  uncompressedSize: number;
  lastModFileDate: number;
  getLastModDate(): Date;
}

/** Hosts whose external attributes carry a Unix mode in their high 16 bits. */
const UNIX_HOSTS: ReadonlySet<number> = new Set([3 /* Unix */, 19 /* OS X */]);
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
/** Info-ZIP universal time and NTFS times: both are UTC, unlike the DOS pair. */
const ZIP_TIME_FIELDS: ReadonlySet<number> = new Set([0x5455, 0x000a]);

export function zipEntryKind(
  name: string,
  versionMadeBy: number,
  externalAttributes: number,
): ArchiveEntryKind {
  const host = versionMadeBy >>> 8;
  if (UNIX_HOSTS.has(host)) {
    const type = (externalAttributes >>> 16) & S_IFMT;
    if (type === S_IFLNK) return "symlink";
    if (type === S_IFDIR) return "directory";
    if (type !== 0 && type !== S_IFREG && !name.endsWith("/")) return "other";
  } else if ((externalAttributes & 0x10) !== 0) {
    // The MS-DOS directory attribute, for writers that forgot the slash.
    return "directory";
  }
  return name.endsWith("/") ? "directory" : "file";
}

/**
 * The member's time, or null for "none recorded".
 *
 * A zero DOS date is how writers say "no time" (it decodes to 30 Nov 1979,
 * which is what a naive reader then shows); it only means that when no UTC
 * extra field overrides it. The DOS pair itself is a local wall-clock time
 * with no zone, and yauzl reads it in the server's zone — the same zone
 * `zipinfo` on this machine would print it in.
 */
export function zipModifiedAt(record: ZipRecord): number | null {
  const hasUtcField = record.extraFields.some((field) => ZIP_TIME_FIELDS.has(field.id));
  if (record.lastModFileDate === 0 && !hasUtcField) return null;
  const time = record.getLastModDate().getTime();
  return Number.isFinite(time) ? time : null;
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_RECORD_SIGNATURE = 0x06064b50;
/** End-of-central-directory record, without its comment. */
const EOCD_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_RECORD_BYTES = 56;
/** How much of a file's tail can hold the records `zipPrefixLength` reads. */
export const ZIP_TAIL_BYTES = EOCD_BYTES + 0xffff + ZIP64_LOCATOR_BYTES + ZIP64_RECORD_BYTES;

/**
 * How many bytes sit in front of a zip's own first byte — a self-extractor
 * stub, a shell script, a download wrapper — worked out the way Info-ZIP
 * does it: the end-of-central-directory record says where the directory
 * starts *relative to the zip*, the record's real position in the file says
 * where it actually ends, and the difference is the prefix. yauzl trusts the
 * relative offsets as absolute ones, so it needs the file shifted by this
 * much to read such a zip at all.
 *
 * `tail` is the last bytes of the file, starting at `tailStart`. 0 for an
 * ordinary zip and for anything that does not parse — yauzl then gives its
 * own verdict.
 */
export function zipPrefixLength(tail: Uint8Array, tailStart: number): number {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let at = tail.length - EOCD_BYTES; at >= 0; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    // The record, comment and all, must end the file — the same rule yauzl
    // applies, so both find the same record.
    if (at + EOCD_BYTES + view.getUint16(at + 20, true) !== tail.length) continue;
    const directoryBytes = view.getUint32(at + 12, true);
    const directoryOffset = view.getUint32(at + 16, true);
    if (directoryBytes !== 0xffffffff && directoryOffset !== 0xffffffff) {
      return Math.max(0, tailStart + at - (directoryOffset + directoryBytes));
    }
    // zip64: the locator right before the record names the zip64 record's
    // relative offset, and that record sits right before the locator.
    const locator = at - ZIP64_LOCATOR_BYTES;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) return 0;
    const recordOffset = Number(view.getBigUint64(locator + 8, true));
    for (let record = locator - ZIP64_RECORD_BYTES; record >= 0; record -= 1) {
      if (view.getUint32(record, true) === ZIP64_RECORD_SIGNATURE) {
        return Math.max(0, tailStart + record - recordOffset);
      }
    }
    return 0;
  }
  return 0;
}

export function zipEntryFrom(record: ZipRecord): ArchiveEntry {
  const name = decodeZipName(
    record.fileNameRaw,
    record.generalPurposeBitFlag,
    record.extraFields,
  );
  const kind = zipEntryKind(name, record.versionMadeBy, record.externalFileAttributes);
  return {
    path: kind === "directory" ? withoutTrailingSlash(name) : name,
    kind,
    sizeBytes: kind === "directory" ? 0 : record.uncompressedSize,
    modifiedAtMs: zipModifiedAt(record),
    // Bit 0 covers traditional ZipCrypto and WinZip AES alike (method 99 sets
    // it too); the contents stay unreadable either way, the name does not.
    encrypted: (record.generalPurposeBitFlag & 0x1) !== 0,
    // A zip symlink keeps its target in the member's *data*, and reading data
    // is exactly what a listing does not do.
    linkTarget: null,
  };
}

/* ------------------------------------------------------------------ */
/* tar — GNU `--quoting-style=c`                                       */
/* ------------------------------------------------------------------ */

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
  "'": 0x27,
  "?": 0x3f,
};

/**
 * Undo `--quoting-style=c` for the quoted string that opens at `start`: back
 * to the exact bytes it stands for, plus the index just past its closing
 * quote. Null when the line ends before the string does.
 *
 * The line is expected in latin1, one character per byte. In the C locale
 * tar escapes every byte above 0x7e as `\ooo`, but a raw high byte from a
 * surprising locale still maps back onto itself this way.
 */
export function readCQuoted(line: string, start: number): { bytes: Uint8Array; end: number } | null {
  if (line[start] !== '"') return null;
  const bytes: number[] = [];
  let index = start + 1;
  while (index < line.length) {
    const char = line[index] as string;
    if (char === '"') return { bytes: Uint8Array.from(bytes), end: index + 1 };
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0) & 0xff);
      index += 1;
      continue;
    }
    const next = line[index + 1];
    if (next === undefined) return null;
    const simple = C_ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      index += 2;
      continue;
    }
    if (next >= "0" && next <= "7") {
      let value = 0;
      let digits = 0;
      while (digits < 3) {
        const digit = line[index + 1 + digits];
        if (digit === undefined || digit < "0" || digit > "7") break;
        value = value * 8 + (digit.charCodeAt(0) - 48);
        digits += 1;
      }
      bytes.push(value & 0xff);
      index += 1 + digits;
      continue;
    }
    // An escape GNU does not emit: keep the character it guards.
    bytes.push(next.charCodeAt(0) & 0xff);
    index += 2;
  }
  return null;
}

/**
 * The type character that opens a `tar -tv` line → what the member is.
 * `null` marks a line that is not a member at all (a volume label names the
 * tape). Anything not in the table is skipped the same way.
 */
const TAR_TYPES: Readonly<Record<string, ArchiveEntryKind | null>> = {
  "-": "file",
  d: "directory",
  l: "symlink",
  h: "hardlink",
  c: "other",
  b: "other",
  p: "other",
  s: "other",
  // A contiguous file, and the continuation of a member split across volumes.
  C: "file",
  M: "file",
  V: null,
};

/** `2026-09-23` + `15:11:22[.123456789]` in UTC, or a bare count of seconds. */
function tarTimestamp(parts: readonly string[]): number | null {
  // GNU prints the raw seconds when a time will not fit a calendar date.
  if (parts.length === 1) return /^-?\d+$/u.test(parts[0] ?? "") ? Number(parts[0]) * 1000 : null;
  if (parts.length !== 2) return null;
  const date = /^(-?\d{4,})-(\d{2})-(\d{2})$/u.exec(parts[0] ?? "");
  const time = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/u.exec(parts[1] ?? "");
  if (date === null || time === null) return null;
  const milliseconds = time[4] === undefined ? 0 : Number(time[4].slice(0, 3).padEnd(3, "0"));
  const value = Date.UTC(
    Number(date[1]),
    Number(date[2]) - 1,
    Number(date[3]),
    Number(time[1]),
    Number(time[2]),
    Number(time[3] ?? 0),
    milliseconds,
  );
  return Number.isFinite(value) ? value : null;
}

/**
 * One line of `tar --list --verbose --full-time --numeric-owner
 * --quoting-style=c`, run in the C locale with TZ=UTC:
 *
 *     -rw-r--r-- 1000/1000   1234 2026-09-23 15:11:22 "dir/a name.txt"
 *     lrwxrwxrwx 1000/1000      0 2026-09-23 15:11:22 "link" -> "../target"
 *     hrw-r--r-- 1000/1000      0 2026-09-23 15:11:22 "copy" link to "original"
 *
 * Everything before the first `"` is fixed columns — mode, uid/gid, size (or
 * `major,minor` for a device), date and time — none of which can contain a
 * quote, so the first quote is always where the name starts. Null for any
 * line that is not a member.
 */
export function parseTarLine(line: string): ArchiveEntry | null {
  const kind = TAR_TYPES[line[0] ?? ""];
  if (kind === undefined || kind === null) return null;
  const quote = line.indexOf('"');
  if (quote < 0) return null;
  const columns = line.slice(0, quote).trim().split(/\s+/u);
  // mode, owner/group, size, then one or two timestamp columns
  if (columns.length < 4) return null;
  const name = readCQuoted(line, quote);
  if (name === null) return null;

  let linkTarget: string | null = null;
  const marker = kind === "symlink" ? " -> " : kind === "hardlink" ? " link to " : null;
  if (marker !== null && line.startsWith(marker, name.end)) {
    const target = readCQuoted(line, name.end + marker.length);
    if (target !== null) linkTarget = decodeLegacyName(target.bytes);
  }

  const sizeColumn = columns[2] ?? "";
  const path = decodeLegacyName(name.bytes);
  return {
    path: kind === "directory" ? withoutTrailingSlash(path) : path,
    kind,
    sizeBytes: kind === "file" && /^\d+$/u.test(sizeColumn) ? Number(sizeColumn) : 0,
    modifiedAtMs: tarTimestamp(columns.slice(3)),
    // tar has no encryption of its own; a whole encrypted .tar.gpg is not a tar.
    encrypted: false,
    linkTarget,
  };
}

/* ------------------------------------------------------------------ */
/* 7z / rar — `7z l -slt`                                              */
/* ------------------------------------------------------------------ */

/** The line between the archive's own properties and the first member. */
const SEVEN_ZIP_SEPARATOR = "----------";
/** `Key = Value`, where a key is one or more words, the first capitalised. */
const SEVEN_ZIP_PROPERTY = /^([A-Z][A-Za-z0-9_-]*(?: [A-Za-z0-9_-]+)*) = (.*)$/u;
/** The `ls -l`-style mode 7z appends to the attributes of Unix-made members. */
const UNIX_MODE = /^[-dlcbps][-rwxsStT]{9}$/u;

/**
 * `2026-09-23 15:11:22.7688005` → epoch ms, read as *local* time.
 *
 * 7z prints a 7z archive's UTC times converted to its own zone and a RAR4
 * archive's DOS times as recorded. Reading both back in the zone the child
 * inherited from this process undoes the first exactly and treats the second
 * like a zip's DOS time — as a wall clock on this machine.
 */
export function parseSevenZipTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/u.exec(value.trim());
  if (match === null) return null;
  const milliseconds = match[7] === undefined ? 0 : Number(match[7].slice(0, 3).padEnd(3, "0"));
  const time = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
    milliseconds,
  ).getTime();
  return Number.isFinite(time) ? time : null;
}

/** One `Key = Value` block → a member, or null when it names nothing. */
export function sevenZipEntryFrom(block: ReadonlyMap<string, string>): ArchiveEntry | null {
  const rawPath = block.get("Path");
  if (rawPath === undefined || rawPath === "") return null;

  const attributes = (block.get("Attributes") ?? "").trim().split(/\s+/u);
  // Windows letters first ("D", "A", "RHS", "DA"), then maybe a Unix mode.
  const windows = /^[A-Z_]+$/u.test(attributes[0] ?? "") ? (attributes[0] as string) : "";
  const unix = attributes.find((token) => UNIX_MODE.test(token)) ?? "";
  const symlinkTarget = block.get("Symbolic Link") ?? "";
  const hardlinkTarget = block.get("Hard Link") ?? "";

  let kind: ArchiveEntryKind = "file";
  if (block.get("Folder") === "+" || windows.includes("D") || unix.startsWith("d")) {
    kind = "directory";
  } else if (symlinkTarget !== "" || unix.startsWith("l")) {
    kind = "symlink";
  } else if (hardlinkTarget !== "") {
    kind = "hardlink";
  } else if (unix !== "" && !unix.startsWith("-")) {
    kind = "other";
  }

  const size = block.get("Size") ?? "";
  return {
    path: kind === "directory" ? withoutTrailingSlash(rawPath) : rawPath,
    kind,
    sizeBytes: kind === "file" && /^\d+$/u.test(size) ? Number(size) : 0,
    modifiedAtMs: parseSevenZipTime(block.get("Modified") ?? ""),
    encrypted: block.get("Encrypted") === "+",
    linkTarget:
      kind === "symlink" && symlinkTarget !== ""
        ? symlinkTarget
        : kind === "hardlink"
          ? hardlinkTarget
          : null,
  };
}

/**
 * A line-at-a-time reader for `7z l -slt`. Feed it every line of stdout; it
 * answers with a member each time a block closes.
 *
 * The archive's own properties come first — including a `Path =` naming the
 * archive — so nothing counts until the `----------` line. After it, a line
 * that is not `Key = Value` continues the previous value when that value is
 * the path: 7z prints a name with a newline in it verbatim, and splitting it
 * into a member plus garbage would be worse than joining it back.
 */
export class SevenZipListParser {
  /**
   * What 7z said is wrong with the archive itself. A damaged or truncated
   * archive is reported on *stdout*, as an `ERRORS:` list among the archive's
   * properties, with nothing at all on stderr.
   */
  readonly problems: string[] = [];
  private inMembers = false;
  private inErrors = false;
  private block = new Map<string, string>();
  private lastKey: string | null = null;

  push(line: string): ArchiveEntry | null {
    if (!this.inMembers) {
      if (line === SEVEN_ZIP_SEPARATOR) {
        this.inMembers = true;
      } else if (line === "ERRORS:") {
        this.inErrors = true;
      } else if (this.inErrors) {
        // The list runs until the properties resume (or a blank line).
        if (line === "" || SEVEN_ZIP_PROPERTY.test(line)) this.inErrors = false;
        else if (this.problems.length < 4) this.problems.push(line.trim());
      }
      return null;
    }
    if (line === "") return this.flush();
    const property = SEVEN_ZIP_PROPERTY.exec(line);
    if (property !== null) {
      const key = property[1] as string;
      this.block.set(key, property[2] as string);
      this.lastKey = key;
      return null;
    }
    if (this.lastKey === "Path") {
      this.block.set("Path", `${this.block.get("Path") ?? ""}\n${line}`);
    }
    return null;
  }

  /** The block still open when the output ended, if any. */
  end(): ArchiveEntry | null {
    return this.inMembers ? this.flush() : null;
  }

  private flush(): ArchiveEntry | null {
    const entry = this.block.size === 0 ? null : sevenZipEntryFrom(this.block);
    this.block = new Map();
    this.lastKey = null;
    return entry;
  }
}

/* ------------------------------------------------------------------ */
/* Lines out of a byte stream                                          */
/* ------------------------------------------------------------------ */

/**
 * Cuts a child's stdout into lines without ever holding more than one line.
 *
 * A line longer than `maxLineBytes` is dropped whole rather than cut: half a
 * `tar -tv` line would parse as a member with a truncated name, and no real
 * listing line comes anywhere near the cap. `onLine` answers false to stop.
 */
export class LineSplitter {
  private pieces: Buffer[] = [];
  private pendingBytes = 0;
  private skipping = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly encoding: "latin1" | "utf8",
  ) {}

  push(chunk: Buffer, onLine: (line: string) => boolean): boolean {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0) {
        this.hold(chunk.subarray(start));
        return true;
      }
      this.hold(chunk.subarray(start, newline));
      start = newline + 1;
      const line = this.take();
      if (line !== null && !onLine(line)) return false;
    }
  }

  /** The unterminated last line, if the output did not end with a newline. */
  end(onLine: (line: string) => boolean): boolean {
    if (this.pendingBytes === 0 && !this.skipping) return true;
    const line = this.take();
    return line === null ? true : onLine(line);
  }

  private hold(piece: Buffer): void {
    if (this.skipping || piece.length === 0) return;
    if (this.pendingBytes + piece.length > this.maxLineBytes) {
      this.pieces = [];
      this.pendingBytes = 0;
      this.skipping = true;
      return;
    }
    this.pieces.push(piece);
    this.pendingBytes += piece.length;
  }

  private take(): string | null {
    const skipped = this.skipping;
    const line = skipped ? null : Buffer.concat(this.pieces, this.pendingBytes).toString(this.encoding);
    this.pieces = [];
    this.pendingBytes = 0;
    this.skipping = false;
    return line;
  }
}

/* ------------------------------------------------------------------ */
/* Counting                                                            */
/* ------------------------------------------------------------------ */

export interface CollectorLimits {
  /** Members kept for the page — MAX_ARCHIVE_ENTRIES in production. */
  maxEntries: number;
  /** Members counted before the scan gives up. */
  maxScanned: number;
  /** Distinct folders remembered for the count before the scan gives up. */
  maxDirectories: number;
}

/** The summary half of an `ArchiveListing`. */
export interface ListingTotals {
  entries: ArchiveEntry[];
  totalEntries: number;
  fileCount: number;
  directoryCount: number;
  uncompressedBytes: number;
  encryptedCount: number;
  truncated: boolean;
  partial: boolean;
  stoppedBy: ArchiveStopReason | null;
  problem: string | null;
}

/**
 * A member path's components, the way the listing shows them: empty and `.`
 * segments dropped, `..` kept as a literal name, and a leading `/` kept as a
 * folder named `/` — an absolute member is displayed as one, so the tree
 * says so, and it is never resolved against anything (§8.13).
 *
 * lib/archive-tree.ts splits paths by the same rules; the two must agree, or
 * the summary's folder count and the tree the page draws would disagree.
 */
export function memberSegments(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return path.startsWith("/") ? ["/", ...segments] : segments;
}

/**
 * Keeps the first `maxEntries` members and counts every member it is shown,
 * which is what lets the summary describe the whole archive while the page
 * only ever receives a bounded list.
 *
 * Memory stays flat on a hostile archive: the kept list is capped, the counts
 * are numbers, and the set of folder paths — needed because most zips never
 * list their folders, they only imply them — is capped too. Hitting either
 * scan cap makes `add` answer false, and the caller stops reading.
 */
export class ListingCollector {
  readonly entries: ArchiveEntry[] = [];
  private scanned = 0;
  private files = 0;
  private bytes = 0;
  private encrypted = 0;
  private readonly directories = new Set<string>();

  constructor(private readonly limits: CollectorLimits) {}

  /** Members counted so far. */
  get scannedCount(): number {
    return this.scanned;
  }

  /** Count (and maybe keep) one member; false means "stop, this one was not counted". */
  add(entry: ArchiveEntry): boolean {
    if (this.scanned >= this.limits.maxScanned) return false;

    const segments = memberSegments(entry.path);
    // A folder counts itself; anything else only its ancestors.
    const depth = entry.kind === "directory" ? segments.length : segments.length - 1;
    const missing: string[] = [];
    let prefix = "";
    for (let index = 0; index < depth; index += 1) {
      prefix = index === 0 ? (segments[0] as string) : `${prefix}/${segments[index] as string}`;
      if (!this.directories.has(prefix)) missing.push(prefix);
    }
    if (this.directories.size + missing.length > this.limits.maxDirectories) return false;
    for (const folder of missing) this.directories.add(folder);

    this.scanned += 1;
    if (entry.kind !== "directory") {
      this.files += 1;
      this.bytes += entry.sizeBytes;
    }
    if (entry.encrypted) this.encrypted += 1;
    if (this.entries.length < this.limits.maxEntries) this.entries.push(entry);
    return true;
  }

  /** The totals, given why (and whether) the scan stopped early. */
  finish(stoppedBy: ArchiveStopReason | null, problem: string | null = null): ListingTotals {
    const partial = stoppedBy !== null;
    return {
      entries: this.entries,
      totalEntries: this.scanned,
      fileCount: this.files,
      directoryCount: this.directories.size,
      uncompressedBytes: this.bytes,
      encryptedCount: this.encrypted,
      truncated: partial || this.entries.length < this.scanned,
      partial,
      stoppedBy,
      problem: stoppedBy === "damaged" ? problem : null,
    };
  }
}
