// src/archive-listing.ts — look inside an archive without extracting it
// (§8.13). The read-only sibling of src/archives.ts, built by it on the same
// probe of the host.
//
// It inherits that file's threat model: an archive is attacker-controlled
// data. So nothing here ever writes anything, anywhere —
//
//   * a zip's central directory is read in-process by yauzl, which is also
//     the only way to get member names as raw bytes (the CP866 problem, see
//     src/archive-parse.ts);
//   * tar and 7z only ever run their *list* command, found by the same PATH
//     probe as the extractors, never through a shell, with the archive after
//     `--file` / `--`, and with stdin closed — so not even a password prompt
//     can sit waiting for a keyboard nobody has.
//
// The RPC waits for the answer and bb has no way to call a request off, so
// every listing is bounded three ways:
//
//   * members returned — MAX_ARCHIVE_ENTRIES; the rest are counted, not sent;
//   * members scanned and folders remembered — what keeps memory flat on a
//     hostile archive whatever its table of contents claims;
//   * wall clock and bytes of tool output — what keeps a 20 GB `.tar.xz`
//     (which tar has to decompress end to end just to list) from holding the
//     request for minutes.
//
// A bound that trips kills the child the way an extraction's cancel does —
// SIGTERM, then SIGKILL — and answers with what was read so far, marked
// `partial`. So does a plugin dispose, except that it answers with an error:
// nobody is waiting for that answer any more.
import { spawn } from "node:child_process";
import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Stats } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { RandomAccessReader, fromRandomAccessReaderPromise, type ZipFile } from "yauzl";

import {
  MAX_ARCHIVE_ENTRIES,
  detectArchiveFormat,
  type ArchiveFormat,
  type ArchiveListing,
  type ArchiveStopReason,
} from "../contract";
import {
  LineSplitter,
  ListingCollector,
  SevenZipListParser,
  ZIP_TAIL_BYTES,
  parseTarLine,
  zipEntryFrom,
  zipPrefixLength,
} from "./archive-parse";
import type { Executables } from "./archives";
import { fmError, isFileManagerError, mapNodeError, type FileManagerError } from "./errors";
import { resolveExisting } from "./root";

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

export interface ListingLimits {
  /** Members sent to the page. */
  maxEntries: number;
  /** Members counted before the scan stops. */
  maxScanned: number;
  /** Distinct folders remembered (for the count) before the scan stops. */
  maxDirectories: number;
  /** Wall clock for one listing, spawn to answer. */
  timeoutMs: number;
  /** Bytes of tool output read before the scan stops. */
  maxOutputBytes: number;
  /** A longer line is dropped whole — no real listing line comes close. */
  maxLineBytes: number;
}

export const DEFAULT_LISTING_LIMITS: ListingLimits = {
  maxEntries: MAX_ARCHIVE_ENTRIES,
  // A million members is past any real archive's table of contents and still
  // only a few hundred megabytes of `7z -slt` output; the clock usually ends
  // a scan that big first.
  maxScanned: 1_000_000,
  maxDirectories: 100_000,
  timeoutMs: 10_000,
  maxOutputBytes: 256 * 1024 * 1024,
  maxLineBytes: 64 * 1024,
};

/** Same grace an extraction's child gets between SIGTERM and SIGKILL. */
const KILL_ESCALATION_MS = 3_000;
const STDERR_LIMIT = 8 * 1024;

/**
 * Handed to `7z` so an archive whose *file list* is encrypted fails at once
 * with "Wrong password?" instead of prompting. Any fixed string does; this
 * one only has to be unlikely to be anyone's actual password.
 */
const NO_PASSWORD = "-pbb-file-manager-listing";

/* ------------------------------------------------------------------ */
/* Child process plumbing (injectable for tests)                       */
/* ------------------------------------------------------------------ */

export interface ListerProcess {
  /** Present for a real child; the default spawner makes it a group leader. */
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnLister = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => ListerProcess;

const defaultSpawn: SpawnLister = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    // stdin closed: a tool that wants a password reads EOF and gives up.
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a kill also reaches the `xz` or `gzip` that
    // GNU tar runs underneath itself for a compressed archive.
    detached: true,
  });

/**
 * Signal the child's whole process group when it leads one (the default
 * spawner's children do), else just the child. A group that has already
 * gone reports ESRCH, which is the outcome we wanted anyway.
 */
function signalChild(child: ListerProcess, signal: NodeJS.Signals): void {
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Not a group leader after all, or already gone: fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

/** The first few meaningful lines of a tool's stderr, as one line. */
function summarize(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    // "ERRORS:" and "WARNINGS:" only head the lines worth keeping.
    .filter((line) => line !== "" && !/^[A-Z]+:$/u.test(line))
    .slice(0, 4)
    .join("; ");
}

/**
 * A tool that would not start. Not `mapNodeError`: its ENOENT would read as
 * "the archive is not there" when it is the *tool* that is missing.
 */
function cannotRun(command: string, fileName: string, error: unknown): FileManagerError {
  const reason = error instanceof Error ? error.message : String(error);
  return fmError("archive_failed", `${fileName}: could not run ${path.basename(command)} (${reason})`);
}

/* ------------------------------------------------------------------ */
/* zip reads                                                           */
/* ------------------------------------------------------------------ */

/** Big enough that a central directory is read in a few dozen syscalls. */
const WINDOW_BYTES = 256 * 1024;

/**
 * The archive as yauzl sees it: read through a window, and shifted past any
 * prefix (zipPrefixLength).
 *
 * The window is the reason this exists. yauzl reads a central directory with
 * two small reads per member — the fixed 46-byte header, then name and extra
 * fields — and each plain read is its own trip through the thread pool: a
 * 25 000-member zip took a second and a half that way. Served from memory
 * the same walk is a few dozen real reads. A read that does not fit the
 * window, and the member-data stream yauzl would open for an extraction
 * (which a listing never asks for), go straight to the file.
 */
class WindowedReader extends RandomAccessReader {
  private window: Buffer = Buffer.alloc(0);
  private windowStart = 0;
  private closed = false;

  constructor(
    private readonly handle: FileHandle,
    private readonly prefix: number,
  ) {
    super();
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null, bytesRead?: number) => void,
  ): void {
    const start = position + this.prefix;
    const from = start - this.windowStart;
    if (from >= 0 && from + length <= this.window.length) {
      this.window.copy(buffer, offset, from, from + length);
      // Never call back synchronously: yauzl's loop expects a tick between.
      setImmediate(() => callback(null, length));
      return;
    }
    if (length > WINDOW_BYTES) {
      this.handle.read(buffer, offset, length, start).then(
        (result) => callback(null, result.bytesRead),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    const window = Buffer.allocUnsafe(WINDOW_BYTES);
    this.handle.read(window, 0, WINDOW_BYTES, start).then(
      (result) => {
        this.window = window.subarray(0, result.bytesRead);
        this.windowStart = start;
        const copied = Math.min(length, result.bytesRead);
        this.window.copy(buffer, offset, 0, copied);
        callback(null, copied);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  override _readStreamForRange(start: number, end: number): Readable {
    return this.handle.createReadStream({
      start: start + this.prefix,
      end: end + this.prefix - 1,
      autoClose: false,
    });
  }

  override close(callback: (error: Error | null) => void): void {
    if (this.closed) {
      setImmediate(() => callback(null));
      return;
    }
    this.closed = true;
    this.handle.close().then(
      () => callback(null),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export interface ArchiveListerOptions {
  /** From src/archives.ts's probe; the lister never looks for tools itself. */
  executables: Executables;
  /** Whether `extractArchive` would take this format on this host. */
  canExtract(format: ArchiveFormat): boolean;
  spawnLister?: SpawnLister;
  limits?: Partial<ListingLimits>;
}

export interface ArchiveLister {
  listArchive(input: { path: string }): Promise<ArchiveListing>;
}

/** How one reader finished: why it stopped early, if it did, and what broke. */
interface ScanOutcome {
  stoppedBy: ArchiveStopReason | null;
  problem: string | null;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Set when *we* ended the run: a bound tripped. */
  stoppedBy: ArchiveStopReason | null;
}

export function createArchiveLister(
  bb: BbPluginApi,
  options: ArchiveListerOptions,
): ArchiveLister {
  const { executables } = options;
  const spawnLister = options.spawnLister ?? defaultSpawn;
  const limits: ListingLimits = { ...DEFAULT_LISTING_LIMITS, ...options.limits };
  /** Every child still running, with the function that ends it. */
  const live = new Map<ListerProcess, () => void>();
  let disposed = false;

  function shuttingDown(fileName: string): FileManagerError {
    return fmError("archive_failed", `${fileName}: listing stopped, the plugin is shutting down`);
  }

  /**
   * Run one lister to completion, feeding stdout to `onLine` a line at a
   * time. `onLine` answers false when the collector is full; the run then
   * ends early with `stoppedBy: "entries"`.
   */
  function runLister(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    encoding: "latin1" | "utf8",
    deadline: number,
    fileName: string,
    onLine: (line: string) => boolean,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      if (disposed) {
        reject(shuttingDown(fileName));
        return;
      }
      let child: ListerProcess;
      try {
        child = spawnLister(command, args, { env });
      } catch (error) {
        reject(cannotRun(command, fileName, error));
        return;
      }

      const splitter = new LineSplitter(limits.maxLineBytes, encoding);
      let stoppedBy: ArchiveStopReason | null = null;
      let aborted = false;
      let outputBytes = 0;
      let stderr = "";
      let escalation: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      // Once only, and never after the child has closed: a second timer would
      // outlive `settle()`, and a group id outlives nothing — it can be
      // reused by the time a stale SIGKILL goes out.
      const terminate = (): void => {
        if (settled || escalation !== null) return;
        signalChild(child, "SIGTERM");
        escalation = setTimeout(() => {
          if (!settled) signalChild(child, "SIGKILL");
        }, KILL_ESCALATION_MS);
        escalation.unref?.();
      };
      const stop = (reason: ArchiveStopReason): void => {
        if (stoppedBy !== null || aborted) return;
        stoppedBy = reason;
        terminate();
      };
      live.set(child, () => {
        if (aborted) return;
        aborted = true;
        terminate();
      });

      const timer = setTimeout(() => stop("time"), Math.max(0, deadline - Date.now()));
      timer.unref?.();

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stoppedBy !== null || aborted) return;
        outputBytes += chunk.length;
        if (outputBytes > limits.maxOutputBytes) {
          stop("output");
          return;
        }
        if (!splitter.push(chunk, onLine)) stop("entries");
      });
      child.stderr?.on("data", (piece: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += piece.toString("utf8");
      });

      const settle = (): void => {
        settled = true;
        clearTimeout(timer);
        if (escalation !== null) clearTimeout(escalation);
        live.delete(child);
      };
      child.once("error", (error: Error) => {
        if (settled) return;
        settle();
        reject(cannotRun(command, fileName, error));
      });
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settle();
        if (aborted) {
          reject(shuttingDown(fileName));
          return;
        }
        // A last line without a newline still counts — unless we already
        // stopped reading on purpose.
        if (stoppedBy === null && !splitter.end(onLine)) stoppedBy = "entries";
        resolve({ code, signal, stderr, stoppedBy });
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* tar                                                               */
  /* ---------------------------------------------------------------- */

  async function scanTar(
    tar: string,
    archiveReal: string,
    fileName: string,
    collector: ListingCollector,
    deadline: number,
  ): Promise<ScanOutcome> {
    // The C locale makes `--quoting-style=c` escape every byte above 0x7e, so
    // names come back byte-exact; UTC makes `--full-time` print what tar
    // actually stores. TAR_OPTIONS is dropped because GNU tar prepends it to
    // the command line, and a `--quoting-style` of the user's own would
    // quietly change what this parser reads.
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", TZ: "UTC" };
    delete env.TAR_OPTIONS;
    const result = await runLister(
      tar,
      [
        "--list",
        "--verbose",
        "--full-time",
        "--numeric-owner",
        "--quoting-style=c",
        // A ':' in the name must not turn the file into a remote archive.
        "--force-local",
        "--file",
        archiveReal,
      ],
      env,
      "latin1",
      deadline,
      fileName,
      (line) => {
        const entry = parseTarLine(line);
        return entry === null || collector.add(entry);
      },
    );
    return outcomeOf(result, collector, () =>
      fmError(
        "archive_failed",
        `${fileName}: tar exited ${String(result.code ?? result.signal)}${
          summarize(result.stderr) === "" ? "" : ` — ${summarize(result.stderr)}`
        }`,
      ),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 7z (7z, rar, and zip when yauzl cannot read one)                  */
  /* ---------------------------------------------------------------- */

  async function scanSevenZip(
    sevenZip: string,
    archiveReal: string,
    fileName: string,
    collector: ListingCollector,
    deadline: number,
  ): Promise<ScanOutcome> {
    const parser = new SevenZipListParser();
    const result = await runLister(
      sevenZip,
      ["l", "-slt", "-sccUTF-8", "-bd", NO_PASSWORD, "--", archiveReal],
      // The inherited zone on purpose: parseSevenZipTime reads 7z's local
      // times back in this same zone.
      { ...process.env },
      "utf8",
      deadline,
      fileName,
      (line) => {
        const entry = parser.push(line);
        return entry === null || collector.add(entry);
      },
    );
    if (result.stoppedBy === null) {
      const last = parser.end();
      if (last !== null && !collector.add(last)) result.stoppedBy = "entries";
    }
    // 7z reports a damaged archive on stdout, among its properties.
    const reported = parser.problems.join("; ");
    return outcomeOf(result, collector, () => {
      if (/wrong password|encrypted archive/iu.test(result.stderr)) {
        return fmError(
          "archive_failed",
          `${fileName}: its list of files is encrypted — it cannot be shown without the password`,
        );
      }
      const detail = [summarize(result.stderr), reported].filter((part) => part !== "").join("; ");
      return fmError(
        "archive_failed",
        `${fileName}: 7z exited ${String(result.code ?? result.signal)}${detail === "" ? "" : ` — ${detail}`}`,
      );
    }, (code) => code === 0 || code === 1, reported);
  }

  /**
   * Turn a finished run into an outcome. A bound we tripped is `partial`
   * whatever the exit code says. Otherwise a failure that still produced
   * members is a damaged archive — show what was read and say what broke —
   * and one that produced none is an error.
   */
  function outcomeOf(
    result: RunResult,
    collector: ListingCollector,
    failure: () => FileManagerError,
    succeeded: (code: number | null) => boolean = (code) => code === 0,
    reported = "",
  ): ScanOutcome {
    if (result.stoppedBy !== null) return { stoppedBy: result.stoppedBy, problem: null };
    if (succeeded(result.code)) return { stoppedBy: null, problem: null };
    if (collector.scannedCount > 0) {
      const problem = reported !== "" ? reported : summarize(result.stderr);
      return { stoppedBy: "damaged", problem: problem === "" ? failure().detail : problem };
    }
    throw failure();
  }

  /* ---------------------------------------------------------------- */
  /* zip                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Walk the central directory in-process. Answers `unreadable` when yauzl
   * could not read a single record — a split archive, a malformed or
   * truncated directory — so the caller can hand the file to 7z, which is
   * more forgiving (and recovers what it can from the local headers).
   */
  async function scanZip(
    archiveReal: string,
    sizeBytes: number,
    fileName: string,
    collector: ListingCollector,
    deadline: number,
  ): Promise<{ outcome: ScanOutcome } | { unreadable: string }> {
    let handle: FileHandle;
    try {
      handle = await open(archiveReal, "r");
    } catch (error) {
      throw mapNodeError(error, archiveReal);
    }
    let zipfile: ZipFile;
    try {
      const tailBytes = Math.min(sizeBytes, ZIP_TAIL_BYTES);
      const tail = Buffer.alloc(tailBytes);
      await handle.read(tail, 0, tailBytes, sizeBytes - tailBytes);
      const prefix = zipPrefixLength(tail, sizeBytes - tailBytes);
      // From here the reader owns the handle: yauzl closes it with the zip.
      zipfile = await fromRandomAccessReaderPromise(
        new WindowedReader(handle, prefix),
        sizeBytes - prefix,
        {
          // Raw bytes: the name's charset is decided in archive-parse.ts, and
          // yauzl's own name validation would refuse the very `../` members
          // a listing exists to show (they are displayed, never acted on).
          decodeStrings: false,
          // Sizes are checked when data is *read*; a listing never reads any.
          validateEntrySizes: false,
          autoClose: true,
        },
      );
    } catch (error) {
      // A failed open never reaches yauzl's close, so the handle is ours.
      await handle.close().catch(() => undefined);
      return { unreadable: error instanceof Error ? error.message : String(error) };
    }
    // Belt and braces: an 'error' with nobody listening would take the whole
    // plugin process down, and the iterator detaches its own listener early.
    zipfile.on("error", () => undefined);

    try {
      for await (const entry of zipfile.eachEntry()) {
        if (disposed) throw shuttingDown(fileName);
        if (Date.now() >= deadline) return { outcome: { stoppedBy: "time", problem: null } };
        if (!collector.add(zipEntryFrom(entry))) {
          return { outcome: { stoppedBy: "entries", problem: null } };
        }
      }
      return { outcome: { stoppedBy: null, problem: null } };
    } catch (error) {
      if (isFileManagerError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (collector.scannedCount === 0) return { unreadable: message };
      return { outcome: { stoppedBy: "damaged", problem: message } };
    } finally {
      zipfile.close();
    }
  }

  /* ---------------------------------------------------------------- */
  /* listArchive                                                       */
  /* ---------------------------------------------------------------- */

  async function listArchive(input: { path: string }): Promise<ArchiveListing> {
    // §6 exactly as every other read: realpath first, then the prefix test.
    const archiveReal = await resolveExisting(input.path);
    let stats: Stats;
    try {
      stats = await stat(archiveReal);
    } catch (error) {
      throw mapNodeError(error, archiveReal);
    }
    if (!stats.isFile()) throw fmError("not_a_file", archiveReal);

    const fileName = path.basename(archiveReal);
    const format = detectArchiveFormat(fileName);
    if (format === null) throw fmError("unsupported_archive", fileName);

    const collector = new ListingCollector(limits);
    const deadline = Date.now() + limits.timeoutMs;
    let outcome: ScanOutcome;

    if (format === "zip") {
      const zip = await scanZip(archiveReal, stats.size, fileName, collector, deadline);
      if ("outcome" in zip) {
        outcome = zip.outcome;
      } else if (executables.sevenZip !== null) {
        bb.log.info(`list ${fileName}: yauzl could not read it (${zip.unreadable}); trying 7z`);
        outcome = await scanSevenZip(executables.sevenZip, archiveReal, fileName, collector, deadline);
      } else {
        throw fmError("archive_failed", `${fileName}: not a readable zip archive (${zip.unreadable})`);
      }
    } else if (format === "7z" || format === "rar") {
      if (executables.sevenZip === null) {
        throw fmError("unsupported_archive", `${fileName} (7z is not installed on this host)`);
      }
      outcome = await scanSevenZip(executables.sevenZip, archiveReal, fileName, collector, deadline);
    } else {
      if (executables.tar === null) {
        throw fmError("unsupported_archive", `${fileName} (tar is not installed on this host)`);
      }
      outcome = await scanTar(executables.tar, archiveReal, fileName, collector, deadline);
    }

    if (outcome.stoppedBy !== null && outcome.stoppedBy !== "entries") {
      bb.log.info(
        `list ${fileName}: stopped (${outcome.stoppedBy}) after ${String(collector.scannedCount)} members`,
      );
    }

    return {
      path: archiveReal,
      format,
      archiveSizeBytes: stats.size,
      ...collector.finish(outcome.stoppedBy, outcome.problem),
      extractable: options.canExtract(format),
    };
  }

  // A reload must not orphan a `tar` still decompressing a 20 GB archive.
  // Hooks run LIFO; nothing here needs anything another hook tears down.
  bb.onDispose(() => {
    disposed = true;
    const running = [...live.values()];
    for (const stop of running) stop();
    if (running.length > 0) {
      bb.log.info(`archive listing disposed — stopped ${String(running.length)} lister(s)`);
    }
  });

  return { listArchive };
}
