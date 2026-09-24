// Every dictation this machine heard, kept on disk: the audio and the
// transcript that came out of it.
//
// It exists because bb gives a transcription ten seconds per attempt and two
// attempts, while a few minutes of speech take longer than that. What bb does
// not wait for used to live in a variable and die with the worker. Now the
// audio is written before recognition starts and the transcript is filled in
// when it finishes — whoever was waiting, and whether or not they gave up.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryEntry, HistoryPolicy } from "../contract.js";

/** Index format on disk; bumped only if old files must be read differently. */
const INDEX_VERSION = 1;

interface IndexFile {
  version: number;
  entries: HistoryEntry[];
}

/**
 * A recognition that has been "running" for longer than this is not running:
 * the worker died with it. Longer than the engine's own hard limit, so honest
 * long work is never mislabelled.
 */
const ABANDONED_AFTER_MS = 20 * 60_000;

/**
 * A retry from bb arrives with the same audio as the attempt before it, so
 * entries are keyed by an audio digest for this long: within the window the
 * second attempt updates the first attempt's entry instead of adding a twin.
 */
const SAME_AUDIO_WINDOW_MS = 30 * 60_000;

export interface HistoryListResult {
  entries: HistoryEntry[];
  total: number;
}

function extensionFor(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes("webm")) return ".webm";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("mp4") || type.includes("m4a")) return ".m4a";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("wav")) return ".wav";
  return ".bin";
}

export class TranscriptHistory {
  private readonly dir: string;
  private entries: HistoryEntry[] | null = null;
  /** Writes are serialized: two recognitions can finish at the same moment. */
  private writing: Promise<void> = Promise.resolve();
  private policy: HistoryPolicy = { enabled: true, maxEntries: 200, maxAgeDays: 30 };

  constructor(dataDir: string) {
    this.dir = join(dataDir, "history");
  }

  setPolicy(policy: HistoryPolicy): void {
    this.policy = policy;
    if (!policy.enabled) return;
    void this.mutate((entries) => this.pruned(entries)).catch(() => {});
  }

  currentPolicy(): HistoryPolicy {
    return this.policy;
  }

  /**
   * Take the audio in before recognition starts: a crash, a restart or a
   * caller that walks away all leave the recording itself recoverable.
   *
   * Returns the id of the entry to fill in later, or null when history is off.
   */
  async begin(args: {
    audio: Buffer;
    mimeType: string;
    model: string;
    source: HistoryEntry["source"];
  }): Promise<string | null> {
    if (!this.policy.enabled) return null;
    const digest = createHash("sha256").update(args.audio).digest("hex");
    const existing = (await this.load()).find(
      (entry) =>
        entry.audioDigest === digest && Date.now() - entry.createdAt < SAME_AUDIO_WINDOW_MS,
    );
    if (existing !== undefined) return existing.id;

    const id = randomUUID();
    const audioFile = `${id}${extensionFor(args.mimeType)}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, audioFile), args.audio);
    const entry: HistoryEntry = {
      id,
      createdAt: Date.now(),
      status: "running",
      text: "",
      model: args.model,
      source: args.source,
      durationSec: null,
      elapsedSec: null,
      deliveredChars: null,
      audioFile,
      audioBytes: args.audio.byteLength,
      mimeType: args.mimeType,
      audioDigest: digest,
      error: null,
    };
    await this.mutate((entries) => this.pruned([entry, ...entries]));
    return id;
  }

  /** Recognition finished: store the transcript people will actually read. */
  async complete(
    id: string | null,
    fields: { text: string; durationSec: number; elapsedSec: number },
  ): Promise<void> {
    if (id === null) return;
    await this.patch(id, (entry) => ({
      ...entry,
      status: "done",
      text: fields.text,
      durationSec: fields.durationSec,
      elapsedSec: fields.elapsedSec,
      error: null,
    }));
  }

  async fail(id: string | null, message: string): Promise<void> {
    if (id === null) return;
    await this.patch(id, (entry) =>
      // A failure after a successful pass (bb retrying a finished job) must not
      // overwrite the transcript that pass produced.
      entry.status === "done" ? entry : { ...entry, status: "failed", error: message },
    );
  }

  /**
   * Record how much of the transcript the caller actually received. A number
   * shorter than the final text is the mark of a dictation bb stopped waiting
   * for — the panel shows those, since their text is here and nowhere else.
   */
  async markDelivered(id: string | null, chars: number): Promise<void> {
    if (id === null) return;
    await this.patch(id, (entry) => ({
      ...entry,
      deliveredChars: Math.max(entry.deliveredChars ?? 0, chars),
    }));
  }

  async list(args: { query: string; limit: number; offset: number }): Promise<HistoryListResult> {
    const all = await this.load();
    const needle = args.query.trim().toLocaleLowerCase();
    const matched =
      needle === ""
        ? all
        : all.filter((entry) => entry.text.toLocaleLowerCase().includes(needle));
    return {
      entries: matched.slice(args.offset, args.offset + args.limit),
      total: matched.length,
    };
  }

  async get(id: string): Promise<HistoryEntry | null> {
    return (await this.load()).find((entry) => entry.id === id) ?? null;
  }

  /** The most recent transcript with text in it, whatever became of its caller. */
  async latestText(): Promise<string | null> {
    const found = (await this.load()).find((entry) => entry.text.trim() !== "");
    return found?.text ?? null;
  }

  async readAudio(id: string): Promise<{ mimeType: string; bytes: Buffer } | null> {
    const entry = await this.get(id);
    if (entry === null || entry.audioFile === null) return null;
    try {
      return { mimeType: entry.mimeType, bytes: await readFile(join(this.dir, entry.audioFile)) };
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.mutate((entries) =>
      entries.filter((entry) => {
        if (entry.id !== id) return true;
        removed = true;
        this.discardAudio(entry);
        return false;
      }),
    );
    return removed;
  }

  async clear(): Promise<number> {
    let removed = 0;
    await this.mutate((entries) => {
      removed = entries.length;
      for (const entry of entries) this.discardAudio(entry);
      return [];
    });
    return removed;
  }

  // --- internals ---------------------------------------------------------

  private async patch(id: string, update: (entry: HistoryEntry) => HistoryEntry): Promise<void> {
    await this.mutate((entries) =>
      entries.map((entry) => (entry.id === id ? update(entry) : entry)),
    );
  }

  /** Newest first, and never more than the policy allows. */
  private pruned(entries: HistoryEntry[]): HistoryEntry[] {
    const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);
    const oldest = Date.now() - this.policy.maxAgeDays * 24 * 60 * 60_000;
    const kept: HistoryEntry[] = [];
    for (const entry of sorted) {
      const tooOld = this.policy.maxAgeDays > 0 && entry.createdAt < oldest;
      const tooMany = this.policy.maxEntries > 0 && kept.length >= this.policy.maxEntries;
      if (tooOld || tooMany) {
        this.discardAudio(entry);
        continue;
      }
      kept.push(entry);
    }
    return kept;
  }

  private discardAudio(entry: HistoryEntry): void {
    if (entry.audioFile === null) return;
    void rm(join(this.dir, entry.audioFile), { force: true }).catch(() => {});
  }

  private async load(): Promise<HistoryEntry[]> {
    if (this.entries !== null) return this.entries;
    try {
      const raw = await readFile(join(this.dir, "index.json"), "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      this.entries = Array.isArray(parsed.entries)
        ? parsed.entries.map((entry) =>
            // Nothing survives a killed worker mid-recognition, so an entry
            // that outlived one says so instead of spinning for ever.
            entry.status === "running" && Date.now() - entry.createdAt > ABANDONED_AFTER_MS
              ? {
                  ...entry,
                  status: "failed" as const,
                  error: "recognition was interrupted; the recording is still here",
                }
              : entry,
          )
        : [];
    } catch {
      // A missing or unreadable index is an empty history, not an error: the
      // dictation that is running right now matters more than what was lost.
      this.entries = [];
    }
    return this.entries;
  }

  private async mutate(update: (entries: HistoryEntry[]) => HistoryEntry[]): Promise<void> {
    const step = this.writing.then(async () => {
      const next = update(await this.load());
      this.entries = next;
      await mkdir(this.dir, { recursive: true });
      const body: IndexFile = { version: INDEX_VERSION, entries: next };
      // Written beside the index and renamed over it: a half-written index
      // would cost every past transcript, not just the one being saved.
      const scratch = join(this.dir, `index.json.${randomUUID()}`);
      await writeFile(scratch, JSON.stringify(body), "utf8");
      await rename(scratch, join(this.dir, "index.json"));
    });
    this.writing = step.catch(() => {});
    await step;
  }
}
