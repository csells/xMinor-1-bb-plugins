// src/archives.ts — background archive extraction (§13, §6 rule 9).
//
// The threat model is the whole point of this file. An archive is attacker
// controlled data, so extraction happens in three separated phases:
//
//   1. **Stage.** Everything lands in a fresh, private directory
//      `<dest>/.bb-extract-<hex>/out` obtained through resolveNew. The extra
//      level of nesting means a single `../` escape (the classic zip-slip)
//      still lands inside a directory this module owns and deletes.
//   2. **Sweep.** Anything the extractor wrote *beside* `out` is removed
//      before the result is published, and every symlink in the result is
//      re-checked against the hard root once it sits at its final path.
//      GNU tar 1.35 refuses `..` members and Info-ZIP 6.00 strips them, but
//      neither is trusted — §6 rule 9 requires the walk regardless.
//   3. **Commit.** Only then is the tree renamed into the destination, under
//      the caller's conflict policy.
//
// Extraction shells out to `tar`/`unzip`/`7z` (§14 risk 5) with
// `--no-same-owner --no-same-permissions`, never runs as a shell string, and
// never lets an archive choose its own destination.
//
// Looking inside an archive without extracting it (§8.13) is its read-only
// sibling, src/archive-listing.ts. It is built here so that both share one
// probe of the host: the same executables, found once, answer "can I list
// this?" and "can I extract this?".
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readdir, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { ArchiveFormat, ArchiveListing, Job } from "../contract";
import {
  createArchiveLister,
  type ListingLimits,
  type SpawnLister,
} from "./archive-listing";
import { fmError, mapNodeError } from "./errors";
import type { JobsModule } from "./jobs";
import { detectArchiveFormat } from "./listing";
import { uniqueName } from "./mutations";
import { isInside, resolveExisting, resolveExistingDir, resolveNew, validateName } from "./root";
import type { SettingsModule } from "./settings";
import { publishFs } from "./signals";

/* ------------------------------------------------------------------ */
/* Extractor discovery                                                 */
/* ------------------------------------------------------------------ */

/** Which extractors are present on this host (probed once at load). */
export interface ArchiveSupport {
  zip: boolean;
  tar: boolean;
  sevenZip: boolean;
  /** 7z is present *and* carries the RAR codec (see probeRarCodec). */
  rar: boolean;
}

export interface Executables {
  tar: string | null;
  unzip: string | null;
  sevenZip: string | null;
  /** True when `sevenZip` can unpack RAR data, not only read RAR headers. */
  sevenZipRar: boolean;
}

/** PATH lookup without a shell: no quoting bugs, no injection surface. */
async function findExecutable(name: string): Promise<string | null> {
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry !== "");
  for (const dir of parts) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

async function firstExecutable(names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    const found = await findExecutable(name);
    if (found) return found;
  }
  return null;
}

/**
 * True when `7z i` output lists a RAR codec.
 *
 * The codec table follows a `Codecs:` line and runs to the next blank line;
 * each row ends in the codec's name (`… 40305 Rar5`). Only the name is
 * matched, so a build that lays the other columns out differently still
 * answers correctly.
 */
export function hasRarCodec(output: string): boolean {
  let inCodecs = false;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!inCodecs) {
      inCodecs = trimmed === "Codecs:";
      continue;
    }
    if (trimmed === "") break;
    if (/(?:^|\s)Rar\d*$/u.test(trimmed)) return true;
  }
  return false;
}

const RAR_PROBE_TIMEOUT_MS = 5_000;
const RAR_PROBE_OUTPUT_LIMIT = 1024 * 1024;

/**
 * Whether this 7z can unpack RAR data rather than only read RAR headers.
 *
 * 7-Zip keeps the RAR decoder in a separate, non-free codec, and Debian's
 * `7zip` package is built without it (`7zip-rar` adds it back) — yet every
 * build *lists* a RAR, because reading headers needs no decoder. So "7z is
 * installed" answers the listing question and not the extraction one, and
 * `7z i`, which prints the codecs the build carries, answers the other. Any
 * failure reads as "no": the cost is an Extract button, never a job that
 * dies half-way.
 */
export function probeRarCodec(sevenZip: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sevenZip, ["i"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, RAR_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (piece: Buffer) => {
      if (output.length < RAR_PROBE_OUTPUT_LIMIT) output += piece.toString("utf8");
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0 && hasRarCodec(output)));
  });
}

export async function probeExecutables(): Promise<Executables> {
  const [tar, unzip, sevenZip] = await Promise.all([
    findExecutable("tar"),
    findExecutable("unzip"),
    firstExecutable(["7z", "7za", "7zz"]),
  ]);
  const sevenZipRar = sevenZip === null ? false : await probeRarCodec(sevenZip);
  return { tar, unzip, sevenZip, sevenZipRar };
}

export function supportFrom(executables: Executables): ArchiveSupport {
  return {
    // 7z reads zip too, so zip support survives a host without Info-ZIP.
    zip: executables.unzip !== null || executables.sevenZip !== null,
    tar: executables.tar !== null,
    sevenZip: executables.sevenZip !== null,
    rar: executables.sevenZip !== null && executables.sevenZipRar,
  };
}

/* ------------------------------------------------------------------ */
/* Extraction plans                                                    */
/* ------------------------------------------------------------------ */

/**
 * The suffixes stripped to name the "extract into a subfolder" directory.
 * Longest first; the format itself comes from contract.ts#detectArchiveFormat.
 */
const ARCHIVE_SUFFIXES: readonly string[] = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tgz",
  ".tbz2",
  ".tbz",
  ".txz",
  ".zip",
  ".tar",
  ".7z",
  ".rar",
];

/** `photos.tar.gz` → `photos`. Falls back to the full name. */
export function archiveBaseName(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      return fileName.slice(0, fileName.length - suffix.length);
    }
  }
  return fileName;
}

interface ExtractionPlan {
  command: string;
  args: string[];
  /** Info-ZIP and 7z use exit 1 for warnings (e.g. "stripped ../"). */
  acceptsExitCode(code: number | null): boolean;
}

function planFor(
  format: ArchiveFormat,
  executables: Executables,
  archivePath: string,
  outDir: string,
): ExtractionPlan | null {
  const sevenZipPlan = (): ExtractionPlan | null =>
    executables.sevenZip === null
      ? null
      : {
          command: executables.sevenZip,
          args: ["x", "-y", "-bd", `-o${outDir}`, "--", archivePath],
          acceptsExitCode: (code) => code === 0 || code === 1,
        };

  if (format === "zip") {
    if (executables.unzip !== null) {
      return {
        command: executables.unzip,
        // -qq quiet, -o overwrite inside our own staging tree only.
        args: ["-qq", "-o", archivePath, "-d", outDir],
        acceptsExitCode: (code) => code === 0 || code === 1,
      };
    }
    return sevenZipPlan();
  }

  if (format === "7z") return sevenZipPlan();
  // A 7z without the RAR codec lists a RAR fine and then fails on the first
  // compressed member, so it does not count as an extractor for one.
  if (format === "rar") return executables.sevenZipRar ? sevenZipPlan() : null;

  if (executables.tar === null) return null;
  return {
    command: executables.tar,
    // GNU tar auto-detects gz/bz2/xz on extract. The two --no-same-* flags are
    // mandatory (§13): an archive must never restore foreign ownership or
    // setuid bits.
    args: [
      "-x",
      "-f",
      archivePath,
      "-C",
      outDir,
      "--no-same-owner",
      "--no-same-permissions",
    ],
    acceptsExitCode: (code) => code === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Child process plumbing (injectable for tests)                       */
/* ------------------------------------------------------------------ */

export interface ExtractorProcess {
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnExtractor = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => ExtractorProcess;

const defaultSpawn: SpawnExtractor = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    // No stdin, no stdout: only stderr is interesting, and it is bounded below.
    stdio: ["ignore", "ignore", "pipe"],
  });

const STDERR_LIMIT = 8 * 1024;
const KILL_ESCALATION_MS = 3_000;
/** `.bb-extract-<hex>` — the staging roots this module creates. */
const STALE_STAGING_PATTERN = /^\.bb-extract-[0-9a-f]{1,16}$/u;
/** Abandoned staging roots are only collected once they are this old. */
const STALE_STAGING_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Module shape                                                        */
/* ------------------------------------------------------------------ */

export interface ExtractArchiveInput {
  archivePath: string;
  destinationDir: string | null;
  createSubfolder: boolean;
  conflict: "rename" | "overwrite" | "fail";
}

export interface ArchivesModule {
  extractArchive(input: ExtractArchiveInput): Promise<{ job: Job }>;
  /** §8.13: the table of contents, read without extracting anything. */
  listArchive(input: { path: string }): Promise<ArchiveListing>;
  /** Probed once at load; served verbatim in getState().archiveSupport. */
  readonly support: ArchiveSupport;
  /** Resolves when every extraction started so far has settled (tests). */
  idle(): Promise<void>;
}

export interface ArchivesOptions {
  jobs: JobsModule;
  /** Accepted for symmetry with the other factories; unused today. */
  settings?: Pick<SettingsModule, "chunkSizeBytes">;
  spawnExtractor?: SpawnExtractor;
  /** Test seams for the lister (src/archive-listing.ts). */
  spawnLister?: SpawnLister;
  listingLimits?: Partial<ListingLimits>;
  executables?: Executables;
}

/**
 * Whether `extractArchive` would accept `format` on a host with these
 * executables — the same plan probe it runs before promising a job.
 */
export function canExtractFormat(format: ArchiveFormat, executables: Executables): boolean {
  return planFor(format, executables, "", "") !== null;
}

export async function createArchives(
  bb: BbPluginApi,
  options: ArchivesOptions,
): Promise<ArchivesModule> {
  const jobs = options.jobs;
  const spawnExtractor = options.spawnExtractor ?? defaultSpawn;
  const executables = options.executables ?? (await probeExecutables());
  const support = supportFrom(executables);
  // Built on the same probe, so "can list" and "can extract" never disagree
  // about which tools this host has.
  const lister = createArchiveLister(bb, {
    executables,
    canExtract: (format) => canExtractFormat(format, executables),
    ...(options.spawnLister === undefined ? {} : { spawnLister: options.spawnLister }),
    ...(options.listingLimits === undefined ? {} : { limits: options.listingLimits }),
  });
  const running = new Set<Promise<void>>();
  /** jobId -> staging root of every extraction that is still on disk. */
  const staging = new Map<string, string>();

  /* ---------------------------------------------------------------- */
  /* Containment                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Delete every symlink under `target` that does not resolve inside the hard
   * root. Runs *after* the tree reaches its final path, because a relative
   * link's meaning depends on where the tree sits. Returns what it removed.
   */
  async function sweepSymlinks(target: string, removed: string[]): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(target, dirent.name);
      // Lexical belt-and-braces: a name can never contain a separator, so this
      // only fires if something very strange happened underneath us.
      if (!isInside(full) || !full.startsWith(target + path.sep)) {
        await rm(full, { recursive: true, force: true }).catch(() => undefined);
        removed.push(full);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        if (!(await linkStaysInsideRoot(full))) {
          await rm(full, { force: true }).catch(() => undefined);
          removed.push(full);
        }
        continue;
      }
      if (dirent.isDirectory()) await sweepSymlinks(full, removed);
    }
  }

  /**
   * A link is kept when it resolves inside the root. A dangling link is judged
   * lexically (readlink + resolve) so that archives with internal links to
   * files the user did not extract survive, while `../../../etc/passwd` does
   * not.
   */
  async function linkStaysInsideRoot(linkPath: string): Promise<boolean> {
    try {
      return isInside(await realpath(linkPath));
    } catch {
      // Broken link: fall back to a purely lexical resolution.
    }
    try {
      const raw = await readlink(linkPath);
      const resolved = path.resolve(path.dirname(linkPath), raw);
      return isInside(resolved);
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Commit                                                            */
  /* ---------------------------------------------------------------- */

  async function exists(candidate: string): Promise<boolean> {
    try {
      await lstat(candidate);
      return true;
    } catch {
      return false;
    }
  }

  /** Apply the conflict policy for one destination name; returns the target. */
  async function claim(
    destReal: string,
    desiredName: string,
    conflict: ExtractArchiveInput["conflict"],
  ): Promise<string> {
    const naive = await resolveNew(destReal, validateName(desiredName));
    if (!(await exists(naive))) return naive;
    if (conflict === "fail") throw fmError("exists", naive);
    if (conflict === "rename") {
      return resolveNew(destReal, await uniqueName(destReal, desiredName));
    }
    await rm(naive, { recursive: true, force: true }).catch((error: unknown) => {
      throw mapNodeError(error, naive);
    });
    return naive;
  }

  async function moveInto(source: string, target: string): Promise<void> {
    try {
      await rename(source, target);
    } catch (error) {
      throw mapNodeError(error, target);
    }
  }

  /**
   * Undo a partial "extract here" commit. Best effort by nature — the entries
   * go back into the staging tree, which `run()` deletes either way, so the
   * user sees the failed job on an untouched destination instead of half an
   * archive. What cannot be undone is a `conflict: "overwrite"` claim that
   * already removed an existing entry; that is why every name is validated
   * before the first move.
   */
  async function rollback(moved: readonly { source: string; target: string }[]): Promise<void> {
    for (let index = moved.length - 1; index >= 0; index -= 1) {
      const entry = moved[index];
      if (entry === undefined) continue;
      try {
        await rename(entry.target, entry.source);
      } catch (error) {
        bb.log.warn(`extract rollback failed for ${entry.target}: ${String(error)}`);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* extractArchive                                                    */
  /* ---------------------------------------------------------------- */

  async function extractArchive(input: ExtractArchiveInput): Promise<{ job: Job }> {
    const archiveReal = await resolveExisting(input.archivePath);
    const archiveStat = await stat(archiveReal).catch((error: unknown) => {
      throw mapNodeError(error, archiveReal);
    });
    if (!archiveStat.isFile()) throw fmError("not_a_file", archiveReal);

    const fileName = path.basename(archiveReal);
    const format = detectArchiveFormat(fileName);
    if (format === null) throw fmError("unsupported_archive", fileName);

    const destReal = await resolveExistingDir(
      input.destinationDir === null || input.destinationDir === ""
        ? path.dirname(archiveReal)
        : input.destinationDir,
    );

    // Probe the plan before promising a job: "no extractor installed" is a
    // synchronous, actionable failure, not a job that dies a second later.
    if (planFor(format, executables, archiveReal, destReal) === null) {
      throw fmError("unsupported_archive", `${fileName} (no extractor for ${format} on this host)`);
    }

    const job = jobs.create({
      kind: "extract",
      label: `Extracting "${fileName}"`,
      totalBytes: archiveStat.size,
    });

    const task = run(job.jobId, {
      archiveReal,
      fileName,
      format,
      destReal,
      createSubfolder: input.createSubfolder,
      conflict: input.conflict,
    }).catch((error: unknown) => {
      // run() maps its own failures; this is the last resort.
      const mapped = mapNodeError(error, fileName);
      jobs.fail(job.jobId, mapped.code, mapped.detail);
    });
    running.add(task);
    void task.finally(() => running.delete(task));

    return { job };
  }

  interface RunContext {
    archiveReal: string;
    fileName: string;
    format: ArchiveFormat;
    destReal: string;
    createSubfolder: boolean;
    conflict: ExtractArchiveInput["conflict"];
  }

  async function run(jobId: string, context: RunContext): Promise<void> {
    // The staging root is ours alone: created here, deleted in `finally`.
    const stagingName = `.bb-extract-${Math.random().toString(16).slice(2, 10)}`;
    const stagingRoot = await resolveNew(context.destReal, stagingName);
    const outDir = path.join(stagingRoot, "out");
    staging.set(jobId, stagingRoot);

    try {
      await sweepStaleStaging(context.destReal);
      await mkdir(outDir, { recursive: true });

      const plan = planFor(context.format, executables, context.archiveReal, outDir);
      if (plan === null) {
        jobs.fail(jobId, "unsupported_archive", context.fileName);
        return;
      }

      const result = await runProcess(jobId, plan, outDir);
      if (jobs.isCanceled(jobId)) return;

      if (!plan.acceptsExitCode(result.code)) {
        const detail = result.stderr.trim().split("\n").slice(0, 4).join("; ");
        jobs.fail(
          jobId,
          "archive_failed",
          `${context.fileName}: ${path.basename(plan.command)} exited ${String(result.code ?? result.signal)}${detail ? ` — ${detail}` : ""}`,
        );
        return;
      }

      const removed: string[] = [];
      // Phase 2a: anything written beside `out` escaped the intended tree.
      for (const name of await readdir(stagingRoot)) {
        if (name === "out") continue;
        const escaped = path.join(stagingRoot, name);
        await rm(escaped, { recursive: true, force: true }).catch(() => undefined);
        removed.push(escaped);
      }

      // Phase 3: commit, then re-check symlinks at their final location.
      const targets: string[] = [];
      let resultPath: string;
      if (context.createSubfolder) {
        const target = await claim(
          context.destReal,
          archiveBaseName(context.fileName),
          context.conflict,
        );
        await moveInto(outDir, target);
        targets.push(target);
        resultPath = target;
      } else {
        // Sorted so the commit order is reproducible: a failure half-way
        // through is then the same failure on a retry, not a coin toss.
        const names = (await readdir(outDir)).sort();
        // Validate every name *before* the first entry lands in the user's
        // folder. `claim()` calls validateName too, but doing it there only
        // means a control character in the tenth member commits the first nine
        // and then reports the job as failed — a half-extracted destination
        // the user was told about only as an error.
        for (const name of names) validateName(name);
        if (context.conflict === "fail") {
          for (const name of names) {
            if (await exists(path.join(context.destReal, name))) {
              throw fmError("exists", path.join(context.destReal, name));
            }
          }
        }
        const moved: { source: string; target: string }[] = [];
        try {
          for (const name of names) {
            const source = path.join(outDir, name);
            const target = await claim(context.destReal, name, context.conflict);
            await moveInto(source, target);
            moved.push({ source, target });
            targets.push(target);
          }
        } catch (error) {
          // Any failure in the middle (EACCES, ENOSPC, a racing `exists`)
          // rolls the commit back: fail-closed, exactly like the header of
          // this file promises.
          await rollback(moved);
          throw error;
        }
        resultPath = context.destReal;
      }

      for (const target of targets) {
        const st = await lstat(target).catch(() => null);
        if (st === null) continue;
        if (st.isSymbolicLink()) {
          if (!(await linkStaysInsideRoot(target))) {
            await rm(target, { force: true }).catch(() => undefined);
            removed.push(target);
          }
          continue;
        }
        if (st.isDirectory()) await sweepSymlinks(target, removed);
      }

      if (removed.length > 0) {
        bb.log.warn(
          `extract ${context.fileName}: removed ${removed.length} escaping entr${removed.length === 1 ? "y" : "ies"} (${removed.slice(0, 5).join(", ")})`,
        );
      }

      // A cancel that lands during the commit cannot un-move the files; the
      // job simply stays `canceled` and the panel refetches the directory.
      if (jobs.isCanceled(jobId)) return;
      publishFs(bb, [context.destReal], "extract");
      jobs.succeed(jobId, resultPath);
    } catch (error) {
      if (!jobs.isCanceled(jobId)) {
        const mapped = mapNodeError(error, context.fileName);
        jobs.fail(jobId, mapped.code === "io_error" ? "archive_failed" : mapped.code, mapped.detail);
      }
    } finally {
      staging.delete(jobId);
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * A `SIGKILL` (or a host crash) skips the `finally` above and leaves a
   * `.bb-extract-<hex>` directory in the user's folder for ever: there is no
   * central place to sweep, because staging deliberately lives next to the
   * destination so the commit is a rename, not a copy. Extracting into the
   * same folder again is the one moment we are guaranteed to look at it, so
   * that is where the GC runs. The age cut-off keeps a concurrent extraction
   * (whose own root is minutes old at most) safe.
   */
  async function sweepStaleStaging(destReal: string): Promise<void> {
    const own = new Set(staging.values());
    let names: string[];
    try {
      names = await readdir(destReal);
    } catch {
      return;
    }
    for (const name of names) {
      if (!STALE_STAGING_PATTERN.test(name)) continue;
      const candidate = path.join(destReal, name);
      if (own.has(candidate)) continue;
      try {
        const info = await lstat(candidate);
        if (!info.isDirectory() || Date.now() - info.mtimeMs < STALE_STAGING_MS) continue;
      } catch {
        continue;
      }
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      bb.log.warn(`extract: removed abandoned staging directory ${candidate}`);
    }
  }

  interface ProcessResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }

  function runProcess(jobId: string, plan: ExtractionPlan, cwd: string): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve, reject) => {
      let child: ExtractorProcess;
      try {
        child = spawnExtractor(plan.command, plan.args, { cwd });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      let stderr = "";
      child.stderr?.on("data", (piece: unknown) => {
        if (stderr.length >= STDERR_LIMIT) return;
        stderr += String(piece);
      });

      let settled = false;
      child.once("error", (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal, stderr });
      });

      // jobCancel() flips the job to `canceled` first and then calls this, so
      // the close handler above knows not to report a failure.
      jobs.onCancel(jobId, () => {
        child.kill("SIGTERM");
        const escalation = setTimeout(() => {
          child.kill("SIGKILL");
        }, KILL_ESCALATION_MS);
        escalation.unref?.();
      });
    });
  }

  async function idle(): Promise<void> {
    while (running.size > 0) {
      await Promise.allSettled([...running]);
    }
  }

  // §7.2: a reload/shutdown must not orphan a `tar` child that keeps writing
  // into a directory nobody will ever clean up. Hooks run LIFO, so this one
  // runs before server.ts's final log line.
  bb.onDispose(async () => {
    const pending = [...staging.entries()];
    for (const [jobId] of pending) jobs.jobCancel({ jobId });
    for (const [jobId, stagingRoot] of pending) {
      staging.delete(jobId);
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (pending.length > 0) {
      bb.log.info(`archives disposed — stopped ${String(pending.length)} extraction(s)`);
    }
  });

  bb.log.info(
    `archive support — zip:${support.zip} tar:${support.tar} 7z:${support.sevenZip} rar:${support.rar}`,
  );

  return { extractArchive, listArchive: lister.listArchive, support, idle };
}
