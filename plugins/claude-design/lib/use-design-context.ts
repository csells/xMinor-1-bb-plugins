import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { DesignContext, rpcContract } from "../contract";

export interface DesignContextState {
  status: "idle" | "loading" | "ready" | "error";
  data: DesignContext | null;
}

/**
 * The bb project a thread belongs to, and whether it can have a linked
 * Claude Design project. Read once per thread: which project is linked comes
 * from the live list (lib/store), not from this snapshot.
 */
export function useDesignContext(threadId: string | null): DesignContextState {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<DesignContextState>({
    status: threadId === null ? "idle" : "loading",
    data: null,
  });
  useEffect(() => {
    if (threadId === null) {
      setState({ status: "idle", data: null });
      return undefined;
    }
    let live = true;
    setState({ status: "loading", data: null });
    rpc.call("context", { threadId, projectId: null }).then(
      (data) => {
        if (live) setState({ status: "ready", data });
      },
      () => {
        if (live) setState({ status: "error", data: null });
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId]);
  return state;
}
