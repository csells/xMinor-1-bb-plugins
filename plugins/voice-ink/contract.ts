// Contracts shared by the three sides of voice-ink: the app (browser), the
// server factory, and the host entry that owns the speech-recognition worker.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** How the worker should be run; the server owns these, the host applies them. */
export const engineConfigSchema = z
  .object({
    /** faster-whisper model name or a local CTranslate2 directory. */
    model: z.string().min(1),
    /** CTranslate2 quantization; int8 is the only one that keeps CPU usable. */
    computeType: z.string().min(1),
    /** Compute threads per recognition pass. */
    threads: z.number().int().positive().max(64),
    batchSize: z.number().int().positive().max(32),
    /** Spoken language, or null to let the model detect it. */
    language: z.string().min(2).max(8).nullable(),
    /** Names and terms fed to the model as context, one line of text. */
    vocabulary: z.string().nullable(),
    /** Interpreter with faster-whisper installed; null means "discover one". */
    pythonPath: z.string().nullable(),
    /** Retire the model after this long without a request; 0 keeps it loaded. */
    idleUnloadMs: z.number().int().nonnegative(),
    /** How many pieces of a long recording are recognized side by side. */
    parallel: z.number().int().positive().max(8),
    /** Restore punctuation, sentence boundaries and capitalization locally. */
    punctuate: z.boolean(),
    /** A pause at least this long starts a new paragraph. */
    paragraphPauseSec: z.number().positive(),
    /** How much dictation history is kept on disk, and whether any is. */
    history: z
      .object({
        enabled: z.boolean(),
        /** Entries above this count are dropped, oldest first; 0 means no cap. */
        maxEntries: z.number().int().nonnegative().max(10_000),
        /** Entries older than this are dropped; 0 means no age limit. */
        maxAgeDays: z.number().int().nonnegative().max(3_650),
      })
      .strict()
      // Defaulted, not required: a config.json written by an older version
      // must keep working, or an update would silently reset the model choice.
      .default({ enabled: true, maxEntries: 200, maxAgeDays: 30 }),
    /** Language model that turns the raw transcript into written text. */
    polish: z
      .object({
        provider: z.enum(["off", "groq", "anthropic", "openai-compatible"]),
        apiKey: z.string().nullable(),
        model: z.string(),
        baseUrl: z.string().nullable(),
        extraInstruction: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type EngineConfig = z.infer<typeof engineConfigSchema>;

const transcriptionResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      text: z.string(),
      audioSec: z.number(),
      elapsedSec: z.number(),
      /** True when this is only what had been recognized when time ran out. */
      partial: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ ok: z.literal(false), code: z.string(), message: z.string() })
    .strict(),
]);
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;

export const engineStatusSchema = z
  .object({
    /** "ready" only once a model is loaded and a request would run now. */
    state: z.enum(["idle", "loading", "ready", "failed"]),
    model: z.string().nullable(),
    pythonPath: z.string().nullable(),
    message: z.string().nullable(),
  })
  .strict();
export type EngineStatus = z.infer<typeof engineStatusSchema>;

/** One dictation as the History panel shows it: the audio and its transcript. */
export const historyEntrySchema = z
  .object({
    id: z.string(),
    /** When the recording arrived, in epoch milliseconds. */
    createdAt: z.number(),
    status: z.enum(["running", "done", "failed"]),
    text: z.string(),
    model: z.string(),
    /** Which button produced it: bb's own microphone, or the plugin's. */
    source: z.enum(["voice", "segment"]),
    durationSec: z.number().nullable(),
    elapsedSec: z.number().nullable(),
    /**
     * How many characters the caller got. Shorter than `text` means bb stopped
     * waiting and only part of this reached the composer.
     */
    deliveredChars: z.number().nullable(),
    audioFile: z.string().nullable(),
    audioBytes: z.number(),
    mimeType: z.string(),
    audioDigest: z.string(),
    error: z.string().nullable(),
  })
  .strict();
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyPolicySchema = z
  .object({
    enabled: z.boolean(),
    maxEntries: z.number().int().nonnegative().max(10_000),
    maxAgeDays: z.number().int().nonnegative().max(3_650),
  })
  .strict();
export type HistoryPolicy = z.infer<typeof historyPolicySchema>;

const historyListInput = z
  .object({
    query: z.string(),
    limit: z.number().int().positive().max(200),
    offset: z.number().int().nonnegative(),
  })
  .strict();

const historyListOutput = z
  .object({ entries: z.array(historyEntrySchema), total: z.number() })
  .strict();

/**
 * The plugin's own host methods. bb's voice-service contract is merged in on
 * the host side only (src/host.ts): its module is bundled into the host
 * artifact and is not resolvable from server code.
 *
 * Segments arrive while the user is still talking, which is what keeps the
 * wait after "stop" down to the last segment.
 */
export const voiceHostContract = defineRpcContract({
  "voice.configure": {
    input: z.object({ config: engineConfigSchema }).strict(),
    output: engineStatusSchema,
  },
  "voice.status": {
    input: z.object({ warmUp: z.boolean() }).strict(),
    output: engineStatusSchema,
  },
  "voice.last": {
    input: z.object({}).strict(),
    output: z.object({ text: z.string().nullable() }).strict(),
  },
  "voice.history.list": { input: historyListInput, output: historyListOutput },
  "voice.history.get": {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ entry: historyEntrySchema.nullable() }).strict(),
  },
  "voice.history.audio": {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({ mimeType: z.string(), audioBase64: z.string() })
      .strict()
      .nullable(),
  },
  "voice.history.delete": {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  "voice.history.clear": {
    input: z.object({}).strict(),
    output: z.object({ removed: z.number() }).strict(),
  },
  "voice.transcribeSegment": {
    input: z
      .object({
        audioBase64: z.string().min(1),
        /** Container hint for the decoder; audio/* or application/octet-stream. */
        mimeType: z.string().min(1),
        /** Overrides the configured language for this segment only. */
        language: z.string().min(2).max(8).nullable(),
      })
      .strict(),
    output: transcriptionResultSchema,
  },
});

/** What the browser side calls; the server relays it to the host. */
export const rpcContract = defineRpcContract({
  status: {
    input: z.object({ warmUp: z.boolean() }).strict(),
    output: engineStatusSchema,
  },
  transcribe_segment: {
    input: z
      .object({
        audioBase64: z.string().min(1),
        mimeType: z.string().min(1),
        language: z.string().min(2).max(8).nullable(),
      })
      .strict(),
    output: transcriptionResultSchema,
  },
  history_list: { input: historyListInput, output: historyListOutput },
  history_delete: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  history_clear: {
    input: z.object({}).strict(),
    output: z.object({ removed: z.number() }).strict(),
  },
});

/** The nav panel's route segment: /plugins/voice-ink/history/<entry id>. */
export const PANEL_PATH = "history";

/** Where the panel fetches audio bytes; the server streams them from the host. */
export const HISTORY_AUDIO_ROUTE = "/history/audio";
export const HISTORY_AUDIO_URL = `/api/v1/plugins/voice-ink/http${HISTORY_AUDIO_ROUTE}`;
