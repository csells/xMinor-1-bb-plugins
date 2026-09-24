// test/backend/archive-listing.test.ts — §8.13, the I/O half: `listArchive`
// against real archives in a temp root, and the bounds against fake children.
//
// Real archives come from three places: the hand-written writers in
// zip-writer.ts (raw CP866 names, encryption flags, zero dates, RAR 4), GNU
// tar run over a temp tree (symlinks, hard links, names with newlines), and
// `7z a` where 7z exists. Every fixture lives inside the temp root, and one
// test proves the listing leaves that root exactly as it found it.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { link, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_ARCHIVE_ENTRIES, type ArchiveListing } from "../../contract";
import {
  createArchiveLister,
  type ArchiveLister,
  type ListerProcess,
  type ListingLimits,
  type SpawnLister,
} from "../../src/archive-listing";
import {
  canExtractFormat,
  createArchives,
  probeExecutables,
  type Executables,
} from "../../src/archives";
import { createJobs } from "../../src/jobs";
import { initRoot } from "../../src/root";
import { makeRar, makeZip } from "./zip-writer";

const executables: Executables = await probeExecutables();
const HAS_7Z = executables.sevenZip !== null;

let root: string;
let host: ReturnType<typeof createFakePluginHost>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-list-archives-")));
  await initRoot(root);
  host = createFakePluginHost({ pluginId: "file-manager" });
});

afterEach(async () => {
  await host.harness.lifecycle.dispose();
});

function lister(overrides: Partial<Parameters<typeof createArchiveLister>[1]> = {}): ArchiveLister {
  return createArchiveLister(host.bb, {
    executables,
    canExtract: (format) => canExtractFormat(format, executables),
    ...overrides,
  });
}

async function write(name: string, content: Buffer | string): Promise<string> {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

function paths(listing: ArchiveListing): string[] {
  return listing.entries.map((entry) => entry.path);
}

/** "Отчёт за 2024" in CP866, the way Explorer on a Russian Windows writes it. */
const REPORT_DIR_CP866 = Buffer.from("8ee2e7f1e220a7a020323032342f", "hex");
const REPORT_FILE_CP866 = Buffer.concat([
  REPORT_DIR_CP866,
  Buffer.from("8fe0a8abaea6a5ada8a520fc312e747874", "hex"), // "Приложение №1.txt"
]);

/* ------------------------------------------------------------------ */
/* zip                                                                 */
/* ------------------------------------------------------------------ */

describe("zip", () => {
  it("decodes CP866 names with no UTF-8 flag, and UTF-8 ones with or without it", async () => {
    await write(
      "windows.zip",
      makeZip([
        { name: REPORT_DIR_CP866, host: 0, externalAttributes: 0x10 },
        { name: REPORT_FILE_CP866, host: 0, content: "hello" },
        { name: "Документы/без флага.txt", content: "utf8, no flag" },
        { name: "Документы/с флагом.txt", flags: 0x0800, content: "utf8, flag" },
      ]),
    );

    const listing = await lister().listArchive({ path: path.join(root, "windows.zip") });

    expect(paths(listing)).toEqual([
      "Отчёт за 2024",
      "Отчёт за 2024/Приложение №1.txt",
      "Документы/без флага.txt",
      "Документы/с флагом.txt",
    ]);
    expect(listing).toMatchObject({
      format: "zip",
      totalEntries: 4,
      fileCount: 3,
      directoryCount: 2,
      uncompressedBytes: 5 + 13 + 10,
      truncated: false,
      partial: false,
      extractable: true,
    });
    expect(listing.entries[0]?.kind).toBe("directory");
    expect(listing.entries[1]?.modifiedAtMs).toBe(new Date(2024, 2, 15, 12, 30).getTime());
  });

  it("shows odd member names as written, and acts on none of them", async () => {
    await write(
      "odd.zip",
      makeZip([
        { name: "dir with space/file one.txt", content: "1" },
        { name: "new\nline.txt", content: "2" },
        { name: "-dash.txt", content: "3" },
        { name: "../evil.txt", content: "4" },
        { name: "/abs.txt", content: "5" },
        { name: "win\\style.txt", content: "6" },
        { name: "dup.txt", content: "7" },
        { name: "dup.txt", content: "8" },
        { name: "links/to-dup", content: "../dup.txt", externalAttributes: (0o120777 << 16) >>> 0 },
      ]),
    );
    const before = (await readdir(root)).sort();

    const listing = await lister().listArchive({ path: "odd.zip" });

    expect(paths(listing)).toEqual([
      "dir with space/file one.txt",
      "new\nline.txt",
      "-dash.txt",
      "../evil.txt",
      "/abs.txt",
      "win/style.txt",
      "dup.txt",
      "dup.txt",
      "links/to-dup",
    ]);
    expect(listing.entries[8]?.kind).toBe("symlink");
    // Listing is read-only: the root holds exactly what it held before.
    expect((await readdir(root)).sort()).toEqual(before);
    expect(await readdir(path.dirname(root))).not.toContain("evil.txt");
  });

  it("marks encrypted members and reads a zero DOS date as no time at all", async () => {
    await write(
      "locked.zip",
      makeZip([
        { name: "open.txt", content: "a" },
        { name: "secret.txt", content: "b", flags: 0x0001 },
        { name: "undated.txt", content: "c", dosDate: 0, dosTime: 0 },
      ]),
    );

    const listing = await lister().listArchive({ path: "locked.zip" });

    expect(listing.encryptedCount).toBe(1);
    expect(listing.entries.map((entry) => entry.encrypted)).toEqual([false, true, false]);
    expect(listing.entries[2]?.modifiedAtMs).toBeNull();
    expect(listing.entries[0]?.modifiedAtMs).not.toBeNull();
  });

  it("reads a zip with a stub in front of it, names and all", async () => {
    const zip = makeZip([{ name: REPORT_FILE_CP866, host: 0, content: "x" }]);
    await write("sfx.zip", Buffer.concat([Buffer.alloc(4096, 0x90), zip]));

    const listing = await lister().listArchive({ path: "sfx.zip" });

    expect(paths(listing)).toEqual(["Отчёт за 2024/Приложение №1.txt"]);
  });

  it("sends the first MAX_ARCHIVE_ENTRIES members and counts the rest", async () => {
    const total = MAX_ARCHIVE_ENTRIES + 1500;
    await write(
      "many.zip",
      makeZip(
        Array.from({ length: total }, (_, index) => ({
          name: `bulk/${String(Math.floor(index / 1000)).padStart(2, "0")}/file-${String(index)}.txt`,
          content: "z",
        })),
      ),
    );

    const listing = await lister().listArchive({ path: "many.zip" });

    expect(listing.entries).toHaveLength(MAX_ARCHIVE_ENTRIES);
    expect(listing).toMatchObject({
      totalEntries: total,
      fileCount: total,
      directoryCount: 1 + 12,
      uncompressedBytes: total,
      truncated: true,
      partial: false,
      stoppedBy: null,
    });
  });

  it("stops at the scan cap and says the counts are a lower bound", async () => {
    await write(
      "capped.zip",
      makeZip(Array.from({ length: 60 }, (_, index) => ({ name: `f${String(index)}`, content: "" }))),
    );

    const listing = await lister({ limits: { maxScanned: 50 } }).listArchive({ path: "capped.zip" });

    expect(listing).toMatchObject({
      totalEntries: 50,
      partial: true,
      truncated: true,
      stoppedBy: "entries",
    });
  });

  it.runIf(HAS_7Z)("hands a zip it cannot read to 7z, which salvages what it can", async () => {
    const zip = makeZip(Array.from({ length: 40 }, (_, index) => ({ name: `f${String(index)}.txt`, content: "x" })));
    // Cut before the central directory: yauzl finds no end record at all.
    await write("cut.zip", zip.subarray(0, Math.floor(zip.length / 2)));

    const listing = await lister().listArchive({ path: "cut.zip" });

    expect(listing.totalEntries).toBeGreaterThan(0);
    expect(listing).toMatchObject({ partial: true, stoppedBy: "damaged" });
    expect(listing.problem).toMatch(/end of archive/iu);
  });

  it("says a file is not a zip when there is no 7z to try", async () => {
    await write("fake.zip", "this is not a zip at all");

    await expect(
      lister({ executables: { ...executables, sevenZip: null, sevenZipRar: false } }).listArchive({
        path: "fake.zip",
      }),
    ).rejects.toThrow(/^archive_failed: fake\.zip: not a readable zip archive/u);
  });
});

/* ------------------------------------------------------------------ */
/* tar                                                                 */
/* ------------------------------------------------------------------ */

describe("tar", () => {
  async function tarTree(): Promise<string> {
    const source = path.join(root, "src");
    await mkdir(path.join(source, "dir with space"), { recursive: true });
    await mkdir(path.join(source, "sub"), { recursive: true });
    await writeFile(path.join(source, "dir with space", "file one.txt"), "hello!");
    await writeFile(path.join(source, "sub", "a.txt"), "x");
    await link(path.join(source, "sub", "a.txt"), path.join(source, "sub", "hard.txt"));
    await symlink("../sub/a.txt", path.join(source, "dir with space", "link -> arrow"));
    await writeFile(path.join(source, "new\nline.txt"), "n");
    await writeFile(path.join(source, "-dash.txt"), "d");
    await writeFile(path.join(source, 'quote"back\\slash.txt'), "q");
    await writeFile(path.join(source, "кириллица.txt"), "c");
    return source;
  }

  it("lists a tar.gz with a symlink, a hard link and awkward names", async () => {
    const source = await tarTree();
    execFileSync("tar", ["-czf", path.join(root, "tree.tar.gz"), "-C", source, "."]);

    const listing = await lister().listArchive({ path: "tree.tar.gz" });
    const byPath = new Map(listing.entries.map((entry) => [entry.path, entry]));

    expect(listing.format).toBe("tar.gz");
    expect(byPath.get("./dir with space/file one.txt")).toMatchObject({ kind: "file", sizeBytes: 6 });
    expect(byPath.get("./dir with space/link -> arrow")).toMatchObject({
      kind: "symlink",
      linkTarget: "../sub/a.txt",
    });
    // Whichever of the two names tar stored first owns the bytes; the other
    // is a hard link to it.
    const hard = [byPath.get("./sub/a.txt"), byPath.get("./sub/hard.txt")].find(
      (entry) => entry?.kind === "hardlink",
    );
    expect(hard?.linkTarget).toMatch(/^\.\/sub\/(a|hard)\.txt$/u);
    for (const name of ["./new\nline.txt", "./-dash.txt", './quote"back\\slash.txt', "./кириллица.txt"]) {
      expect(byPath.get(name)?.kind).toBe("file");
    }
    expect(listing).toMatchObject({ directoryCount: 2, partial: false, extractable: true });
  });

  it("shows a member that climbs out of the archive, without refusing the listing", async () => {
    await mkdir(path.join(root, "slip"), { recursive: true });
    await writeFile(path.join(root, "slip", "evil.txt"), "pwned");
    execFileSync("tar", [
      "-cf",
      path.join(root, "slip.tar"),
      "-C",
      path.join(root, "slip"),
      "--transform",
      "s|^|../|",
      "evil.txt",
    ]);

    const listing = await lister().listArchive({ path: "slip.tar" });

    expect(paths(listing)).toEqual(["../evil.txt"]);
  });

  it("reports a damaged tar.gz as partial, with tar's own complaint", async () => {
    const source = path.join(root, "big");
    await mkdir(source, { recursive: true });
    // Incompressible content, so cutting the file in half cuts the member list.
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(source, `part-${String(index)}.bin`), randomBytes(64 * 1024));
    }
    execFileSync("tar", ["-czf", path.join(root, "full.tar.gz"), "-C", source, "."]);
    const full = await readFile(path.join(root, "full.tar.gz"));
    await write("cut.tar.gz", full.subarray(0, Math.floor(full.length / 2)));

    const listing = await lister().listArchive({ path: "cut.tar.gz" });

    expect(listing.totalEntries).toBeGreaterThan(0);
    expect(listing.totalEntries).toBeLessThan(21);
    expect(listing).toMatchObject({ partial: true, stoppedBy: "damaged" });
    expect(listing.problem).toMatch(/unexpected (end of file|EOF)/iu);
  });

  it("fails cleanly on a file that is not a tar at all", async () => {
    await write("junk.tar.gz", "not gzip");

    await expect(lister().listArchive({ path: "junk.tar.gz" })).rejects.toThrow(
      /^archive_failed: junk\.tar\.gz: tar exited 2/u,
    );
  });

  it("says so when the host has no tar", async () => {
    await write("any.tar", "whatever");
    await expect(
      lister({ executables: { ...executables, tar: null } }).listArchive({ path: "any.tar" }),
    ).rejects.toThrow(/^unsupported_archive: any\.tar \(tar is not installed/u);
  });
});

/* ------------------------------------------------------------------ */
/* 7z and rar                                                          */
/* ------------------------------------------------------------------ */

describe.runIf(HAS_7Z)("7z and rar", () => {
  const sevenZip = executables.sevenZip as string;

  async function sevenZipTree(): Promise<string> {
    const source = path.join(root, "src7");
    await mkdir(path.join(source, "folder"), { recursive: true });
    await writeFile(path.join(source, "folder", "Отчёт.txt"), "report");
    await writeFile(path.join(source, "top.txt"), "top");
    return source;
  }

  it("lists a 7z archive, folders and Cyrillic included", async () => {
    const source = await sevenZipTree();
    execFileSync(sevenZip, ["a", "-bd", path.join(root, "plain.7z"), path.join(source, "*")], { stdio: "ignore" });

    const listing = await lister().listArchive({ path: "plain.7z" });

    expect(paths(listing).sort()).toEqual(["folder", "folder/Отчёт.txt", "top.txt"]);
    expect(listing.entries.find((entry) => entry.path === "folder")?.kind).toBe("directory");
    expect(listing).toMatchObject({ format: "7z", fileCount: 2, directoryCount: 1, encryptedCount: 0 });
  });

  it("marks password-protected members", async () => {
    const source = await sevenZipTree();
    execFileSync(sevenZip, ["a", "-bd", "-psecret", path.join(root, "locked.7z"), path.join(source, "*")], {
      stdio: "ignore",
    });

    const listing = await lister().listArchive({ path: "locked.7z" });

    expect(listing.encryptedCount).toBe(2);
  });

  it("explains an archive whose file list itself is encrypted — without ever prompting", async () => {
    const source = await sevenZipTree();
    execFileSync(
      sevenZip,
      ["a", "-bd", "-psecret", "-mhe=on", path.join(root, "hidden.7z"), path.join(source, "*")],
      { stdio: "ignore" },
    );

    await expect(lister().listArchive({ path: "hidden.7z" })).rejects.toThrow(
      /^archive_failed: hidden\.7z: its list of files is encrypted/u,
    );
  });

  it("lists a RAR through 7z, and only offers extraction when 7z carries the codec", async () => {
    await write(
      "docs.rar",
      makeRar([
        { name: "docs", directory: true },
        { name: "docs/readme.txt", content: "hello rar" },
        { name: "docs/secret.txt", content: "xxxxxxxx", encrypted: true },
        { name: "кириллица.txt", content: "utf8" },
      ]),
    );

    const listing = await lister().listArchive({ path: "docs.rar" });

    expect(paths(listing)).toEqual(["docs", "docs/readme.txt", "docs/secret.txt", "кириллица.txt"]);
    expect(listing).toMatchObject({
      format: "rar",
      fileCount: 3,
      directoryCount: 1,
      encryptedCount: 1,
      extractable: executables.sevenZipRar,
    });
    // RAR 4 keeps a DOS wall-clock time, read back like a zip's.
    expect(listing.entries[1]?.modifiedAtMs).toBe(new Date(2024, 2, 15, 12, 30).getTime());
  });

  it("says so when the host has no 7z", async () => {
    await write("any.7z", "whatever");
    await expect(
      lister({ executables: { ...executables, sevenZip: null, sevenZipRar: false } }).listArchive({
        path: "any.7z",
      }),
    ).rejects.toThrow(/^unsupported_archive: any\.7z \(7z is not installed/u);
  });
});

/* ------------------------------------------------------------------ */
/* The §6 clamp and the error conventions                              */
/* ------------------------------------------------------------------ */

describe("path safety and errors", () => {
  it("refuses anything outside the root, a link out of it included", async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-list-outside-")));
    await writeFile(path.join(outside, "secret.zip"), makeZip([{ name: "a.txt", content: "a" }]));
    await symlink(path.join(outside, "secret.zip"), path.join(root, "innocent.zip"));

    await expect(lister().listArchive({ path: path.join(outside, "secret.zip") })).rejects.toThrow(
      /^path_escape: /u,
    );
    await expect(lister().listArchive({ path: "innocent.zip" })).rejects.toThrow(/^path_escape: /u);
    await expect(lister().listArchive({ path: "../../etc/passwd.zip" })).rejects.toThrow(/^path_escape: /u);
  });

  it("maps the ordinary failures to the ordinary codes", async () => {
    await mkdir(path.join(root, "folder.zip"));
    await write("notes.txt", "plain");

    await expect(lister().listArchive({ path: "missing.zip" })).rejects.toThrow(/^not_found: /u);
    await expect(lister().listArchive({ path: "folder.zip" })).rejects.toThrow(/^not_a_file: /u);
    await expect(lister().listArchive({ path: "notes.txt" })).rejects.toThrow(
      /^unsupported_archive: notes\.txt$/u,
    );
  });

  it("is reachable through createArchives, on the same probe as extraction", async () => {
    await write("via.zip", makeZip([{ name: "a.txt", content: "a" }]));
    const archives = await createArchives(host.bb, { jobs: createJobs(host.bb), executables });

    const listing = await archives.listArchive({ path: "via.zip" });

    expect(paths(listing)).toEqual(["a.txt"]);
    expect(archives.support.rar).toBe(executables.sevenZip !== null && executables.sevenZipRar);
  });
});

/* ------------------------------------------------------------------ */
/* Bounds on the child: time, output, dispose                          */
/* ------------------------------------------------------------------ */

/** A tar/7z stand-in that prints what it is told and exits only when killed. */
class FakeLister extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  /** Exit like a real child: 'close' only after stdout has drained. */
  exit(code: number | null, signal: NodeJS.Signals | null = null, lastOutput = ""): void {
    this.stdout.once("end", () => this.emit("close", code, signal));
    this.stdout.end(lastOutput);
    this.stderr.end();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push((signal ?? "SIGTERM") as NodeJS.Signals);
    setImmediate(() => this.exit(null, (signal ?? "SIGTERM") as NodeJS.Signals));
    return true;
  }
}

function fakeSpawn(child: FakeLister, onSpawn?: (args: readonly string[]) => void): SpawnLister {
  return (_command, args) => {
    onSpawn?.(args);
    return child as unknown as ListerProcess;
  };
}

const TAR_LINE = '-rw-r--r-- 0/0 1 2026-09-23 15:11:22 "file.txt"\n';

describe("bounds", () => {
  const fakeExecutables: Executables = {
    tar: "/fake/tar",
    unzip: null,
    sevenZip: "/fake/7z",
    sevenZipRar: false,
  };

  function boundedLister(child: FakeLister, limits: Partial<ListingLimits>): ArchiveLister {
    return lister({ executables: fakeExecutables, spawnLister: fakeSpawn(child), limits });
  }

  it("runs tar read-only: list mode, C quoting, the archive after --file", async () => {
    const child = new FakeLister();
    let seen: readonly string[] = [];
    await write("a.tar", "x");
    const running = lister({
      executables: fakeExecutables,
      spawnLister: fakeSpawn(child, (args) => {
        seen = args;
        setImmediate(() => child.exit(0, null, TAR_LINE));
      }),
    }).listArchive({ path: "a.tar" });

    expect(paths(await running)).toEqual(["file.txt"]);
    expect(seen).toEqual([
      "--list",
      "--verbose",
      "--full-time",
      "--numeric-owner",
      "--quoting-style=c",
      "--force-local",
      "--file",
      path.join(root, "a.tar"),
    ]);
  });

  it("kills a lister that outruns the clock and answers with what it read", async () => {
    const child = new FakeLister();
    await write("slow.tar.xz", "x");
    const running = boundedLister(child, { timeoutMs: 80 }).listArchive({ path: "slow.tar.xz" });
    setImmediate(() => child.stdout.write(TAR_LINE.repeat(3)));

    const listing = await running;

    expect(child.signals).toContain("SIGTERM");
    expect(listing).toMatchObject({ totalEntries: 3, partial: true, stoppedBy: "time" });
  });

  it("kills a lister whose output passes the cap", async () => {
    const child = new FakeLister();
    await write("chatty.tar", "x");
    const running = boundedLister(child, { maxOutputBytes: 200 }).listArchive({ path: "chatty.tar" });
    setImmediate(() => {
      child.stdout.write(TAR_LINE.repeat(2));
      setImmediate(() => child.stdout.write(TAR_LINE.repeat(10)));
    });

    const listing = await running;

    expect(child.signals).toContain("SIGTERM");
    expect(listing).toMatchObject({ totalEntries: 2, partial: true, stoppedBy: "output" });
  });

  it("kills a lister once the collector is full", async () => {
    const child = new FakeLister();
    await write("huge.tar", "x");
    const running = boundedLister(child, { maxScanned: 5 }).listArchive({ path: "huge.tar" });
    setImmediate(() => child.stdout.write(TAR_LINE.repeat(20)));

    const listing = await running;

    expect(child.signals).toContain("SIGTERM");
    expect(listing).toMatchObject({ totalEntries: 5, stoppedBy: "entries" });
  });

  it("stops a running lister on dispose, and refuses new ones", async () => {
    const child = new FakeLister();
    await write("pending.7z", "x");
    const running = boundedLister(child, {}).listArchive({ path: "pending.7z" });
    const settled = running.then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    await host.harness.lifecycle.dispose();

    expect(await settled).toMatch(/archive_failed: pending\.7z: listing stopped/u);
    expect(child.signals).toContain("SIGTERM");
  });

  it("reports a tool that would not start as the tool's failure, not a missing archive", async () => {
    await write("a.tar", "x");
    const broken = lister({
      executables: fakeExecutables,
      spawnLister: () => {
        throw Object.assign(new Error("spawn /fake/tar ENOENT"), { code: "ENOENT" });
      },
    });

    await expect(broken.listArchive({ path: "a.tar" })).rejects.toThrow(
      /^archive_failed: a\.tar: could not run tar/u,
    );
  });
});
