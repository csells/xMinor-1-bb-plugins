// lib/last-folder.ts — "reopen where I was" (PATHBAR-SPEC §1).
//
// The panel remembers the absolute path of the last folder the *backend*
// confirmed, and reopens it on the next cold open. Two facts shape the module:
//
//   * the value is a local filesystem path, so it is client-side and never
//     leaves the machine: `localStorage` through `lib/fm-store.ts`, not the
//     plugin settings and not `bb.storage.kv` (§1.2 has the rejected
//     alternatives on the record);
//   * the hard root is the home directory of whoever runs bb, so the same
//     browser profile can talk to two hosts with two different homes over
//     time. The stored `root` turns "a path that happens to look plausible"
//     into "a path recorded under a different root", which is dropped rather
//     than guessed at.
//
// `pickInitialFolder` is pure so the decision can be tested without a renderer.
import { createSessionStore } from "./fm-store";
import { isInsideRoot, isSamePath, normalizePath, subPathToAbsolute } from "./fm-paths";

export const LAST_FOLDER_STORAGE_KEY = "bb-plugin-file-manager:last-folder:v1";
/** A path is bounded by PATH_MAX; this is the JSON envelope's ceiling. */
export const LAST_FOLDER_MAX_BYTES = 8 * 1024;
/** Mirrors `useTree`'s tier-2 debounce: one write per burst of navigation. */
export const LAST_FOLDER_DEBOUNCE_MS = 250;

export interface RememberedFolder {
  /** Absolute, as the backend resolved it (`listDir`'s answer, not the route). */
  path: string;
  /** The hard root the path was recorded under. */
  root: string;
}

function parseRemembered(raw: unknown): RememberedFolder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const path = candidate.path;
  const root = candidate.root;
  if (typeof path !== "string" || path === "") return null;
  if (typeof root !== "string" || root === "") return null;
  return { path, root };
}

const store = createSessionStore<RememberedFolder | null>({
  key: LAST_FOLDER_STORAGE_KEY,
  fallback: () => null,
  parse: parseRemembered,
  maxBytes: LAST_FOLDER_MAX_BYTES,
});

/** The remembered folder, or null when there is none (or it was unreadable). */
export function readLastFolder(): RememberedFolder | null {
  return store.read();
}

/** Tier 1 only — what a remount inside one page session reads back. */
export function rememberLastFolder(value: RememberedFolder): void {
  store.remember(value);
}

/** Tier 1 + tier 2. */
export function writeLastFolder(value: RememberedFolder): void {
  store.write(value);
}

/** The user-facing reset (§1.9) and the §1.6 fallback both land here. */
export function forgetLastFolder(): void {
  store.clear();
}

/** Test seam, mirroring `resetTreeStore` / `resetUploadManager`. */
export function resetLastFolderStore(): void {
  store.reset();
}

/* ------------------------------------------------------------------ */
/* The decision (§1.5)                                                 */
/* ------------------------------------------------------------------ */

export type InitialFolderSource = "deep-link" | "workspace" | "memory" | "start-folder";

export interface InitialFolderChoice {
  /** Absolute path the panel should open. */
  path: string;
  source: InitialFolderSource;
}

export interface PickInitialFolderArgs {
  /** The panel's `subPath` prop as delivered by the host. */
  subPath: string;
  remembered: RememberedFolder | null;
  /**
   * The thread's project folder, when the surface has a thread, the
   * `openThreadWorkspace` preference is on and `threadWorkspace` answered with
   * an openable path. Null in every other case — including a thread with no
   * environment, no checkout, or a checkout outside the root — and then the
   * decision is the one it was before the preference existed.
   */
  workspaceFolder: string | null;
  /** `getState().startFolder` — already validated by the backend. */
  startFolder: string;
  /** `getState().root`. */
  root: string;
  /** `getState().preferences.restoreLastFolder`. */
  restoreLastFolder: boolean;
}

/**
 * Where the panel opens, in priority order: an explicit link, then the
 * thread's project folder, then the memory, then the configured start folder.
 *
 * The project folder outranks the memory on purpose: it is a per-thread
 * answer, and a remembered folder is one global value shared by every surface,
 * so letting the memory win would mean the first thread you visited decides
 * where every later thread's panel opens.
 *
 * `isInsideRoot` is called with the *explicit* root, never with its default
 * argument: the default reads `getClientRoot()`, which is still "/" until the
 * first panel bootstrap runs, and under "/" every absolute path passes — the
 * guard would be a no-op on a genuinely cold start.
 *
 * `subPath === ""` means both "no location given" and "the root", so a deep
 * link *to the root* is indistinguishable from opening the panel from the
 * sidebar and loses to the memory. Accepted in 0.4.0: the "Home" crumb is the
 * escape hatch, and a sentinel segment in every URL is a worse price (§1.5).
 */
export function pickInitialFolder(args: PickInitialFolderArgs): InitialFolderChoice {
  const { subPath, remembered, workspaceFolder, startFolder, root, restoreLastFolder } = args;

  if (subPath !== "") {
    return { path: subPathToAbsolute(subPath, root), source: "deep-link" };
  }
  // Guarded here as well as at the caller: `threadWorkspace` reports a path
  // that sits outside the root rather than hiding it, and §6 forbids opening
  // one — the panel would redirect to a folder it cannot list.
  if (workspaceFolder !== null && isInsideRoot(workspaceFolder, root)) {
    return { path: normalizePath(workspaceFolder), source: "workspace" };
  }
  const fallback: InitialFolderChoice = { path: startFolder, source: "start-folder" };
  if (!restoreLastFolder) return fallback;
  if (remembered === null) return fallback;
  if (!isSamePath(remembered.root, root)) return fallback;
  if (!isInsideRoot(remembered.path, root)) return fallback;
  return { path: normalizePath(remembered.path), source: "memory" };
}
