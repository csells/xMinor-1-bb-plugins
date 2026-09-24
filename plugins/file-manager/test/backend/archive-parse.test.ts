// test/backend/archive-parse.test.ts — §8.13, the pure half: name decoding,
// the tar and 7z line formats, and the collector's bounds.
//
// Every fixture line here is copied from what GNU tar 1.35 and 7-Zip 23.01
// actually print on this host, including the awkward ones — a name with a
// newline in it, a quote, a backslash, a member path that climbs out with
// `../`. The I/O half (spawning, yauzl, limits in time) is
// archive-listing.test.ts.
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import type { ArchiveEntry } from "../../contract";
import {
  LineSplitter,
  ListingCollector,
  SevenZipListParser,
  decodeCp866,
  decodeLegacyName,
  decodeZipName,
  memberSegments,
  parseSevenZipTime,
  parseTarLine,
  readCQuoted,
  sevenZipEntryFrom,
  zipEntryFrom,
  zipEntryKind,
  zipModifiedAt,
  zipPrefixLength,
  type ZipRecord,
} from "../../src/archive-parse";

const cp866 = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

/** "Отчёт за 2024.txt" as Windows Explorer on a Russian system writes it. */
const REPORT_CP866 = cp866("8ee2e7f1e220a7a020323032342e747874");
const REPORT = "Отчёт за 2024.txt";

function entry(partial: Partial<ArchiveEntry> & { path: string }): ArchiveEntry {
  return {
    path: partial.path,
    kind: partial.kind ?? "file",
    sizeBytes: partial.sizeBytes ?? 1,
    modifiedAtMs: partial.modifiedAtMs ?? null,
    encrypted: partial.encrypted ?? false,
    linkTarget: partial.linkTarget ?? null,
  };
}

/* ------------------------------------------------------------------ */

describe("member names", () => {
  it("decodes CP866 — the upper half of the code page, box drawing and all", () => {
    expect(decodeCp866(REPORT_CP866)).toBe(REPORT);
    expect(decodeCp866(Uint8Array.from([0x80, 0x9f, 0xa0, 0xaf, 0xe0, 0xef, 0xf0, 0xf1, 0xfc])))
      .toBe("АЯапряЁё№");
    expect(decodeCp866(Uint8Array.from([0xb0, 0xc4, 0xdb, 0xff]))).toBe("░─█ ");
  });

  it("prefers UTF-8 when the bytes are valid UTF-8, and falls back to CP866", () => {
    expect(decodeLegacyName(Buffer.from(REPORT, "utf8"))).toBe(REPORT);
    expect(decodeLegacyName(REPORT_CP866)).toBe(REPORT);
    expect(decodeLegacyName(Buffer.from("plain.txt"))).toBe("plain.txt");
  });

  it("keeps a byte-order mark instead of eating it", () => {
    expect(decodeLegacyName(Buffer.from("﻿name", "utf8"))).toBe("﻿name");
  });

  it("honours the zip UTF-8 flag even for bytes that would pass as CP866", () => {
    const utf8 = Buffer.from(REPORT, "utf8");
    expect(decodeZipName(utf8, 0x0800, [])).toBe(REPORT);
    // Flagged UTF-8 that is not UTF-8 is decoded lossily, not re-guessed.
    expect(decodeZipName(REPORT_CP866, 0x0800, [])).toContain("�");
  });

  it("reads CP866 names with no flag, which is what Windows Explorer writes", () => {
    expect(decodeZipName(REPORT_CP866, 0, [])).toBe(REPORT);
  });

  it("trusts an Info-ZIP Unicode Path field only when its CRC matches the raw name", () => {
    const unicode = Buffer.from("Правильное имя.txt", "utf8");
    const field = (forName: Uint8Array): { id: number; data: Uint8Array } => {
      const data = Buffer.alloc(5 + unicode.length);
      data[0] = 1;
      data.writeUInt32LE(crc32(forName), 1);
      unicode.copy(data, 5);
      return { id: 0x7075, data };
    };
    expect(decodeZipName(REPORT_CP866, 0, [field(REPORT_CP866)])).toBe("Правильное имя.txt");
    // A stale field — the member was renamed and the field left behind.
    expect(decodeZipName(REPORT_CP866, 0, [field(Buffer.from("other"))])).toBe(REPORT);
  });

  it("turns Windows separators into slashes", () => {
    expect(decodeZipName(Buffer.from("dir\\sub\\file.txt"), 0, [])).toBe("dir/sub/file.txt");
  });

  it("splits member paths for display without resolving anything", () => {
    expect(memberSegments("./dir//sub/./file.txt")).toEqual(["dir", "sub", "file.txt"]);
    expect(memberSegments("../../etc/passwd")).toEqual(["..", "..", "etc", "passwd"]);
    expect(memberSegments("/etc/passwd")).toEqual(["/", "etc", "passwd"]);
    expect(memberSegments("./")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("zip records", () => {
  function record(partial: Partial<ZipRecord> & { name: string | Uint8Array }): ZipRecord {
    const raw = typeof partial.name === "string" ? Buffer.from(partial.name, "utf8") : partial.name;
    return {
      fileNameRaw: raw,
      generalPurposeBitFlag: partial.generalPurposeBitFlag ?? 0,
      extraFields: partial.extraFields ?? [],
      versionMadeBy: partial.versionMadeBy ?? 3 << 8,
      externalFileAttributes: partial.externalFileAttributes ?? (0o100644 << 16) >>> 0,
      uncompressedSize: partial.uncompressedSize ?? 12,
      lastModFileDate: partial.lastModFileDate ?? 0x5861,
      getLastModDate: partial.getLastModDate ?? (() => new Date(Date.UTC(2024, 2, 15, 12, 30))),
    };
  }

  it("tells folders, files and symlinks apart from the attributes Unix writers set", () => {
    expect(zipEntryKind("dir/", 3 << 8, (0o40755 << 16) >>> 0)).toBe("directory");
    expect(zipEntryKind("dir", 3 << 8, (0o40755 << 16) >>> 0)).toBe("directory");
    expect(zipEntryKind("link", 3 << 8, (0o120777 << 16) >>> 0)).toBe("symlink");
    expect(zipEntryKind("fifo", 3 << 8, (0o10644 << 16) >>> 0)).toBe("other");
    expect(zipEntryKind("a.txt", 3 << 8, (0o100644 << 16) >>> 0)).toBe("file");
  });

  it("falls back to the DOS directory bit and the trailing slash for Windows writers", () => {
    expect(zipEntryKind("Folder", 0, 0x10)).toBe("directory");
    expect(zipEntryKind("Folder/", 0, 0)).toBe("directory");
    expect(zipEntryKind("a.txt", 0, 0x20)).toBe("file");
  });

  it("maps a record to an entry: decoded name, size, time, encryption", () => {
    const mapped = zipEntryFrom(
      record({ name: REPORT_CP866, versionMadeBy: 0, externalFileAttributes: 0x20, generalPurposeBitFlag: 0x1 }),
    );
    expect(mapped).toEqual({
      path: REPORT,
      kind: "file",
      sizeBytes: 12,
      modifiedAtMs: Date.UTC(2024, 2, 15, 12, 30),
      encrypted: true,
      linkTarget: null,
    });
  });

  it("drops a folder's trailing slash and its size", () => {
    const mapped = zipEntryFrom(record({ name: "docs/", uncompressedSize: 99 }));
    expect(mapped).toMatchObject({ path: "docs", kind: "directory", sizeBytes: 0 });
  });

  it("reads a zero DOS date as 'no time recorded' unless a UTC field says otherwise", () => {
    // 1979-11-30 is what a naive reader shows for it.
    expect(zipModifiedAt(record({ name: "a", lastModFileDate: 0 }))).toBeNull();
    expect(
      zipModifiedAt(
        record({ name: "a", lastModFileDate: 0, extraFields: [{ id: 0x5455, data: new Uint8Array(5) }] }),
      ),
    ).toBe(Date.UTC(2024, 2, 15, 12, 30));
  });

  it("finds the prefix in front of a self-extracting zip", () => {
    // EOCD for a 100-byte directory at offset 1000, sitting at 1100 + 64 of stub.
    const tail = Buffer.alloc(22);
    tail.writeUInt32LE(0x06054b50, 0);
    tail.writeUInt32LE(100, 12);
    tail.writeUInt32LE(1000, 16);
    expect(zipPrefixLength(tail, 1164)).toBe(64);
    expect(zipPrefixLength(tail, 1100)).toBe(0);
    // A record that does not end the file is not the record.
    expect(zipPrefixLength(Buffer.concat([tail, Buffer.from("junk")]), 1164)).toBe(0);
    expect(zipPrefixLength(Buffer.from("no zip here at all"), 0)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe("tar lines (GNU --quoting-style=c, C locale, UTC)", () => {
  it("undoes C quoting back to the exact bytes", () => {
    const line = '"./\\320\\272\\320\\270\\321\\200.txt" tail';
    const quoted = readCQuoted(line, 0);
    expect(Buffer.from(quoted?.bytes ?? []).toString("utf8")).toBe("./кир.txt");
    expect(line.slice(quoted?.end)).toBe(" tail");
    expect(Buffer.from(readCQuoted('"a\\nb\\t\\"c\\\\"', 0)?.bytes ?? []).toString()).toBe(
      'a\nb\t"c\\',
    );
    expect(readCQuoted('"never closed', 0)).toBeNull();
  });

  it("parses a regular file, a folder and fractional pax times", () => {
    expect(
      parseTarLine('-rw-rw-r-- 1000/1000         6 2026-09-23 15:11:22 "./dir with space/file one.txt"'),
    ).toEqual({
      path: "./dir with space/file one.txt",
      kind: "file",
      sizeBytes: 6,
      modifiedAtMs: Date.UTC(2026, 8, 23, 15, 11, 22),
      encrypted: false,
      linkTarget: null,
    });
    expect(parseTarLine('drwxrwxr-x 1000/1000         0 2026-09-23 15:11:22 "./sub/"')).toMatchObject({
      path: "./sub",
      kind: "directory",
      sizeBytes: 0,
    });
    expect(
      parseTarLine('-rw-rw-r-- 1000/1000  1 2026-09-23 15:11:36.21997446  "./evil.txt"')?.modifiedAtMs,
    ).toBe(Date.UTC(2026, 8, 23, 15, 11, 36, 219));
  });

  it("keeps symlink and hard-link targets, even when the name holds an arrow", () => {
    expect(
      parseTarLine('lrwxrwxrwx 1000/1000 0 2026-09-23 15:11:22 "./dir/link -> arrow" -> "../sub/a.txt"'),
    ).toMatchObject({ path: "./dir/link -> arrow", kind: "symlink", linkTarget: "../sub/a.txt" });
    expect(
      parseTarLine('hrw-rw-r-- 1000/1000 0 2026-09-23 15:11:22 "./sub/a.txt" link to "./sub/hard.txt"'),
    ).toMatchObject({ path: "./sub/a.txt", kind: "hardlink", linkTarget: "./sub/hard.txt", sizeBytes: 0 });
  });

  it("gets back names with newlines, quotes, backslashes, dashes and Cyrillic", () => {
    const names = [
      ['"./new\\nline.txt"', "./new\nline.txt"],
      ['"./quote\\"back\\\\slash.txt"', './quote"back\\slash.txt'],
      ['"-dash.txt"', "-dash.txt"],
      ['"./\\320\\272\\320\\270\\321\\200\\320\\270\\320\\273\\320\\273\\320\\270\\321\\206\\320\\260.txt"', "./кириллица.txt"],
      // A non-UTF-8 name is CP866's to decode, like a zip's.
      ['"\\216\\342\\347\\361\\342.txt"', "Отчёт.txt"],
    ] as const;
    for (const [quoted, expected] of names) {
      expect(parseTarLine(`-rw-r--r-- 0/0 1 2026-09-23 15:11:22 ${quoted}`)?.path).toBe(expected);
    }
  });

  it("shows climbing and absolute members as written", () => {
    expect(parseTarLine('-rw-rw-r-- 1000/1000 1 2026-09-23 15:11:36 "../evil.txt"')?.path).toBe("../evil.txt");
    expect(parseTarLine('-rw-rw-r-- 1000/1000 1 2026-09-23 15:11:36 "/tmp/x"')?.path).toBe("/tmp/x");
  });

  it("reads devices, pre-1970 times and raw-seconds times without choking", () => {
    expect(parseTarLine('crw-rw-rw- 0/0 1,3 2026-09-23 15:11:22 "dev/null"')).toMatchObject({
      kind: "other",
      sizeBytes: 0,
    });
    expect(parseTarLine('-rw-rw-r-- 1000/1000 0 1959-12-31 22:00:00 "old.txt"')?.modifiedAtMs).toBe(
      Date.UTC(1959, 11, 31, 22),
    );
    expect(parseTarLine('-rw-rw-r-- 0/0 1 99999999999 "far.txt"')?.modifiedAtMs).toBe(99999999999000);
  });

  it("skips volume labels and anything that is not a member line", () => {
    expect(parseTarLine('V--------- 0/0 0 2026-09-23 15:11:36 "My Label"--Volume Header--')).toBeNull();
    expect(parseTarLine("tar: Removing leading `/' from member names")).toBeNull();
    expect(parseTarLine("")).toBeNull();
    expect(parseTarLine('-rw-rw-r-- "unterminated')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

const SEVEN_ZIP_OUTPUT = [
  "",
  "7-Zip 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov : 2023-06-20",
  "",
  "Listing archive: t.7z",
  "",
  "--",
  "Path = t.7z",
  "Type = 7z",
  "Physical Size = 331",
  "",
  "----------",
  "Path = dir with space",
  "Size = 0",
  "Packed Size = 0",
  "Modified = 2026-09-23 15:11:22.7688005",
  "Attributes = D drwxrwxr-x",
  "CRC = ",
  "Encrypted = -",
  "",
  "Path = dir with space/secret.txt",
  "Size = 6",
  "Modified = 2026-09-23 15:11:22.7678005",
  "Attributes = A -rw-rw-r--",
  "Encrypted = +",
  "",
  "Path = two",
  "lines.txt",
  "Size = 1",
  "Attributes = A -rw-rw-r--",
  "",
  "Path = link",
  "Size = 0",
  "Attributes = A lrwxrwxrwx",
  "Symbolic Link = ../target",
  "",
];

describe("7z -slt blocks", () => {
  function parseAll(lines: readonly string[]): { entries: ArchiveEntry[]; parser: SevenZipListParser } {
    const parser = new SevenZipListParser();
    const entries: ArchiveEntry[] = [];
    for (const line of lines) {
      const next = parser.push(line);
      if (next !== null) entries.push(next);
    }
    const last = parser.end();
    if (last !== null) entries.push(last);
    return { entries, parser };
  }

  it("skips the archive's own properties and reads one member per block", () => {
    const { entries } = parseAll(SEVEN_ZIP_OUTPUT);
    expect(entries.map((item) => [item.path, item.kind])).toEqual([
      ["dir with space", "directory"],
      ["dir with space/secret.txt", "file"],
      ["two\nlines.txt", "file"],
      ["link", "symlink"],
    ]);
    expect(entries[1]).toMatchObject({ sizeBytes: 6, encrypted: true });
    expect(entries[3]?.linkTarget).toBe("../target");
  });

  it("reads 7z's times back in the local zone it printed them in", () => {
    expect(parseSevenZipTime("2026-09-23 15:11:22.7688005")).toBe(
      new Date(2026, 8, 23, 15, 11, 22, 768).getTime(),
    );
    expect(parseSevenZipTime("")).toBeNull();
  });

  it("recognises RAR folders (Folder = +) and hard links", () => {
    expect(sevenZipEntryFrom(new Map([["Path", "docs"], ["Folder", "+"], ["Attributes", "D"]]))?.kind).toBe(
      "directory",
    );
    expect(
      sevenZipEntryFrom(new Map([["Path", "copy"], ["Hard Link", "original"], ["Size", "0"]])),
    ).toMatchObject({ kind: "hardlink", linkTarget: "original" });
    expect(sevenZipEntryFrom(new Map([["Size", "1"]]))).toBeNull();
  });

  it("collects the ERRORS a damaged archive reports on stdout", () => {
    const { entries, parser } = parseAll([
      "--",
      "Path = trunc.zip",
      "Type = zip",
      "ERRORS:",
      "Unexpected end of archive",
      "Physical Size = 2000",
      "",
      "----------",
      "Path = a.txt",
      "Size = 1",
      "",
      "Errors: 1",
    ]);
    expect(parser.problems).toEqual(["Unexpected end of archive"]);
    expect(entries.map((item) => item.path)).toEqual(["a.txt"]);
  });
});

/* ------------------------------------------------------------------ */

describe("LineSplitter", () => {
  it("joins lines across chunks and hands over the unterminated last one", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(1024, "utf8");
    splitter.push(Buffer.from("first\nsec"), (line) => lines.push(line) > 0);
    splitter.push(Buffer.from("ond\nthi"), (line) => lines.push(line) > 0);
    splitter.end((line) => lines.push(line) > 0);
    expect(lines).toEqual(["first", "second", "thi"]);
  });

  it("drops an overlong line whole instead of cutting it", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(8, "latin1");
    splitter.push(Buffer.from("short\nway too long a line\nok\n"), (line) => lines.push(line) > 0);
    expect(lines).toEqual(["short", "ok"]);
  });

  it("stops the moment the consumer says so", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(64, "utf8");
    const kept = splitter.push(Buffer.from("a\nb\nc\n"), (line) => {
      lines.push(line);
      return line !== "b";
    });
    expect(kept).toBe(false);
    expect(lines).toEqual(["a", "b"]);
  });
});

/* ------------------------------------------------------------------ */

describe("ListingCollector", () => {
  it("counts files, implied folders and bytes over every member it sees", () => {
    const collector = new ListingCollector({ maxEntries: 2, maxScanned: 100, maxDirectories: 100 });
    for (const member of [
      entry({ path: "a/b/one.txt", sizeBytes: 10 }),
      entry({ path: "a/two.txt", sizeBytes: 5, encrypted: true }),
      entry({ path: "a/b", kind: "directory", sizeBytes: 0 }),
      entry({ path: "c/", kind: "directory", sizeBytes: 0 }),
    ]) {
      expect(collector.add(member)).toBe(true);
    }
    expect(collector.finish(null)).toMatchObject({
      totalEntries: 4,
      fileCount: 2,
      // a, a/b, c — each once, whether implied or listed.
      directoryCount: 3,
      uncompressedBytes: 15,
      encryptedCount: 1,
      truncated: true,
      partial: false,
      stoppedBy: null,
    });
    expect(collector.entries.map((item) => item.path)).toEqual(["a/b/one.txt", "a/two.txt"]);
  });

  it("refuses the member past the scan cap, so a full stop is still exact", () => {
    const collector = new ListingCollector({ maxEntries: 10, maxScanned: 2, maxDirectories: 100 });
    expect(collector.add(entry({ path: "1" }))).toBe(true);
    expect(collector.add(entry({ path: "2" }))).toBe(true);
    expect(collector.add(entry({ path: "3" }))).toBe(false);
    expect(collector.finish("entries")).toMatchObject({ totalEntries: 2, partial: true, truncated: true });
  });

  it("stops before the folder set grows past its cap", () => {
    const collector = new ListingCollector({ maxEntries: 10, maxScanned: 100, maxDirectories: 3 });
    expect(collector.add(entry({ path: "a/b/c/file" }))).toBe(true);
    expect(collector.add(entry({ path: "d/file" }))).toBe(false);
    expect(collector.finish("entries").directoryCount).toBe(3);
  });

  it("only carries a problem for a damaged archive", () => {
    const collector = new ListingCollector({ maxEntries: 10, maxScanned: 100, maxDirectories: 100 });
    collector.add(entry({ path: "x" }));
    expect(collector.finish("damaged", "Unexpected EOF")).toMatchObject({
      partial: true,
      problem: "Unexpected EOF",
    });
    expect(collector.finish("time", "ignored").problem).toBeNull();
  });
});
