// History — every dictation this machine heard, newest first.
//
// It is not a convenience list. bb waits ten seconds per transcription attempt
// and tries twice; a few minutes of speech take longer, so the composer gets
// what was ready and the rest only exists here. That is why an entry whose
// text outran the composer is called out, and why the list keeps refreshing
// while something is still being recognized.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { AudioPlayer, formatClock } from "@/components/AudioPlayer";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { HISTORY_AUDIO_URL, type HistoryEntry } from "../contract";
import type { rpcContract } from "../server";

const PAGE_SIZE = 50;
/** While a recognition is still running its text lands here, not in the composer. */
const RUNNING_POLL_MS = 4_000;
const IDLE_POLL_MS = 30_000;

function audioUrl(entry: HistoryEntry): string {
  return `${HISTORY_AUDIO_URL}?id=${encodeURIComponent(entry.id)}`;
}

/** "18 Sep at 12:49" — the date reads as a label, not as a log line. */
function formatWhen(createdAt: number): string {
  const date = new Date(createdAt);
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} at ${time}`;
}

function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when the composer got less text than recognition eventually produced. */
function wasCutShort(entry: HistoryEntry): boolean {
  return (
    entry.status === "done" &&
    entry.deliveredChars !== null &&
    entry.deliveredChars + 1 < entry.text.length
  );
}

function StatusBadge({ entry }: { entry: HistoryEntry }) {
  if (entry.status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-state-hover px-2 py-0.5 text-[11px] text-muted-foreground">
        <Icon aria-hidden className="size-3 animate-spin" name="Loading" />
        transcribing
      </span>
    );
  }
  if (entry.status === "failed") {
    return (
      <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] text-destructive">
        failed
      </span>
    );
  }
  if (wasCutShort(entry)) {
    return (
      <span
        className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary"
        title="bb stopped waiting before recognition finished — the composer only got the beginning of this text."
      >
        only part reached the composer
      </span>
    );
  }
  return null;
}

export function HistoryPanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Arriving from the footer disclosure means one entry was asked for by id;
  // it opens on load rather than making the user find it again.
  const [openId, setOpenId] = useState<string | null>(subPath === "" ? null : subPath);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Refreshes must not fight the user: a reply that started before the latest
  // keystroke is dropped rather than painted over the newer one.
  const requestSeq = useRef(0);

  useEffect(() => {
    if (subPath !== "") setOpenId(subPath);
  }, [subPath]);

  // Typing filters the list, but not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (options: { quiet: boolean }) => {
      const seq = ++requestSeq.current;
      if (!options.quiet) setLoading(true);
      try {
        const result = await rpc.call("history_list", { query: search, limit, offset: 0 });
        if (seq !== requestSeq.current) return;
        setEntries(result.entries);
        setTotal(result.total);
        setError(null);
      } catch (cause: unknown) {
        if (seq !== requestSeq.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [limit, rpc, search],
  );

  useEffect(() => {
    void load({ quiet: false });
  }, [load]);

  // A dictation bb gave up on finishes minutes later; the panel should show it
  // arriving without anyone pressing reload.
  const hasRunning = useMemo(
    () => entries.some((entry) => entry.status === "running"),
    [entries],
  );
  useEffect(() => {
    const period = hasRunning ? RUNNING_POLL_MS : IDLE_POLL_MS;
    const timer = setInterval(() => void load({ quiet: true }), period);
    return () => clearInterval(timer);
  }, [hasRunning, load]);

  const copy = useCallback(async (entry: HistoryEntry) => {
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((current) => (current === entry.id ? null : current)), 1_500);
    } catch {
      toast.error("Could not copy", { description: "The clipboard refused this text." });
    }
  }, []);

  const remove = useCallback(
    async (entry: HistoryEntry) => {
      try {
        await rpc.call("history_delete", { id: entry.id });
        setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
        setTotal((current) => Math.max(0, current - 1));
      } catch (cause: unknown) {
        toast.error("Could not delete", {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [rpc],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative grow">
          <Icon
            aria-hidden
            className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            name="Search"
          />
          <input
            aria-label="Search transcriptions"
            className={cn(
              "h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
            )}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transcriptions..."
            type="search"
            value={query}
          />
        </div>
        <button
          aria-label="Reload"
          className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          onClick={() => void load({ quiet: false })}
          title="Reload"
          type="button"
        >
          <Icon
            aria-hidden
            className={cn("size-4", loading && "animate-spin")}
            name={loading ? "Loading" : "ArrowReloadHorizontal"}
          />
        </button>
      </div>

      <div className="min-h-0 grow overflow-y-auto px-4 py-3">
        {error !== null ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : entries.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Icon aria-hidden className="size-6 text-muted-foreground" name="Mic" />
            <p className="text-sm text-muted-foreground">
              {search.trim() === ""
                ? "Nothing dictated yet. Speech recorded with bb's microphone shows up here, audio and all."
                : `Nothing matches “${search}”.`}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const open = openId === entry.id;
              const preview = previewOf(entry.text);
              return (
                <li
                  className="rounded-lg border border-border bg-card"
                  key={entry.id}
                >
                  <button
                    aria-expanded={open}
                    className="flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left"
                    onClick={() => setOpenId(open ? null : entry.id)}
                    id={`entry-${entry.id}`}
                    type="button"
                  >
                    <div className="min-w-0 grow">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {formatWhen(entry.createdAt)}
                        </span>
                        {entry.durationSec !== null && entry.durationSec > 0 ? (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatClock(entry.durationSec)}
                          </span>
                        ) : null}
                        <StatusBadge entry={entry} />
                      </div>
                      <p
                        className={cn(
                          "mt-1 text-sm text-foreground",
                          open ? "whitespace-pre-wrap" : "line-clamp-2",
                        )}
                      >
                        {open
                          ? entry.text
                          : preview === ""
                            ? entry.status === "failed"
                              ? (entry.error ?? "Recognition failed.")
                              : "…"
                            : preview}
                      </p>
                    </div>
                    <Icon
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      name={open ? "ChevronDown" : "ChevronRight"}
                    />
                  </button>

                  {open ? (
                    <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                      {entry.audioFile === null ? null : (
                        <AudioPlayer
                          fallbackDurationSec={entry.durationSec}
                          src={audioUrl(entry)}
                        />
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-state-hover"
                          disabled={entry.text === ""}
                          onClick={() => void copy(entry)}
                          type="button"
                        >
                          <Icon
                            aria-hidden
                            className="size-3.5"
                            name={copiedId === entry.id ? "Check" : "Copy"}
                          />
                          {copiedId === entry.id ? "Copied" : "Copy text"}
                        </button>
                        <a
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-state-hover"
                          download={entry.audioFile ?? undefined}
                          href={audioUrl(entry)}
                        >
                          <Icon aria-hidden className="size-3.5" name="Download" />
                          Audio
                        </a>
                        <button
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => void remove(entry)}
                          type="button"
                        >
                          <Icon aria-hidden className="size-3.5" name="Trash2" />
                          Delete
                        </button>
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          {entry.model}
                          {entry.elapsedSec === null
                            ? ""
                            : ` · recognized in ${entry.elapsedSec.toFixed(1)}s`}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {entries.length < total ? (
          <button
            className="mt-3 w-full cursor-pointer rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
            type="button"
          >
            Show older ({total - entries.length} more)
          </button>
        ) : null}
      </div>
    </div>
  );
}
