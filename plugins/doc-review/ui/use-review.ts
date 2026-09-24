// Data hooks for the review panel: the opened document, its content version,
// and its comments, kept current by polling and the server's realtime signal.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../src/contract";
import type { ReviewComment, ReviewDoc } from "../src/types";

/** How often an open panel checks whether the file changed on disk. */
const VERSION_POLL_MS = 4000;

export function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}

export function useReviewRpc() {
  return useRpc<RpcContract>();
}

export function useReviewDoc(path: string, source: PluginFileOpenerSource) {
  const rpc = useReviewRpc();
  const [doc, setDoc] = useState<ReviewDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { kind, threadId, environmentId, projectId } = source;
  const hostId = source.experimental_hostId ?? null;

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError(null);
    rpc
      .call("doc.open", {
        path,
        source: { kind, threadId, environmentId, projectId, experimental_hostId: hostId },
      })
      .then(
        (result) => alive && setDoc(result.doc),
        (cause: unknown) => alive && setError(errorText(cause)),
      );
    return () => {
      alive = false;
    };
  }, [rpc, path, kind, threadId, environmentId, projectId, hostId]);

  // The agent edits the file while the panel is open; notice new versions.
  const docId = doc?.id ?? null;
  const version = doc?.version ?? null;
  useEffect(() => {
    if (!docId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      rpc.call("doc.version", { docId }).then(
        (result) => {
          if (result.version && result.version !== version) {
            setDoc((current) =>
              current && current.id === docId ? { ...current, version: result.version! } : current,
            );
          }
        },
        () => undefined,
      );
    }, VERSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [rpc, docId, version]);

  return { doc, error };
}

export function useComments(docId: string | null) {
  const rpc = useReviewRpc();
  const [comments, setComments] = useState<ReviewComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const refetch = useCallback(() => {
    if (!docId) return;
    const request = ++latest.current;
    rpc.call("comments.list", { docId }).then(
      (result) => {
        if (request !== latest.current) return;
        setComments(result.comments);
        setError(null);
      },
      (cause: unknown) => request === latest.current && setError(errorText(cause)),
    );
  }, [rpc, docId]);

  useEffect(() => {
    setComments(null);
    refetch();
  }, [refetch]);

  useRealtime("review-changed", (payload: unknown) => {
    const ids = (payload as { docIds?: unknown } | null)?.docIds;
    if (!docId || !Array.isArray(ids) || ids.includes(docId)) refetch();
  });

  // Signals are not replayed: reconcile after a reconnect.
  const connection = useRealtimeConnectionState();
  const seenConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (seenConnected.current) refetch();
    seenConnected.current = true;
  }, [connection, refetch]);

  return { comments, error, refetch, setComments };
}
