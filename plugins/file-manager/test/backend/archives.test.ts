// test/backend/archives.test.ts — §11.1's archives row, plus the containment
// guarantees of §6 rule 9.
//
// The malicious fixtures are built by hand (the zip writer below emits stored
// entries with arbitrary member names) because no archiver on the host will
// happily produce a `../evil.txt` member for us.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Job } from "../../contract";
import {
  archiveBaseName,
  canExtractFormat,
  createArchives,
  hasRarCodec,
  probeExecutables,
  supportFrom,
  type ArchivesModule,
  type ExtractorProcess,
} from "../../src/archives";
import { createJobs, type JobsModule } from "../../src/jobs";
import { initRoot } from "../../src/root";

let root: string;
let host: ReturnType<typeof createFakePluginHost>;
let jobs: JobsModule;
let archives: ArchivesModule;

/* ------------------------------------------------------------------ */
/* A minimal ZIP writer (stored entries, arbitrary member names)        */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: ReadonlyArray<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2a21, 12); // arbitrary but valid DOS date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2a21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function exists(candidate: string): Promise<boolean> {
  try {
    await readFile(candidate);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EISDIR";
  }
}

/** Run an extraction to completion and hand back the settled job. */
async function extractAndSettle(
  input: Parameters<ArchivesModule["extractArchive"]>[0],
): Promise<Job> {
  const { job } = await archives.extractArchive(input);
  await archives.idle();
  const settled = jobs.jobStatus({ jobId: job.jobId }).job;
  if (!settled) throw new Error("job vanished");
  return settled;
}

/** Every `.bb-extract-*` directory left behind in `dir` (there must be none). */
async function stagingLeftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith(".bb-extract-"));
}

class FakeChild extends EventEmitter {
  readonly stderr = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-archives-")));
  await initRoot(root);
  host = createFakePluginHost({ pluginId: "file-manager" });
  jobs = createJobs(host.bb);
  archives = await createArchives(host.bb, { jobs });
});

afterEach(async () => {
  await host.harness.lifecycle.dispose();
});

describe("capability probe", () => {
  it("reports the extractors present on this host", async () => {
    const executables = await probeExecutables();
    expect(archives.support).toEqual(supportFrom(executables));
    // The spec's §14 risk 5 baseline: GNU tar and Info-ZIP are both installed.
    expect(archives.support.tar).toBe(true);
    expect(archives.support.zip).toBe(true);
  });

  it("strips the archive suffix to name the subfolder", () => {
    expect(archiveBaseName("photos.tar.gz")).toBe("photos");
    expect(archiveBaseName("backup.TGZ")).toBe("backup");
    expect(archiveBaseName("bundle.zip")).toBe("bundle");
    expect(archiveBaseName("things.7z")).toBe("things");
    expect(archiveBaseName("scans.rar")).toBe("scans");
    expect(archiveBaseName("plain")).toBe("plain");
  });

  it("reads the RAR codec off `7z i`, whatever the other columns look like", () => {
    const withCodec = [
      "Formats:",
      " 0  ...F..........  Rar      rar r00       R a r ! 1A 07 00",
      "",
      "Codecs:",
      " 0  ED     30101 LZMA",
      " 1  ED     40305 Rar5",
      "",
      "Hashers:",
      "      4        1 CRC32",
    ].join("\n");
    // Debian's `7zip`: the Rar *format* is listed, the codec is not.
    const withoutCodec = withCodec.replace(" 1  ED     40305 Rar5\n", "");
    expect(hasRarCodec(withCodec)).toBe(true);
    expect(hasRarCodec(withoutCodec)).toBe(false);
    expect(hasRarCodec("")).toBe(false);
  });

  it("offers RAR extraction only with 7z *and* its RAR codec", () => {
    const base = { tar: "/usr/bin/tar", unzip: null };
    expect(supportFrom({ ...base, sevenZip: "/usr/bin/7z", sevenZipRar: true }).rar).toBe(true);
    expect(supportFrom({ ...base, sevenZip: "/usr/bin/7z", sevenZipRar: false }).rar).toBe(false);
    expect(supportFrom({ ...base, sevenZip: null, sevenZipRar: true }).rar).toBe(false);
    expect(canExtractFormat("rar", { ...base, sevenZip: "/usr/bin/7z", sevenZipRar: false })).toBe(false);
    expect(canExtractFormat("7z", { ...base, sevenZip: "/usr/bin/7z", sevenZipRar: false })).toBe(true);
    expect(canExtractFormat("zip", { ...base, sevenZip: null, sevenZipRar: false })).toBe(false);
  });
});

describe("extractArchive", () => {
  beforeEach(async () => {
    await mkdir(path.join(root, "source", "inner"), { recursive: true });
    await writeFile(path.join(root, "source", "inner", "a.txt"), "alpha");
    await writeFile(path.join(root, "source", "top.txt"), "top");
    execFileSync("tar", ["-czf", path.join(root, "photos.tar.gz"), "-C", path.join(root, "source"), "."]);
  });

  it("extracts a tar.gz into a subfolder named after the archive", async () => {
    const job = await extractAndSettle({
      archivePath: path.join(root, "photos.tar.gz"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });

    expect(job).toMatchObject({
      state: "done",
      kind: "extract",
      label: 'Extracting "photos.tar.gz"',
      resultPath: path.join(root, "photos"),
      errorCode: null,
    });
    expect(job.totalBytes).toBeGreaterThan(0);
    expect(await readFile(path.join(root, "photos", "inner", "a.txt"), "utf8")).toBe("alpha");
    expect(await readFile(path.join(root, "photos", "top.txt"), "utf8")).toBe("top");
    expect(await stagingLeftovers(root)).toEqual([]);

    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "fs",
      payload: { paths: [root], reason: "extract" },
    });
  });

  it("publishes running → done on the job channel", async () => {
    const { job } = await archives.extractArchive({
      archivePath: path.join(root, "photos.tar.gz"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });
    expect(job.state).toBe("running");
    await archives.idle();

    const states = host.harness.inspection.realtimeSignals
      .filter((signal) => signal.channel === "job")
      .map((signal) => (signal.payload as Job).state);
    expect(states).toEqual(["running", "done"]);
  });

  it("merges into the destination when createSubfolder is false", async () => {
    await mkdir(path.join(root, "dest"), { recursive: true });
    const job = await extractAndSettle({
      archivePath: path.join(root, "photos.tar.gz"),
      destinationDir: path.join(root, "dest"),
      createSubfolder: false,
      conflict: "rename",
    });

    expect(job.state).toBe("done");
    expect(job.resultPath).toBe(path.join(root, "dest"));
    expect(await readFile(path.join(root, "dest", "top.txt"), "utf8")).toBe("top");
    expect(await stagingLeftovers(path.join(root, "dest"))).toEqual([]);
  });

  it("commits nothing when one member of an 'extract here' is unnameable", async () => {
    // tar keeps every byte but "/" and NUL, so a control character in a member
    // name reaches the commit loop. Before the two-phase commit this landed
    // the *earlier* members in the destination and then reported the job as
    // failed, while the staging cleanup ate the rest.
    const dirty = path.join(root, "dirty");
    await mkdir(dirty, { recursive: true });
    await writeFile(path.join(dirty, "aaa.txt"), "first");
    await writeFile(path.join(dirty, "b\u0001c.txt"), "control");
    await writeFile(path.join(dirty, "zzz.txt"), "last");
    const archive = path.join(root, "dirty.tar");
    execFileSync("tar", ["-cf", archive, "-C", dirty, "."]);
    const dest = path.join(root, "dirty-dest");
    await mkdir(dest, { recursive: true });

    const job = await extractAndSettle({
      archivePath: archive,
      destinationDir: dest,
      createSubfolder: false,
      conflict: "fail",
    });

    expect(job).toMatchObject({ state: "failed", errorCode: "invalid_name" });
    // Fail closed: not one member may be committed, and no staging left over.
    expect(await readdir(dest)).toEqual([]);
  });

  it("rolls the commit back when a move fails half-way through", async () => {
    const source = path.join(root, "pair");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "aaa.txt"), "first");
    await writeFile(path.join(source, "zzz.txt"), "last");
    const archive = path.join(root, "pair.tar");
    execFileSync("tar", ["-cf", archive, "-C", source, "aaa.txt", "zzz.txt"]);

    // The commit walks the members in sorted order, so `aaa.txt` moves first
    // and `zzz.txt` then fails: `conflict: "overwrite"` has to remove the
    // read-only directory sitting on its name, and cannot.
    const dest = path.join(root, "blocked");
    await mkdir(path.join(dest, "zzz.txt"), { recursive: true });
    await writeFile(path.join(dest, "zzz.txt", "keep"), "keep");
    await chmod(path.join(dest, "zzz.txt"), 0o555);

    try {
      const job = await extractAndSettle({
        archivePath: archive,
        destinationDir: dest,
        createSubfolder: false,
        conflict: "overwrite",
      });

      expect(job.state).toBe("failed");
      // The member that did move is rolled back, so the destination is exactly
      // what it was — no half-extracted archive behind a "failed" job.
      expect((await readdir(dest)).sort()).toEqual(["zzz.txt"]);
      expect(await readFile(path.join(dest, "zzz.txt", "keep"), "utf8")).toBe("keep");
      expect(await stagingLeftovers(dest)).toEqual([]);
    } finally {
      await chmod(path.join(dest, "zzz.txt"), 0o755);
    }
  });

  it("applies the rename conflict policy to the subfolder", async () => {
    await mkdir(path.join(root, "photos"), { recursive: true });
    const job = await extractAndSettle({
      archivePath: path.join(root, "photos.tar.gz"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });

    expect(job.resultPath).toBe(path.join(root, "photos (1)"));
    expect(await readFile(path.join(root, "photos (1)", "top.txt"), "utf8")).toBe("top");
  });

  it("fails the job when the subfolder exists and the policy is fail", async () => {
    await mkdir(path.join(root, "photos"), { recursive: true });
    const job = await extractAndSettle({
      archivePath: path.join(root, "photos.tar.gz"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "fail",
    });

    expect(job).toMatchObject({ state: "failed", errorCode: "exists" });
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("rejects an unsupported extension and a non-file source", async () => {
    await writeFile(path.join(root, "notes.arj"), "not an archive we know");
    await expect(
      archives.extractArchive({
        archivePath: path.join(root, "notes.arj"),
        destinationDir: null,
        createSubfolder: true,
        conflict: "rename",
      }),
    ).rejects.toThrow(/^unsupported_archive: /u);

    await expect(
      archives.extractArchive({
        archivePath: path.join(root, "source"),
        destinationDir: null,
        createSubfolder: true,
        conflict: "rename",
      }),
    ).rejects.toThrow(/^not_a_file: /u);

    await expect(
      archives.extractArchive({
        archivePath: "/etc/shadow.zip",
        destinationDir: null,
        createSubfolder: true,
        conflict: "rename",
      }),
    ).rejects.toThrow(/^path_escape: /u);
  });
});

describe("rar", () => {
  it("refuses up front when 7z cannot unpack RAR data", async () => {
    await writeFile(path.join(root, "scans.rar"), "Rar!");
    const codecless = await createArchives(host.bb, {
      jobs,
      executables: { tar: "/usr/bin/tar", unzip: null, sevenZip: "/usr/bin/7z", sevenZipRar: false },
    });

    await expect(
      codecless.extractArchive({
        archivePath: path.join(root, "scans.rar"),
        destinationDir: null,
        createSubfolder: true,
        conflict: "rename",
      }),
    ).rejects.toThrow(/^unsupported_archive: scans\.rar \(no extractor for rar/u);
  });

  it("runs 7z's extraction plan when the codec is there", async () => {
    await writeFile(path.join(root, "scans.rar"), "Rar!");
    const seen: { command: string; args: readonly string[] }[] = [];
    const withCodec = await createArchives(host.bb, {
      jobs,
      executables: { tar: "/usr/bin/tar", unzip: null, sevenZip: "/opt/7zz", sevenZipRar: true },
      spawnExtractor: (command, args) => {
        seen.push({ command, args });
        const child = new FakeChild();
        setImmediate(() => child.emit("close", 0, null));
        return child as unknown as ExtractorProcess;
      },
    });

    await withCodec.extractArchive({
      archivePath: path.join(root, "scans.rar"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });
    await withCodec.idle();

    expect(seen[0]?.command).toBe("/opt/7zz");
    expect(seen[0]?.args.slice(0, 3)).toEqual(["x", "-y", "-bd"]);
  });
});

describe("containment (§6 rule 9)", () => {
  it("neutralises a zip-slip member named ../evil", async () => {
    await mkdir(path.join(root, "dest"), { recursive: true });
    await writeFile(
      path.join(root, "dest", "payload.zip"),
      makeZip([
        { name: "good.txt", content: "good" },
        { name: "../evil.txt", content: "pwned" },
        { name: "sub/../../evil2.txt", content: "pwned2" },
        { name: "/absolute.txt", content: "pwned3" },
      ]),
    );

    const job = await extractAndSettle({
      archivePath: path.join(root, "dest", "payload.zip"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });

    expect(job.state).toBe("done");
    // Nothing escaped: not into the destination, not into the root, not above.
    for (const escaped of [
      path.join(root, "dest", "evil.txt"),
      path.join(root, "dest", "evil2.txt"),
      path.join(root, "evil.txt"),
      path.join(root, "evil2.txt"),
      path.join(root, "absolute.txt"),
      path.join(path.dirname(root), "evil.txt"),
    ]) {
      expect(await exists(escaped)).toBe(false);
    }
    // The legitimate member landed, and the neutralised ones stayed inside the
    // extraction folder.
    expect(await readFile(path.join(root, "dest", "payload", "good.txt"), "utf8")).toBe("good");
    expect((await readdir(path.join(root, "dest"))).sort()).toEqual(["payload", "payload.zip"]);
    expect(await stagingLeftovers(path.join(root, "dest"))).toEqual([]);
  });

  it("refuses a tar whose member escapes, and leaves nothing behind", async () => {
    // GNU tar 1.35 rejects `..` members outright (exit 2) — the extraction is
    // reported as failed rather than silently partial.
    await mkdir(path.join(root, "slip"), { recursive: true });
    await writeFile(path.join(root, "slip", "evil.txt"), "pwned");
    execFileSync("tar", [
      "-czf",
      path.join(root, "slip.tar.gz"),
      "-C",
      path.join(root, "slip"),
      "--transform",
      "s|^|../|",
      "evil.txt",
    ]);

    const job = await extractAndSettle({
      archivePath: path.join(root, "slip.tar.gz"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });

    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("archive_failed");
    expect(await exists(path.join(path.dirname(root), "evil.txt"))).toBe(false);
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("deletes symlink members that resolve outside the root, keeping internal ones", async () => {
    const build = path.join(root, "build");
    await mkdir(path.join(build, "tree"), { recursive: true });
    await writeFile(path.join(build, "tree", "real.txt"), "real");
    await symlink("/etc/passwd", path.join(build, "tree", "absolute-link"));
    await symlink("../../../../../etc/passwd", path.join(build, "tree", "relative-link"));
    await symlink("real.txt", path.join(build, "tree", "internal-link"));
    await symlink("missing.txt", path.join(build, "tree", "dangling-link"));
    execFileSync("tar", ["-czf", path.join(root, "links.tar.gz"), "-C", build, "tree"]);

    const job = await extractAndSettle({
      archivePath: path.join(root, "links.tar.gz"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });

    expect(job.state).toBe("done");
    const extracted = path.join(root, "links", "tree");
    const names = (await readdir(extracted)).sort();
    // Escaping links are gone; the internal one (and a dangling link that can
    // only ever point inside the tree) survives.
    expect(names).toEqual(["dangling-link", "internal-link", "real.txt"]);
    expect(await readFile(path.join(extracted, "internal-link"), "utf8")).toBe("real");

    const warnings = host.harness.inspection.logEntries.filter((entry) => entry.level === "warn");
    expect(warnings.some((entry) => entry.message.includes("escaping"))).toBe(true);
  });
});

describe("cancellation and extractor failures", () => {
  beforeEach(async () => {
    await writeFile(path.join(root, "slow.zip"), makeZip([{ name: "a.txt", content: "a" }]));
  });

  it("kills the child process and reports canceled", async () => {
    const child = new FakeChild();
    const canceling = await createArchives(host.bb, {
      jobs,
      spawnExtractor: () => child as unknown as ExtractorProcess,
    });

    const { job } = await canceling.extractArchive({
      archivePath: path.join(root, "slow.zip"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });
    // The fake child never exits on its own: the job is genuinely in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(jobs.jobStatus({ jobId: job.jobId }).job).toMatchObject({ state: "running" });

    expect(jobs.jobCancel({ jobId: job.jobId }).job).toMatchObject({ state: "canceled" });
    await canceling.idle();

    expect(child.signals).toContain("SIGTERM");
    expect(jobs.jobStatus({ jobId: job.jobId }).job).toMatchObject({ state: "canceled" });
    // A canceled extraction publishes nothing and cleans its staging area up.
    expect(await stagingLeftovers(root)).toEqual([]);
    expect(
      host.harness.inspection.realtimeSignals.some((signal) => signal.channel === "fs"),
    ).toBe(false);
  });

  it("stops in-flight extractions and drops their staging on dispose", async () => {
    const child = new FakeChild();
    const disposing = await createArchives(host.bb, {
      jobs,
      spawnExtractor: () => child as unknown as ExtractorProcess,
    });

    const { job } = await disposing.extractArchive({
      archivePath: path.join(root, "slow.zip"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await stagingLeftovers(root)).toHaveLength(1);

    // A reload/shutdown must not orphan the child or leave `.bb-extract-*`
    // in the user's folder for ever — nothing else ever collects it.
    await host.harness.lifecycle.dispose();
    await disposing.idle();

    expect(child.signals).toContain("SIGTERM");
    expect(jobs.jobStatus({ jobId: job.jobId }).job).toMatchObject({ state: "canceled" });
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("reports archive_failed with the extractor's stderr when it exits non-zero", async () => {
    const failing = await createArchives(host.bb, {
      jobs,
      spawnExtractor: () => {
        const child = new FakeChild();
        setImmediate(() => child.emit("close", 2, null));
        return child as unknown as ExtractorProcess;
      },
    });

    const { job } = await failing.extractArchive({
      archivePath: path.join(root, "slow.zip"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });
    await failing.idle();

    expect(jobs.jobStatus({ jobId: job.jobId }).job).toMatchObject({
      state: "failed",
      errorCode: "archive_failed",
    });
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it("reports archive_failed when the extractor cannot be spawned", async () => {
    const broken = await createArchives(host.bb, {
      jobs,
      spawnExtractor: () => {
        throw Object.assign(new Error("spawn unzip ENOENT"), { code: "ENOENT" });
      },
    });

    const { job } = await broken.extractArchive({
      archivePath: path.join(root, "slow.zip"),
      destinationDir: null,
      createSubfolder: true,
      conflict: "rename",
    });
    await broken.idle();

    const settled = jobs.jobStatus({ jobId: job.jobId }).job;
    expect(settled?.state).toBe("failed");
    expect(await stagingLeftovers(root)).toEqual([]);
  });
});
