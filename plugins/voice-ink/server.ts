// voice-ink — local speech recognition for bb's chat composer.
//
// bb routes voice transcription to whichever plugin registers an AI service of
// kind "voice" and is named by BB_TRANSCRIPTION. This plugin registers one and
// answers it from a Whisper model running on the machine bb runs on: no
// account, no API key, no audio leaving the box.
//
// The heavy lifting happens in the `bb.host` entry (src/host.ts), which keeps a
// Python worker with the model resident in memory. This file owns settings, the
// CLI, and the RPC the composer button calls.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  HISTORY_AUDIO_ROUTE,
  rpcContract,
  voiceHostContract,
  type EngineConfig,
  type EngineStatus,
  type TranscriptionResult,
} from "./contract.js";

export { rpcContract };
export type { EngineStatus, TranscriptionResult };

/** Must match VOICE_INK_SERVICE_ID in src/host.ts: it is the BB_TRANSCRIPTION prefix. */
const SERVICE_ID = "voice-ink";

/** Cleanup backends the settings offer; the value is validated on the way out. */
const CLEANUP_PROVIDERS = ["off", "groq", "anthropic", "openai-compatible"] as const;
type CleanupProvider = (typeof CLEANUP_PROVIDERS)[number];

function parseCleanupProvider(value: string): CleanupProvider {
  return CLEANUP_PROVIDERS.find((candidate) => candidate === value) ?? "off";
}

/** Models offered in settings, fastest first. Measurements are in the README. */
const MODEL_OPTIONS = ["small", "medium", "large-v3-turbo"] as const;

/** Model names faster-whisper resolves itself; anything else is a local path. */
const MODEL_REPOS: Record<string, string> = {
  "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
};

/**
 * Spend a core budget on recognition passes; threads per pass times passes
 * never exceeds it.
 *
 * Splitting a long recording pays off only once there are cores to spare.
 * Measured inside two cores: as two single-threaded passes a minute takes
 * 10.2s and a short phrase 6.7s, while one two-threaded pass takes 10.6s and
 * 4.7s. Short phrases are what dictation is mostly made of, so below four
 * cores the budget goes into one pass.
 */
function splitCores(cores: number): { threads: number; parallel: number } {
  const budget = Math.max(1, cores);
  const parallel = Math.min(3, Math.max(1, Math.floor(budget / 2)));
  return { threads: Math.max(1, Math.floor(budget / parallel)), parallel };
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloat(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    model: {
      type: "select",
      label: "Model",
      options: [...MODEL_OPTIONS],
      default: "medium",
    },
    language: {
      type: "select",
      label: "Spoken language",
      options: ["auto", "ru", "en"],
      default: "auto",
    },
    vocabulary: {
      type: "string",
      label: "Vocabulary hints",
      experimental_multiline: true,
      default: "",
    },
    computeType: {
      type: "select",
      label: "Precision",
      options: ["int8", "int8_float32", "float32"],
      default: "int8",
    },
    // Whisper shares this machine with bb, the agents and everything else, so
    // the user caps it in the unit they actually care about: cores.
    cpuCores: {
      type: "string",
      label: "CPU cores recognition may use",
      default: "2",
    },
    // Batching shaves about a tenth off long audio but hands the model
    // VAD-split chunks whose opening words the smaller models drop, so it is
    // off unless someone deliberately turns it on.
    batchSize: { type: "string", label: "Batch size", default: "1" },
    pythonPath: { type: "string", label: "Python interpreter", default: "" },
    idleMinutes: {
      type: "string",
      label: "Unload the model after N idle minutes (0 = keep it loaded)",
      default: "0",
    },
    punctuation: {
      type: "boolean",
      label: "Restore punctuation and sentence boundaries (runs on this machine)",
      default: true,
    },
    paragraphPause: {
      type: "string",
      label: "Start a new paragraph after a pause of N seconds",
      default: "1.2",
    },
    // The local pass fixes punctuation but not misheard words. A language model
    // does both — at the cost of a key and of the transcript (never the audio)
    // leaving this machine.
    cleanup: {
      type: "select",
      label: "Clean the transcript up with a language model",
      options: [...CLEANUP_PROVIDERS],
      default: "off",
    },
    cleanupApiKey: { type: "string", label: "Cleanup API key", secret: true },
    cleanupModel: {
      type: "string",
      label: "Cleanup model",
      default: "llama-3.3-70b-versatile",
    },
    cleanupBaseUrl: {
      type: "string",
      label: "Cleanup endpoint (openai-compatible only)",
      default: "",
    },
    cleanupInstruction: {
      type: "string",
      label: "Extra cleanup instruction",
      experimental_multiline: true,
      default: "",
    },
    composerButton: {
      type: "boolean",
      label: "Show this plugin's own microphone button",
      default: false,
    },
    // bb waits ten seconds per attempt and tries twice; a few minutes of
    // speech take longer, so what it does not wait for has to be kept
    // somewhere the user can still reach it.
    history: {
      type: "boolean",
      label: "Keep a history of dictations (audio and transcript)",
      default: true,
    },
    historyLimit: {
      type: "string",
      label: "Keep at most N dictations (0 = no limit)",
      default: "200",
    },
    historyDays: {
      type: "string",
      label: "Delete dictations older than N days (0 = keep them)",
      default: "30",
    },
  });

  async function currentConfig(): Promise<EngineConfig> {
    const values = await settings.get();
    const model = values.model;
    return {
      model: MODEL_REPOS[model] ?? model,
      computeType: values.computeType,
      ...splitCores(parsePositiveInt(values.cpuCores, 2)),
      batchSize: parsePositiveInt(values.batchSize, 4),
      language: values.language === "auto" ? null : values.language,
      vocabulary: values.vocabulary.trim() === "" ? null : values.vocabulary.trim(),
      pythonPath: values.pythonPath.trim() === "" ? null : values.pythonPath.trim(),
      // Loading a model takes longer than bb's ten-second budget for one
      // transcription attempt, so by default it is never unloaded: the first
      // phrase after a quiet hour must not be the one that fails.
      idleUnloadMs: parseNonNegativeInt(values.idleMinutes, 0) * 60_000,
      history: {
        enabled: values.history,
        maxEntries: parseNonNegativeInt(values.historyLimit, 200),
        maxAgeDays: parseNonNegativeInt(values.historyDays, 30),
      },
      punctuate: values.punctuation,
      paragraphPauseSec: parsePositiveFloat(values.paragraphPause, 1.2),
      polish: {
        provider: parseCleanupProvider(values.cleanup),
        apiKey: values.cleanupApiKey?.trim() === "" ? null : (values.cleanupApiKey ?? null),
        model: values.cleanupModel.trim(),
        baseUrl: values.cleanupBaseUrl.trim() === "" ? null : values.cleanupBaseUrl.trim(),
        extraInstruction:
          values.cleanupInstruction.trim() === "" ? null : values.cleanupInstruction.trim(),
      },
    };
  }

  const host = bb.hosts.experimental_client({ contract: voiceHostContract });

  /** The machine the recognition worker runs on: bb's connected host. */
  async function hostId(): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((candidate) => candidate.status === "connected");
    if (connected === undefined) {
      throw new Error("no connected machine to run speech recognition on");
    }
    return connected.id;
  }

  async function applyConfig(warmUp: boolean): Promise<EngineStatus> {
    const id = await hostId();
    const config = await currentConfig();
    const status = await host.call("voice.configure", { config }, { hostId: id });
    if (!warmUp) return status;
    return host.call("voice.status", { warmUp: true }, { hostId: id });
  }

  bb.experimental_aiServices.register({
    id: SERVICE_ID,
    displayName: "Voice Ink (local Whisper)",
    kinds: ["voice"],
  });

  bb.rpc.register(rpcContract, {
    status: async ({ warmUp }) => {
      const id = await hostId();
      await host.call("voice.configure", { config: await currentConfig() }, { hostId: id });
      return host.call("voice.status", { warmUp }, { hostId: id });
    },
    transcribe_segment: async (input) => {
      const id = await hostId();
      return host.call("voice.transcribeSegment", input, { hostId: id });
    },
    history_list: async (input) => {
      const id = await hostId();
      return host.call("voice.history.list", input, { hostId: id });
    },
    history_delete: async (input) => {
      const id = await hostId();
      return host.call("voice.history.delete", input, { hostId: id });
    },
    history_clear: async () => {
      const id = await hostId();
      return host.call("voice.history.clear", {}, { hostId: id });
    },
  });

  // The panel plays audio through an <audio> element, which needs bytes at a
  // URL rather than a base64 string in an RPC reply.
  bb.http.route("GET", HISTORY_AUDIO_ROUTE, async (context) => {
    const id = context.req.query("id");
    if (typeof id !== "string" || id.trim() === "") {
      return new Response(JSON.stringify({ error: "invalid_params" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const found = await host.call("voice.history.audio", { id }, { hostId: await hostId() });
    if (found === null) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const bytes = Buffer.from(found.audioBase64, "base64");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": found.mimeType,
        "content-length": String(bytes.byteLength),
        // Recordings never change once written, so the panel may keep them.
        "cache-control": "private, max-age=86400, immutable",
      },
    });
  });

  // Settings are applied to the host, not read there: a model change retires the
  // resident worker so the next phrase runs on what the user just chose.
  settings.onChange(() => {
    // Warm up as well as reconfigure: a model change retires the worker, and
    // loading the new one takes longer than bb allows for one transcription.
    void applyConfig(true).catch((error: unknown) => {
      bb.log.warn(`could not apply settings to the recognition host: ${String(error)}`);
    });
  });

  // The host worker starts on demand, but the first phrase should not pay for
  // loading the model, so the configuration is pushed as soon as bb is up.
  bb.background.service("configure", {
    async start(signal) {
      try {
        const status = await applyConfig(true);
        bb.log.info(`recognition configured: ${status.state}, model ${status.model ?? "-"}`);
      } catch (error) {
        if (!signal.aborted) {
          bb.log.warn(`could not configure recognition host: ${String(error)}`);
        }
      }
    },
  });

  const usage = [
    "Usage:",
    "  bb voice-ink status [--json]        Show the recognition engine's state",
    "  bb voice-ink warmup [--json]        Load the model now so the first phrase is fast",
    "  bb voice-ink transcribe <file>      Transcribe an audio file with the local model",
    "  bb voice-ink last [--json]          Show the last transcript, even if the caller gave up",
    "  bb voice-ink history [--json] [-n N] List past dictations",
    "  bb voice-ink show <id> [--json]     Show one dictation in full",
    "  bb voice-ink forget <id>|--all      Delete a dictation, or all of them",
    "  bb voice-ink enable                 Print how to make this bb's transcription service",
  ].join("\n");

  bb.cli.register({
    name: "voice-ink",
    summary: "Local speech recognition for the chat composer",
    commands: [
      { name: "status", summary: "Show engine state", usage: "bb voice-ink status [--json]" },
      { name: "warmup", summary: "Load the model now", usage: "bb voice-ink warmup [--json]" },
      {
        name: "transcribe",
        summary: "Transcribe an audio file",
        usage: "bb voice-ink transcribe <file> [--json]",
      },
      {
        name: "last",
        summary: "Show the last transcript this machine produced",
        usage: "bb voice-ink last [--json]",
      },
      {
        name: "history",
        summary: "List past dictations",
        usage: "bb voice-ink history [--json] [-n N]",
      },
      {
        name: "show",
        summary: "Show one dictation in full",
        usage: "bb voice-ink show <id> [--json]",
      },
      {
        name: "forget",
        summary: "Delete a dictation, or all of them",
        usage: "bb voice-ink forget <id>|--all",
      },
      {
        name: "enable",
        summary: "Print the command that points bb's microphone at this plugin",
        usage: "bb voice-ink enable",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "status":
        case "warmup": {
          const status = await applyConfig(command === "warmup");
          const lines = [
            `state:  ${status.state}`,
            `model:  ${status.model ?? "-"}`,
            `python: ${status.pythonPath ?? "not resolved yet"}`,
          ];
          if (status.message !== null) lines.push(`note:   ${status.message}`);
          return reply(status, lines.join("\n"));
        }

        case "transcribe": {
          const file = args[0];
          if (file === undefined) break;
          const audio = await readFile(file);
          const id = await hostId();
          const started = Date.now();
          const result = await host.call(
            "voice.transcribeSegment",
            {
              audioBase64: audio.toString("base64"),
              mimeType: `audio/${basename(file).split(".").pop() ?? "wav"}`,
              language: null,
            },
            { hostId: id },
          );
          if (!result.ok) {
            return { exitCode: 1, stderr: `${result.code}: ${result.message}` };
          }
          const wall = ((Date.now() - started) / 1000).toFixed(1);
          return reply(
            result,
            `${result.text}\n\n(${result.audioSec}s of audio in ${result.elapsedSec}s, ${wall}s wall)`,
          );
        }

        case "last": {
          const id = await hostId();
          const { text } = await host.call("voice.last", {}, { hostId: id });
          if (text === null) {
            return { exitCode: 1, stderr: "Nothing has been transcribed yet." };
          }
          return reply({ text }, text);
        }

        case "history": {
          const index = args.findIndex((arg) => arg === "-n" || arg === "--limit");
          const limit = index === -1 ? 20 : parsePositiveInt(args[index + 1] ?? "", 20);
          const queryArgs = args.filter(
            (arg, position) => position !== index && position !== index + 1,
          );
          const id = await hostId();
          const listed = await host.call(
            "voice.history.list",
            { query: queryArgs.join(" "), limit: Math.min(limit, 200), offset: 0 },
            { hostId: id },
          );
          if (listed.entries.length === 0) {
            return reply(listed, "No dictations recorded yet.");
          }
          const lines = listed.entries.map((entry) => {
            const when = new Date(entry.createdAt).toLocaleString();
            const seconds = entry.durationSec === null ? "" : ` ${entry.durationSec.toFixed(0)}s`;
            const cut =
              entry.deliveredChars !== null && entry.deliveredChars < entry.text.length
                ? " [partially delivered]"
                : "";
            const preview = entry.text.replace(/\s+/g, " ").slice(0, 80);
            return `${entry.id.slice(0, 8)}  ${when}${seconds}${cut}  ${preview}`;
          });
          return reply(listed, [...lines, "", `${listed.total} in total`].join("\n"));
        }

        case "show": {
          const wanted = args[0];
          if (wanted === undefined) break;
          const id = await hostId();
          // Ids are long; the list prints a short prefix, so accept one here.
          const listed = await host.call(
            "voice.history.list",
            { query: "", limit: 200, offset: 0 },
            { hostId: id },
          );
          const entry = listed.entries.find((candidate) => candidate.id.startsWith(wanted));
          if (entry === undefined) {
            return { exitCode: 1, stderr: `No dictation starts with "${wanted}".` };
          }
          return reply(entry, entry.text);
        }

        case "forget": {
          const id = await hostId();
          if (args.includes("--all")) {
            const { removed } = await host.call("voice.history.clear", {}, { hostId: id });
            return reply({ removed }, `Deleted ${removed} dictation(s).`);
          }
          const wanted = args[0];
          if (wanted === undefined) break;
          const listed = await host.call(
            "voice.history.list",
            { query: "", limit: 200, offset: 0 },
            { hostId: id },
          );
          const entry = listed.entries.find((candidate) => candidate.id.startsWith(wanted));
          if (entry === undefined) {
            return { exitCode: 1, stderr: `No dictation starts with "${wanted}".` };
          }
          const { removed } = await host.call(
            "voice.history.delete",
            { id: entry.id },
            { hostId: id },
          );
          return reply({ removed }, removed ? "Deleted." : "Nothing to delete.");
        }

        case "enable":
          return reply(
            { service: SERVICE_ID },
            [
              "Point bb's built-in microphone at this plugin:",
              "",
              `  npx bb-app config set BB_TRANSCRIPTION ${SERVICE_ID}/local`,
              "",
              "The model comes from this plugin's settings; the part after the",
              "slash is only a label.",
            ].join("\n"),
          );
      }

      return { exitCode: 1, stderr: usage };
    },
  });
}
