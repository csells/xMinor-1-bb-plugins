// The app's one copy of the saved project list, shared by every surface of
// this plugin in a window: the sidebar page, the thread header button, the
// browser toolbar and the composer's + menu.
//
// Two host callbacks run outside React — the composer's + menu row and the
// thread panel action — so this module also keeps the plugin's RPC client and
// a navigator from the always-mounted overlay, plus an `openUrl` per visible
// thread from its header button. An `openUrl` taken from a thread's own header
// opens the link in that thread's browser panel.
import { useEffect, useSyncExternalStore } from "react";
import {
  useRpc,
  type BbNavigate,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type { DesignProject, rpcContract } from "../contract";

export type Rpc = PluginRpcClient<typeof rpcContract>;

export interface ProjectsState {
  status: "loading" | "ready" | "error";
  projects: readonly DesignProject[];
  error: string | null;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

let client: Rpc | null = null;
let state: ProjectsState = { status: "loading", projects: [], error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let again = false;

function publish(next: ProjectsState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getState(): ProjectsState {
  return state;
}

export function projectsNow(): ProjectsState {
  return state;
}

export function currentRpc(): Rpc | null {
  return client;
}

/**
 * Refetches the list. Calls made while a fetch is running share it and cause
 * one more fetch afterwards, so a change is never answered by a stale read.
 */
export function refreshProjects(): Promise<void> {
  const rpc = client;
  if (rpc === null) return Promise.resolve();
  if (inflight !== null) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      again = false;
      try {
        const { projects } = await rpc.call("list");
        publish({ status: "ready", projects, error: null });
      } catch (cause) {
        publish({
          ...state,
          status: state.status === "ready" ? "ready" : "error",
          error: messageOf(cause),
        });
      }
    } while (again);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function attachRpc(rpc: Rpc): void {
  const first = client === null;
  client = rpc;
  if (first || state.status === "error") void refreshProjects();
}

/** The saved projects, kept current by the overlay's realtime subscription. */
export function useProjects(): ProjectsState {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    attachRpc(rpc);
  }, [rpc]);
  return useSyncExternalStore(subscribe, getState, getState);
}

export function linkedProject(
  projects: readonly DesignProject[],
  bbProjectId: string | null,
): DesignProject | null {
  if (bbProjectId === null) return null;
  return (
    projects.find(
      (project) => project.bbProjectId === bbProjectId && project.isDefault,
    ) ?? null
  );
}

// ---- navigation for callbacks that run outside React ----------------------

let appNavigate: BbNavigate | null = null;

export function setAppNavigate(navigate: BbNavigate | null): void {
  appNavigate = navigate;
}

export function currentNavigate(): BbNavigate | null {
  return appNavigate;
}

export interface ThreadSurface {
  projectId: string;
  openUrl(url: string): boolean;
}

const surfaces = new Map<string, { token: object; surface: ThreadSurface }>();

/** Called by a thread's header button; the returned function unregisters it. */
export function registerThreadSurface(
  threadId: string,
  surface: ThreadSurface,
): () => void {
  const token = {};
  surfaces.set(threadId, { token, surface });
  return () => {
    if (surfaces.get(threadId)?.token === token) surfaces.delete(threadId);
  };
}

export function threadSurface(threadId: string): ThreadSurface | null {
  return surfaces.get(threadId)?.surface ?? null;
}
