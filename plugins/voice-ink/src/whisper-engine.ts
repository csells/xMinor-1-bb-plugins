// The speech-recognition engine as seen from Node: one long-lived Python
// process holding the model in memory, and a request queue on top of its
// stdin/stdout.
//
// Loading a Whisper model costs seconds and transcribing a phrase costs less
// than that, so the process is kept alive between phrases and only retired
// after an idle period or a configuration change.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { EngineConfig, EngineStatus, TranscriptionResult } from "../contract.js";

/** Error codes bb's AI-service contract understands; `code` travels as-is. */
type FailureCode =
  | "timeout"
  | "rate_limited"
  | "service_unavailable"
  | "auth_required"
  | "request_failed"
  | "invalid_response";

interface PendingRequest {
  resolve(result: TranscriptionResult): void;
  timer: ReturnType<typeof setTimeout>;
  onPartial(text: string): void;
}

/** One recognition, shared by every caller that arrives with the same audio. */
interface TranscriptionJob {
  work: Promise<TranscriptionResult>;
  startedAt: number;
  finishedAt: number | null;
  /** What has been recognized so far; handed over when the budget runs out. */
  partial: string | null;
}

interface WorkerLease {
  dispose(): Promise<void>;
}

export interface WhisperEngineOptions {
  /** Directory that survives worker restarts: the venv and model cache live here. */
  dataDir: string;
  /** Scratch space for the audio of one request. */
  tempDir: string;
  /** Path to worker.py inside the installed plugin. */
  workerScript: string;
  log(message: string, fields?: Record<string, unknown>): void;
  /** Keeps the host worker (and with it this process) alive while recognition is warm. */
  retainWorker(): WorkerLease;
}

const READY_TIMEOUT_MS = 600_000;
const STDERR_TAIL_LINES = 8;
/**
 * bb gives a transcription ten seconds per attempt and retries once. A minute
 * of speech takes longer than that, so finished and in-flight work is kept
 * under a key derived from the audio: the retry finds the job already running
 * and waits for it instead of throwing the first attempt's work away.
 */
const JOB_RETENTION_MS = 10 * 60_000;
/** Recognition is never left running longer than this, whatever callers do. */
const HARD_LIMIT_MS = 15 * 60_000;

function failure(code: FailureCode, message: string): TranscriptionResult {
  return { ok: false, code, message };
}

/**
 * Interpreters to try, best first: an explicit setting, the plugin's own venv,
 * then whatever `python3` resolves to. The first one that can import
 * faster-whisper wins.
 */
function pythonCandidates(config: EngineConfig, dataDir: string): string[] {
  const candidates = [
    config.pythonPath,
    join(dataDir, "venv", "bin", "python3"),
    "python3",
    "python",
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function canImportFasterWhisper(python: string): boolean {
  try {
    const probe = spawnSync(python, ["-c", "import faster_whisper"], {
      timeout: 60_000,
      stdio: "ignore",
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

export class WhisperEngine {
  private config: EngineConfig | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lease: WorkerLease | null = null;
  private starting: Promise<EngineStatus> | null = null;
  private state: EngineStatus["state"] = "idle";
  private message: string | null = null;
  private resolvedPython: string | null = null;
  private stdoutBuffer = "";
  private stderrTail: string[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  /** Mirrors the configured policy; 0 keeps the model loaded for good. */
  private idleUnloadMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly jobs = new Map<string, TranscriptionJob>();
  private lastText: string | null = null;

  constructor(private readonly options: WhisperEngineOptions) {}

  /** The configuration in force, or null before the first `configure`. */
  currentConfig(): EngineConfig | null {
    return this.config;
  }

  status(): EngineStatus {
    return {
      state: this.state,
      model: this.config?.model ?? null,
      pythonPath: this.resolvedPython,
      message: this.message,
    };
  }

  /**
   * Apply a configuration. A change of model or interpreter retires the running
   * process; the next request starts a fresh one.
   */
  async configure(config: EngineConfig): Promise<EngineStatus> {
    const previous = this.config;
    this.config = config;
    this.idleUnloadMs = config.idleUnloadMs;
    const restartNeeded =
      previous !== null &&
      (previous.model !== config.model ||
        previous.computeType !== config.computeType ||
        previous.threads !== config.threads ||
        previous.batchSize !== config.batchSize ||
        previous.pythonPath !== config.pythonPath ||
        // The punctuation model is loaded at startup, so switching it needs a
        // fresh process.
        previous.punctuate !== config.punctuate ||
        previous.parallel !== config.parallel);
    if (restartNeeded) {
      await this.stop("configuration changed");
    }
    return this.status();
  }

  async warmUp(): Promise<EngineStatus> {
    if (this.config === null) {
      return { state: "idle", model: null, pythonPath: null, message: "not configured yet" };
    }
    try {
      await this.ensureStarted(this.config);
    } catch (error) {
      this.state = "failed";
      this.message = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }

  /** The last transcript this worker produced, whatever became of its caller. */
  lastTranscript(): string | null {
    return this.lastText;
  }

  /**
   * Transcribe one audio payload. Never throws: failures come back as results.
   *
   * `timeoutMs` bounds the wait, not the work. A caller that gives up leaves
   * the recognition running, and the next caller arriving with the same audio
   * joins it instead of starting over — which is what turns bb's retry into a
   * second chance rather than a second full attempt.
   */
  async transcribe(args: {
    audioBase64: string;
    mimeType: string;
    language: string | null;
    prompt: string | null;
    timeoutMs: number;
    /**
     * Called once with the finished result, however long that takes and
     * whoever is still waiting — this is what lets a dictation bb gave up on
     * still reach the history.
     */
    onSettled?: (result: TranscriptionResult) => void;
  }): Promise<TranscriptionResult> {
    const config = this.config;
    if (config === null) {
      return failure("service_unavailable", "voice-ink is not configured yet");
    }
    if (args.audioBase64.length === 0) {
      return failure("request_failed", "audio is empty");
    }

    const key = createHash("sha256")
      .update(args.audioBase64)
      .update(`|${args.language ?? config.language ?? ""}`)
      .digest("hex");

    this.forgetStaleJobs();
    let job = this.jobs.get(key);
    if (job === undefined) {
      const created: TranscriptionJob = {
        work: null as unknown as Promise<TranscriptionResult>,
        startedAt: Date.now(),
        finishedAt: null,
        partial: null,
      };
      created.work = this.runTranscription(args, config, (text) => {
        created.partial = text;
      });
      this.jobs.set(key, created);
      void created.work.then(
        (result) => {
          created.finishedAt = Date.now();
          if (result.ok && result.text.trim() !== "") this.lastText = result.text;
          args.onSettled?.(result);
        },
        (error: unknown) => {
          created.finishedAt = Date.now();
          args.onSettled?.(
            failure("service_unavailable", error instanceof Error ? error.message : String(error)),
          );
        },
      );
      job = created;
    }

    const running = job;
    const waitedMs = Date.now() - running.startedAt;
    const budgetMs = Math.max(1_000, args.timeoutMs);
    return Promise.race([
      running.work,
      new Promise<TranscriptionResult>((resolve) => {
        const timer = setTimeout(() => {
          // First caller: report a timeout so bb retries and picks the finished
          // work up. A caller that already waited through one attempt gets what
          // has been recognized so far — a long dictation should not be lost
          // because the last sentence was still running.
          const partial = running.partial;
          if (waitedMs > 1_000 && partial !== null && partial.trim() !== "") {
            resolve({
              ok: true,
              text: partial.trim(),
              audioSec: 0,
              elapsedSec: 0,
              partial: true,
            });
            return;
          }
          resolve(
            failure(
              "timeout",
              `still transcribing after ${Math.round((waitedMs + budgetMs) / 1000)}s`,
            ),
          );
        }, budgetMs);
        timer.unref?.();
        void running.work.finally(() => clearTimeout(timer));
      }),
    ]);
  }

  /** Everything one recognition does, from a started worker to a deleted temp file. */
  private async runTranscription(
    args: {
      audioBase64: string;
      mimeType: string;
      language: string | null;
      prompt: string | null;
    },
    config: EngineConfig,
    onPartial: (text: string) => void,
  ): Promise<TranscriptionResult> {
    let audio: Buffer;
    try {
      audio = Buffer.from(args.audioBase64, "base64");
    } catch {
      return failure("request_failed", "audio is not valid base64");
    }
    if (audio.byteLength === 0) {
      return failure("request_failed", "audio is empty");
    }

    try {
      await this.ensureStarted(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = "failed";
      this.message = message;
      return failure(
        message.includes("faster-whisper is not installed") ||
          message.includes("no Python interpreter")
          ? "auth_required"
          : "service_unavailable",
        message,
      );
    }

    const audioPath = join(
      this.options.tempDir,
      `segment-${randomUUID()}${extensionFor(args.mimeType)}`,
    );
    try {
      await mkdir(this.options.tempDir, { recursive: true });
      await writeFile(audioPath, audio);
      return await this.request(
        {
          op: "transcribe",
          path: audioPath,
          language: args.language ?? config.language,
          prompt: args.prompt ?? config.vocabulary,
          paragraphPauseSec: config.paragraphPauseSec,
        },
        HARD_LIMIT_MS,
        onPartial,
      );
    } catch (error) {
      return failure(
        "service_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      // Only now: the worker reads this file for as long as the job runs, and
      // the job outlives the caller that started it.
      void rm(audioPath, { force: true }).catch(() => {});
    }
  }

  private forgetStaleJobs(): void {
    const now = Date.now();
    for (const [key, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > JOB_RETENTION_MS) {
        this.jobs.delete(key);
      }
    }
  }

  async dispose(): Promise<void> {
    await this.stop("host worker shutting down");
  }

  // --- process lifecycle -------------------------------------------------

  private ensureStarted(config: EngineConfig): Promise<EngineStatus> {
    if (this.child !== null && this.state === "ready") {
      return Promise.resolve(this.status());
    }
    if (this.starting !== null) return this.starting;

    const startup = this.start(config).finally(() => {
      this.starting = null;
    });
    this.starting = startup;
    return startup;
  }

  private async start(config: EngineConfig): Promise<EngineStatus> {
    const python = this.resolvePython(config);
    this.state = "loading";
    this.message = null;

    await mkdir(join(this.options.dataDir, "models"), { recursive: true });
    const child = spawn(
      python,
      [
        this.options.workerScript,
        "--model",
        config.model,
        "--compute-type",
        config.computeType,
        "--threads",
        String(config.threads),
        "--batch-size",
        String(config.batchSize),
        "--download-root",
        join(this.options.dataDir, "models"),
        "--punctuate",
        config.punctuate ? "on" : "off",
        "--parallel",
        String(config.parallel),
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } },
    ) as ChildProcessWithoutNullStreams;

    this.child = child;
    // Recognition is background work by nature: when the machine is busy, the
    // agents and the bb server should get the cores first.
    try {
      if (child.pid !== undefined) os.setPriority(child.pid, 10);
    } catch {
      // Priorities are advisory; failing to lower one changes nothing else.
    }
    this.lease = this.options.retainWorker();
    this.stdoutBuffer = "";
    this.stderrTail = [];

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        this.stderrTail.push(line.trim());
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });

    const ready = new Promise<void>((resolve, reject) => {
      const readyTimer = setTimeout(() => {
        reject(new Error(`model did not load within ${Math.round(READY_TIMEOUT_MS / 1000)}s`));
      }, READY_TIMEOUT_MS);
      readyTimer.unref?.();

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.stdoutBuffer += chunk;
        let newline = this.stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          newline = this.stdoutBuffer.indexOf("\n");
          if (line === "") continue;
          const outcome = this.handleLine(line);
          if (outcome === "ready") {
            clearTimeout(readyTimer);
            resolve();
          } else if (outcome !== null) {
            clearTimeout(readyTimer);
            reject(new Error(outcome));
          }
        }
      });

      child.on("error", (error: Error) => {
        clearTimeout(readyTimer);
        reject(new Error(`could not start ${python}: ${error.message}`));
      });
      child.on("exit", (code: number | null) => {
        clearTimeout(readyTimer);
        const detail = this.stderrTail.join(" | ");
        const reason = `worker exited (code ${code ?? "null"})${detail === "" ? "" : `: ${detail}`}`;
        this.onProcessGone(reason);
        reject(new Error(reason));
      });
    });

    try {
      await ready;
    } catch (error) {
      await this.stop("startup failed");
      throw error;
    }

    this.state = "ready";
    this.resolvedPython = python;
    this.options.log("recognition worker ready", { model: config.model, python });
    this.scheduleIdleUnload();
    return this.status();
  }

  private resolvePython(config: EngineConfig): string {
    if (this.resolvedPython !== null && canImportFasterWhisper(this.resolvedPython)) {
      return this.resolvedPython;
    }
    for (const candidate of pythonCandidates(config, this.options.dataDir)) {
      if (candidate.includes("/") && !existsSync(candidate)) continue;
      if (canImportFasterWhisper(candidate)) return candidate;
    }
    throw new Error(
      "faster-whisper is not installed: run `bb voice-ink setup` to create the plugin's Python environment",
    );
  }

  /** Returns "ready" for the ready line, an error message for a fatal one, null otherwise. */
  private handleLine(line: string): "ready" | string | null {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.options.log("ignoring non-JSON worker output", { line });
      return null;
    }

    if (payload.event === "ready") return "ready";
    if (payload.event === "note") {
      // Something optional is missing (the punctuation model, usually);
      // recognition still works, so this is a log line, not a failure.
      this.options.log(
        typeof payload.message === "string" ? payload.message : "worker note",
      );
      return null;
    }
    if (payload.event === "error") {
      return typeof payload.message === "string" ? payload.message : "worker failed to start";
    }

    const id = typeof payload.id === "string" ? payload.id : null;
    if (id === null) return null;
    const waiting = this.pending.get(id);
    if (waiting === undefined) return null;

    if (payload.event === "partial") {
      if (typeof payload.text === "string") waiting.onPartial(payload.text);
      return null;
    }

    this.pending.delete(id);
    clearTimeout(waiting.timer);

    if (payload.ok === true) {
      waiting.resolve({
        ok: true,
        text: typeof payload.text === "string" ? payload.text : "",
        audioSec: typeof payload.audioSec === "number" ? payload.audioSec : 0,
        elapsedSec: typeof payload.elapsedSec === "number" ? payload.elapsedSec : 0,
      });
    } else {
      waiting.resolve(
        failure(
          isFailureCode(payload.code) ? payload.code : "service_unavailable",
          typeof payload.message === "string" ? payload.message : "transcription failed",
        ),
      );
    }
    return null;
  }

  private request(
    body: Record<string, unknown>,
    timeoutMs: number,
    onPartial: (text: string) => void = () => {},
  ): Promise<TranscriptionResult> {
    const child = this.child;
    if (child === null) {
      return Promise.resolve(failure("service_unavailable", "recognition worker is not running"));
    }
    const id = randomUUID();
    this.clearIdleUnload();

    return new Promise<TranscriptionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.scheduleIdleUnload();
        resolve(failure("timeout", `transcription did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (result) => {
          this.scheduleIdleUnload();
          resolve(result);
        },
        timer,
        onPartial,
      });
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(failure("service_unavailable", `could not reach the worker: ${error.message}`));
      });
    });
  }

  private onProcessGone(reason: string): void {
    this.child = null;
    this.state = this.state === "ready" ? "idle" : this.state;
    this.message = reason;
    this.clearIdleUnload();
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.resolve(failure("service_unavailable", reason));
    }
    this.pending.clear();
    const lease = this.lease;
    this.lease = null;
    void lease?.dispose().catch(() => {});
  }

  private async stop(reason: string): Promise<void> {
    const child = this.child;
    this.onProcessGone(reason);
    if (child === null) return;
    child.stdin.end();
    child.kill("SIGTERM");
    this.state = "idle";
  }

  private scheduleIdleUnload(): void {
    this.clearIdleUnload();
    if (this.idleUnloadMs <= 0 || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.options.log("unloading idle recognition worker");
      void this.stop("idle");
    }, this.idleUnloadMs);
    this.idleTimer.unref?.();
  }

  private clearIdleUnload(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function isFailureCode(value: unknown): value is FailureCode {
  return (
    value === "timeout" ||
    value === "rate_limited" ||
    value === "service_unavailable" ||
    value === "auth_required" ||
    value === "request_failed" ||
    value === "invalid_response"
  );
}

function extensionFor(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes("wav")) return ".wav";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("mp4") || type.includes("m4a")) return ".m4a";
  if (type.includes("mpeg")) return ".mp3";
  return ".webm";
}
