// The `bb.host` entry: it owns the recognition worker on the machine bb runs
// on, and answers both bb's own voice service (the built-in microphone button)
// and the plugin's streaming methods (its own button).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  experimental_aiServicesHostContract,
  type ExperimentalAiInferenceCompleteOutput,
  type ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import {
  engineConfigSchema,
  voiceHostContract,
  type EngineConfig,
  type EngineStatus,
  type HistoryEntry,
  type TranscriptionResult,
} from "../contract.js";
import { TranscriptHistory } from "./history.js";
import { polishTranscript } from "./polish.js";
import { WhisperEngine } from "./whisper-engine.js";
import { WORKER_SOURCE } from "./worker-source.js";

/** The AI service id this plugin registers; every call carries it. */
export const VOICE_INK_SERVICE_ID = "voice-ink";

/** Both contracts are plain method records, so one entry serves them together. */
const hostContract = defineRpcContract({
  ...experimental_aiServicesHostContract,
  ...voiceHostContract,
});

/** A streamed segment is short, but a cold model still has to load first. */
const SEGMENT_TIMEOUT_MS = 600_000;
/**
 * Appended to a transcript bb only got part of. Without it the composer shows
 * a sentence that stops mid-thought and nothing says the rest exists.
 */
const PARTIAL_NOTE = "\n\n[Voice Ink: only part of this dictation fitted bb's wait — full transcript in Voice Ink → History]";
/** Polishing a transcript nobody is waiting for still must not run forever. */
const BACKGROUND_POLISH_MS = 120_000;
/** Leaves the caller room to hear our answer before its own deadline fires. */
const TIMEOUT_GRACE_MS = 500;

/**
 * What to run when nobody has configured anything yet — a worker the daemon
 * restarted answers with these rather than refusing the request.
 */
const DEFAULT_CONFIG: EngineConfig = {
  model: "small",
  computeType: "int8",
  threads: 2,
  batchSize: 1,
  language: null,
  vocabulary: null,
  pythonPath: null,
  idleUnloadMs: 0,
  parallel: 1,
  history: { enabled: true, maxEntries: 200, maxAgeDays: 30 },
  punctuate: true,
  paragraphPauseSec: 1.2,
  polish: {
    provider: "off",
    apiKey: null,
    model: "",
    baseUrl: null,
    extraInstruction: null,
  },
};

interface HostPaths {
  readonly dataDir: string;
  readonly tempDir: string;
}

interface HostContext {
  readonly lifecycle: { readonly signal: AbortSignal };
  readonly experimental_paths: HostPaths;
  experimental_retainWorker(): { dispose(): Promise<void> };
}

let engine: WhisperEngine | null = null;
let preparing: Promise<WhisperEngine> | null = null;
let history: TranscriptHistory | null = null;
/**
 * Worker retention has to be requested from the call that is running now: a
 * lease taken through a finished call's context is rejected, and the engine
 * outlives any single call.
 */
let activeContext: HostContext | null = null;

async function engineFor(context: HostContext): Promise<WhisperEngine> {
  activeContext = context;
  if (engine !== null) return engine;
  if (preparing !== null) return preparing;

  preparing = (async () => {
    const { dataDir, tempDir } = context.experimental_paths;
    await mkdir(dataDir, { recursive: true });
    // Rewritten every time the worker starts, so a plugin update always runs
    // its own Python and never a stale copy from an earlier install.
    const workerScript = join(dataDir, "worker.py");
    await writeFile(workerScript, WORKER_SOURCE, "utf8");

    const created = new WhisperEngine({
      dataDir,
      tempDir,
      workerScript,
      log: (message, fields) => {
        console.log(`[voice-ink] ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
      },
      retainWorker: () => (activeContext ?? context).experimental_retainWorker(),
    });
    context.lifecycle.signal.addEventListener(
      "abort",
      () => {
        void created.dispose();
        engine = null;
      },
      { once: true },
    );
    // The daemon may retire this worker between phrases; the settings live in
    // the server, so they are mirrored here and reread on the way back up.
    const stored = await readStoredConfig(dataDir);
    await created.configure(stored);
    historyFor(context).setPolicy(stored.history);
    engine = created;
    return created;
  })().finally(() => {
    preparing = null;
  });

  return preparing;
}

/** The dictation archive, opened against the same data directory as the engine. */
function historyFor(context: HostContext): TranscriptHistory {
  if (history === null) history = new TranscriptHistory(context.experimental_paths.dataDir);
  return history;
}

/**
 * Cleanup gets whatever is left of the caller's budget after recognition, minus
 * the grace the caller itself needs: an unpolished transcript beats a timeout.
 */
async function polish(
  text: string,
  config: EngineConfig,
  budgetMs: number,
): Promise<string> {
  if (budgetMs < 500) return text;
  return polishTranscript({
    text,
    config: { ...config.polish, vocabulary: config.vocabulary },
    timeoutMs: budgetMs,
    log: (message) => console.log(`[voice-ink] ${message}`),
  });
}

function configPath(dataDir: string): string {
  return join(dataDir, "config.json");
}

async function readStoredConfig(dataDir: string): Promise<EngineConfig> {
  try {
    const parsed = engineConfigSchema.safeParse(
      JSON.parse(await readFile(configPath(dataDir), "utf8")),
    );
    return parsed.success ? parsed.data : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

function serviceMismatch(serviceId: string): { ok: false; code: "request_failed"; message: string } {
  return {
    ok: false,
    code: "request_failed",
    message: `This plugin serves no AI service "${serviceId}".`,
  };
}

type VoiceFailureCode = Extract<ExperimentalAiVoiceTranscribeOutput, { ok: false }>["code"];

const VOICE_FAILURE_CODES: readonly VoiceFailureCode[] = [
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
];

function toVoiceOutput(
  model: string,
  result: TranscriptionResult,
): ExperimentalAiVoiceTranscribeOutput {
  if (result.ok) return { ok: true, model, text: result.text };
  const code = VOICE_FAILURE_CODES.find((candidate) => candidate === result.code);
  return {
    ok: false,
    code: code ?? "service_unavailable",
    message: result.message,
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    "ai.inference.complete": (input): ExperimentalAiInferenceCompleteOutput => ({
      ok: false,
      code: "request_failed",
      message: `voice-ink transcribes speech; it serves no inference for "${input.serviceId}".`,
    }),

    "ai.voice.transcribe": async (input, context): Promise<ExperimentalAiVoiceTranscribeOutput> => {
      if (input.serviceId !== VOICE_INK_SERVICE_ID) return serviceMismatch(input.serviceId);
      const active = await engineFor(context as HostContext);
      const archive = historyFor(context as HostContext);
      const deadline = Date.now() + input.timeoutMs - TIMEOUT_GRACE_MS;

      // The recording is filed before recognition starts, so it survives a
      // caller that walks away, a failed pass and a restarted worker alike.
      const entryId = await archive
        .begin({
          audio: Buffer.from(input.audioBase64, "base64"),
          mimeType: input.mimeType,
          model: active.currentConfig()?.model ?? input.model,
          source: "voice",
        })
        .catch(() => null);

      const result = await active.transcribe({
        audioBase64: input.audioBase64,
        mimeType: input.mimeType,
        language: null,
        prompt: input.prompt,
        timeoutMs: Math.max(1_000, input.timeoutMs - TIMEOUT_GRACE_MS),
        // Runs when recognition finishes, which for a long dictation is well
        // after bb has given up: this is the path the lost text used to take.
        onSettled: (settled) => {
          void (async () => {
            if (!settled.ok) {
              await archive.fail(entryId, settled.message);
              return;
            }
            const config = active.currentConfig();
            const text =
              config === null
                ? settled.text
                : await polish(settled.text, config, BACKGROUND_POLISH_MS);
            await archive.complete(entryId, {
              text,
              durationSec: settled.audioSec,
              elapsedSec: settled.elapsedSec,
            });
          })().catch((error: unknown) => {
            console.log(`[voice-ink] history write failed: ${String(error)}`);
          });
        },
      });
      console.log(
        `[voice-ink] transcribe ${result.ok ? "ok" : result.code}: ` +
          `${result.ok ? `${result.audioSec}s audio in ${result.elapsedSec}s` : result.message}`,
      );
      if (!result.ok) {
        // A timeout is bb giving up, not recognition failing: the job runs on
        // and `onSettled` above files its result. Marking the entry failed here
        // would show "failed" in the panel for work that is still going.
        if (result.code !== "timeout") {
          await archive.fail(entryId, result.message).catch(() => {});
        }
        return toVoiceOutput(input.model, result);
      }
      const config = active.currentConfig();
      const polished =
        config === null ? result.text : await polish(result.text, config, deadline - Date.now());
      await archive.markDelivered(entryId, polished.length).catch(() => {});
      // A partial transcript reads like a finished one, so it says otherwise.
      const text = result.partial === true ? `${polished}${PARTIAL_NOTE}` : polished;
      return { ok: true, model: input.model, text };
    },

    "voice.configure": async ({ config }, context): Promise<EngineStatus> => {
      const active = await engineFor(context as HostContext);
      const status = await active.configure(config);
      historyFor(context as HostContext).setPolicy(config.history);
      await writeFile(
        configPath(context.experimental_paths.dataDir),
        JSON.stringify(config),
        "utf8",
      );
      return status;
    },

    "voice.status": async ({ warmUp }, context): Promise<EngineStatus> => {
      const active = await engineFor(context as HostContext);
      return warmUp ? active.warmUp() : active.status();
    },

    "voice.last": async (_input, context): Promise<{ text: string | null }> => {
      // History first: it survives a restarted worker, the engine's copy does not.
      const stored = await historyFor(context as HostContext).latestText();
      if (stored !== null) return { text: stored };
      const active = await engineFor(context as HostContext);
      return { text: active.lastTranscript() };
    },

    "voice.history.list": async (input, context) =>
      historyFor(context as HostContext).list(input),

    "voice.history.get": async ({ id }, context): Promise<{ entry: HistoryEntry | null }> => ({
      entry: await historyFor(context as HostContext).get(id),
    }),

    "voice.history.audio": async ({ id }, context) => {
      const found = await historyFor(context as HostContext).readAudio(id);
      return found === null
        ? null
        : { mimeType: found.mimeType, audioBase64: found.bytes.toString("base64") };
    },

    "voice.history.delete": async ({ id }, context): Promise<{ removed: boolean }> => ({
      removed: await historyFor(context as HostContext).remove(id),
    }),

    "voice.history.clear": async (_input, context): Promise<{ removed: number }> => ({
      removed: await historyFor(context as HostContext).clear(),
    }),

    "voice.transcribeSegment": async (input, context): Promise<TranscriptionResult> => {
      const active = await engineFor(context as HostContext);
      const result = await active.transcribe({
        audioBase64: input.audioBase64,
        mimeType: input.mimeType,
        language: input.language,
        prompt: null,
        timeoutMs: SEGMENT_TIMEOUT_MS,
      });
      if (!result.ok) return result;
      const config = active.currentConfig();
      return {
        ...result,
        text: config === null ? result.text : await polish(result.text, config, 30_000),
      };
    },
  },
  dispose: async () => {
    await engine?.dispose();
    engine = null;
    history = null;
  },
});
