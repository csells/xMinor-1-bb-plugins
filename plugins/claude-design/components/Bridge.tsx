// Mounted once per app window and renders nothing. It keeps the shared
// project list current for every surface of the plugin, and lends the
// callbacks that run outside React (the composer's + menu row, the thread
// panel launcher row, the command palette) an RPC client and a navigator.
import { useEffect, useRef } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/contract";
import { CHANGED_CHANNEL } from "@/lib/links";
import { attachRpc, refreshProjects, setAppNavigate } from "@/lib/store";

export function Bridge() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);

  useEffect(() => {
    attachRpc(rpc);
  }, [rpc]);

  useEffect(() => {
    setAppNavigate(navigate);
    return () => setAppNavigate(null);
  }, [navigate]);

  // A change from the page, another window or an agent's CLI call.
  useRealtime(CHANGED_CHANNEL, () => {
    void refreshProjects();
  });

  // Signals are not replayed: after a reconnect, read the list again.
  useEffect(() => {
    if (connection !== "connected") return;
    if (wasConnected.current) void refreshProjects();
    wasConnected.current = true;
  }, [connection]);

  return null;
}
