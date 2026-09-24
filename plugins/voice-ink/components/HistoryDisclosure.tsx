// What the microphone in the sidebar footer opens: the last handful of
// dictations, close to where bb is being used.
//
// The full panel is one click away and holds the audio, the search and the
// rest. This is for the question that comes up right after speaking — "did the
// whole thing get through?" — so it leads with the ones that did not.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { PANEL_PATH, type HistoryEntry } from "../contract";
import type { rpcContract } from "../server";

/** Enough to cover a working session, few enough to read at a glance. */
const RECENT_COUNT = 6;
const POLL_MS = 5_000;

function formatWhen(createdAt: number): string {
  const date = new Date(createdAt);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

export function HistoryDisclosure({ dismiss }: { dismiss: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("history_list", {
        query: "",
        limit: RECENT_COUNT,
        offset: 0,
      });
      setEntries(result.entries);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    // A dictation bb gave up on is still being recognized while this is open.
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const open = useCallback(
    (entry?: HistoryEntry) => {
      navigate.toPluginPanel(PANEL_PATH, entry === undefined ? undefined : { subPath: entry.id });
      dismiss();
    },
    [dismiss, navigate],
  );

  return (
    <div className="flex w-full flex-col gap-1 p-1">
      <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
        <span className="text-xs font-medium text-foreground">Recent dictations</span>
        <button
          className="cursor-pointer text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => open()}
          type="button"
        >
          Open History
        </button>
      </div>

      {error !== null ? (
        <p className="px-2 pb-1 text-[11px] text-destructive">{error}</p>
      ) : entries === null ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
          Nothing dictated yet.
        </p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => {
            const cutShort =
              entry.status === "done" &&
              entry.deliveredChars !== null &&
              entry.deliveredChars + 1 < entry.text.length;
            return (
              <li key={entry.id}>
                <button
                  className={cn(
                    "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
                    "transition-colors hover:bg-state-hover",
                  )}
                  onClick={() => open(entry)}
                  type="button"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">
                      {formatWhen(entry.createdAt)}
                    </span>
                    {entry.status === "running" ? (
                      <Icon
                        aria-label="still transcribing"
                        className="size-3 animate-spin text-muted-foreground"
                        name="Loading"
                      />
                    ) : cutShort ? (
                      <span
                        className="text-[10px] text-primary"
                        title="Only part of this reached the composer."
                      >
                        partial
                      </span>
                    ) : null}
                  </span>
                  <span className="line-clamp-2 text-xs text-foreground">
                    {entry.text.replace(/\s+/g, " ").trim() ||
                      (entry.status === "failed" ? "Recognition failed." : "…")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
