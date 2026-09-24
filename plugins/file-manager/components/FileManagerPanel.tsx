// components/FileManagerPanel.tsx — the panel root: layout, state ownership,
// the keyboard map and the drag&drop surface (§8.1–§8.5, §9).
//
// One body, two surfaces (§10.1). `FileManagerSurface` takes an `FmLocation`
// instead of reading the route, so the nav panel can keep the folder in the
// URL while a panel tab keeps it in component state, and a `chrome` flag says
// whether the actions live in bb's title bar or in the toolbar.
//
// Everything that can fail is caught here. A throw inside a slot component
// disables the plugin's whole UI until `bb plugin reload`, so every RPC
// rejection ends in a toast or an ErrorBanner, never in an exception.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useBbNavigate, useComposer, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import {
  MAX_LIST_ENTRIES,
  MENTION_PROVIDER_ID,
  type FileEntry,
  type FileManagerErrorCode,
  type ViewMode,
} from "../contract";
import { useBookmarks } from "../hooks/useBookmarks";
import { useClipboard } from "../hooks/useClipboard";
import { useRouteLocation, type FmLocation } from "../hooks/useFmLocation";
import {
  matchesQuery,
  useDirectory,
  type ListDirResult,
  type SortDirection,
  type SortField,
} from "../hooks/useDirectory";
import { usePreviewBase } from "../hooks/usePreviewBase";
import { useJobs } from "../hooks/useJobs";
import { useSelection } from "../hooks/useSelection";
import { threadWorkspaceBlockedText, useThreadWorkspace } from "../hooks/useThreadWorkspace";
import { useTree, type UseTreeResult } from "../hooks/useTree";
import { useUploads } from "../hooks/useUploads";
import {
  BOOKMARKS_FULL_TEXT,
  BOOKMARK_ADD_FAILED_TEXT,
  BOOKMARK_REMOVE_FAILED_TEXT,
  BOOKMARK_RENAME_FAILED_TEXT,
  findBookmark,
} from "../lib/bookmarks";
import { downloadEntry, downloadPaths } from "../lib/download";
import {
  batchFailureText,
  describeErrorCode,
  errorToastText,
  parseRpcError,
  type BatchFailure,
  type ParsedRpcError,
} from "../lib/errors";
import {
  absoluteToSubPath,
  basename,
  dirname,
  getClientRoot,
  isSameOrDescendant,
  isSamePath,
  parentPath as parentOf,
  rootPhrase,
  SEPARATOR,
  setClientRoot,
  subPathToAbsolute,
} from "../lib/fm-paths";
import {
  outsideRootMessage,
  parsePathInput,
  PATH_INVALID_MESSAGE,
} from "../lib/fm-pathbar";
import {
  forgetLastFolder,
  LAST_FOLDER_DEBOUNCE_MS,
  pickInitialFolder,
  readLastFolder,
  rememberLastFolder,
  writeLastFolder,
  type RememberedFolder,
} from "../lib/last-folder";
import {
  AUTO_EXPAND_HOVER_MS,
  MAX_TREE_ROWS,
  topLevelPaths,
  type TreeEntryRow,
} from "../lib/fm-tree";
import { useFmRpc, type RpcOutput } from "../lib/fm-rpc";
import {
  saveStartFolder,
  startFolderLabel,
  START_FOLDER_SAVED_TEXT,
  START_FOLDER_SAVE_FAILED_TEXT,
} from "../lib/start-folder";
import type { UploadRequest } from "../lib/upload-manager";
import { isViewableEntry } from "../lib/viewer";
import { ActivityTray } from "./ActivityTray";
import { BackgroundContextMenu } from "./BackgroundContextMenu";
import { BookmarkMenuItems, BookmarksMenu } from "./BookmarksMenu";
import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { effectiveKind, isFileEntry } from "./FileRow";
import { FileGallery } from "./FileGallery";
import { FileTable } from "./FileTable";
import { RowContextMenu } from "./RowContextMenu";
import { SelectionActionBar } from "./SelectionActionBar";
import type { SelectedEntryActionsProps } from "./selected-entry-actions";
import { Toolbar } from "./Toolbar";
import { BookmarkNameDialog } from "./dialogs/BookmarkNameDialog";
import { ConfirmDeleteDialog } from "./dialogs/ConfirmDeleteDialog";
import { ConflictDialog, type ConflictChoice } from "./dialogs/ConflictDialog";
import { ExtractDialog, isFormatSupported, type ExtractSubmission } from "./dialogs/ExtractDialog";
import { FileViewerDialog } from "./dialogs/FileViewerDialog";
import { FolderPickerDialog } from "./dialogs/FolderPickerDialog";
import { NewFolderDialog } from "./dialogs/NewFolderDialog";
import { PropertiesDialog, type PropertiesTarget } from "./dialogs/PropertiesDialog";
import { RenameDialog } from "./dialogs/RenameDialog";
import { ContextMenu, ContextMenuTrigger } from "./ui/context-menu";
import { useIsCompactViewport } from "./ui/hooks/use-compact-viewport";
import { useIsCoarsePointer } from "./ui/hooks/use-coarse-pointer";
import {
  publishPanelSnapshot,
  resetPanelSnapshot,
  subscribePanelCommands,
  type PanelCommand,
  type PanelSnapshot,
} from "./panel-bus";
import { PanelActions, type ThreadFolderAction } from "./PanelActions";

type GetState = RpcOutput<"getState">;
type BatchResult = RpcOutput<"moveEntries">;

/** Private drag flavour; `text/plain` carries the same paths as a fallback. */
const DRAG_MIME = "application/x-bb-file-manager";

const DEFAULT_ARCHIVE_SUPPORT = { zip: false, tar: false, sevenZip: false, rar: false };

/** Stable empty list, so the list view never re-memoises on a fresh `[]`. */
const NO_ENTRIES: readonly FileEntry[] = [];

type DialogState =
  | { kind: "none" }
  | { kind: "new-folder" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete"; entries: FileEntry[] }
  | { kind: "extract"; entry: FileEntry }
  | { kind: "view"; entry: FileEntry }
  | { kind: "properties"; target: PropertiesTarget }
  | { kind: "bookmark-name"; path: string; name: string }
  | { kind: "picker"; mode: "move" | "copy"; paths: string[] }
  | {
      kind: "conflict";
      operation: "move" | "copy";
      destinationDir: string;
      paths: string[];
      conflicts: BatchFailure[];
    };

/* ------------------------------------------------------------------ */
/* Drag & drop helpers                                                 */
/* ------------------------------------------------------------------ */

function isExternalDrag(event: ReactDragEvent<HTMLElement>): boolean {
  // `dataTransfer` is always there in a browser, but a throw inside an event
  // handler takes the plugin's whole UI down with it — cheap insurance.
  const types = (event.dataTransfer as DataTransfer | undefined)?.types;
  return types !== undefined && Array.from(types).includes("Files");
}

function readDraggedPaths(dataTransfer: DataTransfer): string[] {
  const raw = dataTransfer.getData(DRAG_MIME);
  if (raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      /* fall through to the text/plain fallback */
    }
  }
  const text = dataTransfer.getData("text/plain");
  if (text === "") return [];
  return text.split("\n").filter((line) => line.startsWith("/"));
}

/**
 * Grab the `FileSystemEntry` list synchronously — `dataTransfer.items` is
 * neutered as soon as the drop handler returns. Returns null when the browser
 * has no `webkitGetAsEntry`, which is the folder-upload fallback of risk #3.
 */
function snapshotDropEntries(dataTransfer: DataTransfer): FileSystemEntry[] | null {
  const items = dataTransfer.items;
  if (items.length === 0) return null;
  const collected: FileSystemEntry[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    if (typeof item.webkitGetAsEntry !== "function") return null;
    const entry = item.webkitGetAsEntry();
    if (entry !== null) collected.push(entry);
  }
  return collected.length === 0 ? null : collected;
}

async function walkDropEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: { file: File; relativeDir: string }[],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File | null>((resolve) => {
      fileEntry.file(resolve, () => resolve(null));
    });
    if (file !== null) out.push({ file, relativeDir: prefix });
    return;
  }
  if (!entry.isDirectory) return;
  const directoryEntry = entry as FileSystemDirectoryEntry;
  const childPrefix = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
  const reader = directoryEntry.createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) break;
    for (const child of batch) await walkDropEntry(child, childPrefix, out);
  }
}

async function writeClipboardText(text: string): Promise<boolean> {
  try {
    const clipboard: unknown =
      typeof navigator === "undefined" ? undefined : (navigator as Navigator).clipboard;
    if (clipboard !== undefined && clipboard !== null) {
      await (clipboard as Clipboard).writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Location memory and the path bar (PATHBAR-SPEC §1.6, §5.4)          */
/* ------------------------------------------------------------------ */

/**
 * The codes that mean "the folder you were last in is not there any more".
 * Everything else — `io_error`, a dropped socket, an offline backend — is a
 * transient failure of a folder that probably still exists, and throwing the
 * memory away over it is worse than the normal error banner with its retry.
 */
const RESTORE_FALLBACK_CODES: ReadonlySet<FileManagerErrorCode> = new Set<FileManagerErrorCode>([
  "not_found",
  "not_a_directory",
  "permission_denied",
  "path_escape",
  "invalid_path",
]);

/** `label` comes from `startFolderLabel`, so no literal root path is spoken. */
function restoreFallbackText(code: FileManagerErrorCode, label: string): string {
  switch (code) {
    case "not_found":
    case "not_a_directory":
      return `The folder you were last in is gone. Opened ${label} instead.`;
    case "permission_denied":
      return `The folder you were last in cannot be opened. Opened ${label} instead.`;
    default:
      return `The folder you were last in is no longer reachable. Opened ${label} instead.`;
  }
}

/**
 * The inline message under the path input. It names the path the *user* typed,
 * never the server's own path string: on a missing parent `statPath` resolves
 * the parent chain first and the error it throws names the parent (§5.4).
 */
function pathCommitErrorText(failure: unknown, typed: string, root: string): string {
  const parsed = parseRpcError(failure);
  switch (parsed.code) {
    case null:
      return errorToastText(failure, "Could not open that path.");
    case "not_found":
      return `There is nothing at ${typed}.`;
    case "permission_denied":
      return `You do not have permission to open ${typed}.`;
    case "path_escape":
      return outsideRootMessage(root);
    case "invalid_path":
    case "invalid_name":
      return PATH_INVALID_MESSAGE;
    case "io_error":
      return "The filesystem reported an error. Try again.";
    default:
      return describeErrorCode(parsed.code);
  }
}

/** A file the path bar asked for, waiting for its folder's listing to land. */
interface PendingReveal {
  /** Absolute path of the entry to select. */
  path: string;
  /** The folder that must be on screen for it to exist. */
  dir: string;
  name: string;
  /**
   * The listing on screen when the reveal was armed, but only when the reveal
   * itself turned hidden files on: that refetch is in flight for a render or
   * two, and the listing still on screen genuinely does not contain the row.
   * Declaring "it is not here" against it would be wrong (§5.3).
   */
  since: ListDirResult | null;
  /**
   * Open the Extract dialog for the entry once it is selected (§8.13): the
   * file opener's "Extract…" arrives here, so the extraction runs through
   * the panel's own dialog, job and tray rather than one of its own.
   */
  extract: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
}

/**
 * True when the keystroke is aimed at something Space already means something
 * to. Space activates a button, a link and a checkbox, and the quick-look
 * binding (§8.9) bubbles up from every one of them: without this guard, Space
 * on the toolbar's Refresh would refresh *and* open a preview from one press.
 * `isTypingTarget` does not cover it — a button is not a typing target.
 */
function isActivationTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('button, a[href], summary, [role="button"], [role="checkbox"]') !== null;
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export interface FileManagerSurfaceProps {
  /** Where the current folder lives — the route, or this component's state. */
  location: FmLocation;
  /**
   * Which chrome the surface is wearing.
   *
   * "host-header" is the nav panel: bb renders `HeaderActions` in the shared
   * title bar, and the panel talks to it through components/panel-bus.ts.
   * "inline" is a panel tab, which has no title bar of its own — the same
   * actions ride in the toolbar instead, and the surface stays off the bus so
   * two open surfaces cannot answer one header click.
   */
  chrome: "host-header" | "inline";
  /**
   * Absolute folder to open on mount, outranking the remembered and the
   * configured start folder (§10.2). The file-location openers pass the folder
   * they resolved; every other surface leaves it null and gets the ordinary
   * §1.5 rules.
   */
  initialPath?: string | null;
  /** Absolute path of an entry to select once its folder is listed (§5.3). */
  revealPath?: string | null;
  /**
   * Also open the Extract dialog for `revealPath` once it is selected — the
   * file opener's "Extract…" for an archive link (§8.13). Ignored for a
   * reveal that is not an archive.
   */
  extractOnReveal?: boolean;
  /** Seed for the in-folder filter; the compact chrome unfolds for it. */
  initialQuery?: string;
  /**
   * The thread this surface belongs to, when it belongs to one (§10.3).
   *
   * Only bb's thread panel names it, and it buys exactly one thing: the
   * toolbar's jump into that thread's checkout. Null everywhere else — the
   * nav panel, the New thread launcher and the file openers are rooted at the
   * home folder, not at a thread.
   */
  threadId?: string | null;
}

export function FileManagerSurface({
  location,
  chrome,
  initialPath = null,
  revealPath = null,
  extractOnReveal = false,
  initialQuery = "",
  threadId = null,
}: FileManagerSurfaceProps) {
  const rpc = useFmRpc();
  const isCompactViewport = useIsCompactViewport();
  const isCoarsePointer = useIsCoarsePointer();
  const touchActionsEnabled = isCompactViewport || isCoarsePointer;
  const subPath = location.subPath;
  const locationRef = useRef(location);
  locationRef.current = location;
  const inlineChrome = chrome === "inline";
  // Read once: the bootstrap runs once, and a later prop change must not drag
  // the panel back to where it started while the user is somewhere else.
  const initialPathRef = useRef(initialPath);
  /** Same reason: the bootstrap asks which thread it opened in, once. */
  const bootstrapThreadIdRef = useRef(threadId);

  const [state, setState] = useState<GetState | null>(null);
  /** Read from callbacks that must not re-create themselves per bootstrap. */
  const stateRef = useRef(state);
  stateRef.current = state;
  const [stateError, setStateError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Folder navigation goes through `location`; this is the host's navigator,
  // which is also how a file reaches bb's preview panel.
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // The draft "Add to chat" writes into (§8.8). Which draft that is, is the
  // host's call and depends on the surface: a panel tab beside a thread writes
  // into that thread's composer, while the sidebar page seeds the composer of
  // the next new thread. Held in a ref so the callback below never has to
  // re-create itself when the host hands back a fresh api object.
  const composer = useComposer();
  const composerRef = useRef(composer);
  composerRef.current = composer;

  const root = state?.root ?? getClientRoot();
  const currentPath = useMemo(() => subPathToAbsolute(subPath, root), [subPath, root]);
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  const [showHidden, setShowHidden] = useState(false);
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const [confirmOnDelete, setConfirmOnDelete] = useState(true);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  /** List or gallery (§8.9), persisted exactly like sort and hidden files. */
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const galleryView = viewMode === "gallery";
  const [query, setQuery] = useState(initialQuery);
  const queryRef = useRef(query);
  queryRef.current = query;
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [contextTarget, setContextTarget] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [externalDrag, setExternalDrag] = useState(false);

  /* Path bar (§3). The panel owns the mode, the inline failure and the commit;
     `components/PathBar.tsx` owns the draft text for exactly as long as the
     mode lasts. */
  /**
   * Compact chrome only: the filter is folded into a magnifier so the path bar
   * keeps a readable width, and this says whether it is unfolded.
   */
  const [searchOpen, setSearchOpen] = useState(initialQuery !== "");
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;

  const [pathEditing, setPathEditing] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [pathBusy, setPathBusy] = useState(false);
  const [pathFocusTick, setPathFocusTick] = useState(0);
  const pathEditingRef = useRef(false);
  const pathTicketRef = useRef(0);
  /**
   * State rather than a ref on purpose: the reveal can target a file in the
   * folder already on screen, and then no listing lands to wake an effect up.
   * Setting it has to be what schedules the check.
   */
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(null);

  /* Location memory (§1). `restorePending` is the absolute path the bootstrap
     restored from memory; it arms the §1.6 fallback and is cleared the moment
     the listing lands. */
  const [restorePending, setRestorePending] = useState<string | null>(null);
  const [swallowedError, setSwallowedError] = useState<ParsedRpcError | null>(null);
  const lastFolderPendingRef = useRef<RememberedFolder | null>(null);
  /**
   * True between the bootstrap's `replace` navigation and the host applying
   * it. The route still says "root" in that window, so listing it would spend
   * a full `readdir` of the home directory on a folder nobody asked for — and
   * would record it as "where you were" (§1.4). Nothing is listed until the
   * route the panel asked for is the route it is on.
   */
  const [redirectPending, setRedirectPending] = useState(false);
  /** The `subPath` the redirect left behind; any change to it opens the gate. */
  const redirectFromRef = useRef<string | null>(null);
  /** The value the memory already holds, so a repeat listing writes nothing. */
  const lastFolderWrittenRef = useRef<RememberedFolder | null>(null);
  /**
   * The tier-2 debounce lives in a ref, not in an effect cleanup: a refetch of
   * the folder already recorded must not cancel a write that is still pending
   * for it (§1.4).
   */
  const lastFolderTimerRef = useRef<number | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The `role="treegrid"` element: the list view's keyboard widget (§8.3). */
  const gridRef = useRef<HTMLTableElement>(null);
  /** The gallery's `role="listbox"` grid — the same widget in the other view. */
  const galleryRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contextRowRef = useRef<string | null>(null);
  const pendingDropTargetRef = useRef<string | null>(null);
  const dragDepthRef = useRef(0);
  const subPathRef = useRef(subPath);
  subPathRef.current = subPath;

  /**
   * Focus whichever of the two surfaces is mounted. Exactly one ever is, so
   * this is the old "focus the grid" with the view switch factored out — and
   * focus still never lands on `<body>`, which is what the keyboard map needs.
   */
  const focusSurface = useCallback(() => {
    (gridRef.current ?? galleryRef.current)?.focus();
  }, []);

  /* -------------------------------------------------------------- */
  /* Bootstrap (§8.1)                                                */
  /* -------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await rpc.call("getState", null);
        if (cancelled) return;
        // The panel learns the hard root here: it is the home directory of the
        // user running bb, so path helpers cannot default to a fixed value.
        setClientRoot(result.root);
        setState(result);
        setShowHidden(result.preferences.showHiddenFiles);
        setConfirmOnDelete(result.preferences.confirmOnDelete);
        setSortField(result.preferences.sortField);
        setSortDirection(result.preferences.sortDirection);
        setViewMode(result.preferences.viewMode);
        setStateError(null);
        // Where to open: a folder the caller asked for (§10.2), then an
        // explicit link, then the remembered folder, then the configured start
        // folder (§1.5). The `subPath === ""` guard that used to sit here is
        // now rule 1 of `pickInitialFolder`.
        const requested = initialPathRef.current;
        if (requested !== null) {
          // A requested folder needs the same redirect a remembered one needs:
          // the surface mounted at its location's `subPath`, not at this path.
          const targetSubPath = absoluteToSubPath(requested, result.root);
          if (targetSubPath !== subPathRef.current) {
            redirectFromRef.current = subPathRef.current;
            setRedirectPending(true);
            locationRef.current.navigate(targetSubPath, { replace: true });
          }
          return;
        }
        // The thread's own project folder, when this surface has a thread and
        // the preference is on (§1.5). One extra round trip before the first
        // listing, and only on the surfaces and setting that ask for it: the
        // nav panel, the New thread launcher and the openers have no thread,
        // so they never pay for it. Every "no" answer — no environment, no
        // checkout, outside the root, or a lookup that failed outright —
        // leaves the folder null and the decision as it was.
        const bootstrapThreadId = bootstrapThreadIdRef.current;
        let workspaceFolder: string | null = null;
        if (result.preferences.openThreadWorkspace && bootstrapThreadId !== null) {
          const answer = await rpc
            .call("threadWorkspace", { threadId: bootstrapThreadId })
            .catch(() => null);
          if (cancelled) return;
          if (answer !== null && answer.reason === null && answer.path !== null) {
            workspaceFolder = answer.path;
          }
        }
        const choice = pickInitialFolder({
          subPath: subPathRef.current,
          remembered: readLastFolder(),
          workspaceFolder,
          startFolder: result.startFolder,
          root: result.root,
          restoreLastFolder: result.preferences.restoreLastFolder,
        });
        if (choice.source !== "deep-link" && !isSamePath(choice.path, result.root)) {
          // Only a folder restored from memory arms the fallback: the start
          // folder is where that fallback *goes*, so arming it for the start
          // folder itself would be a loop.
          if (choice.source === "memory") setRestorePending(choice.path);
          redirectFromRef.current = subPathRef.current;
          setRedirectPending(true);
          locationRef.current.navigate(absoluteToSubPath(choice.path, result.root), {
            replace: true,
          });
        }
      } catch (failure) {
        if (!cancelled) setStateError(parseRpcError(failure).rawMessage);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  /**
   * The host applied the redirect (or moved the panel somewhere else): either
   * way the route has moved on from the one the redirect left, so the listing
   * may start. Watching for *any* change rather than for the target keeps a
   * host that routes elsewhere from leaving the panel in a permanent skeleton.
   */
  useEffect(() => {
    if (!redirectPending) return;
    if (redirectFromRef.current === null || subPath !== redirectFromRef.current) {
      redirectFromRef.current = null;
      setRedirectPending(false);
    }
  }, [redirectPending, subPath]);

  /* -------------------------------------------------------------- */
  /* Data                                                            */
  /* -------------------------------------------------------------- */

  /** No RPC until the panel is standing where the bootstrap sent it. */
  const listingEnabled = ready && !redirectPending;

  // The filter is NOT handed to `useDirectory`: it moved wholesale into
  // `flattenTree`, so there is exactly one implementation of it and it can
  // keep the ancestors of a nested match visible (§5.7).
  const directory = useDirectory({
    path: currentPath,
    showHidden,
    sortField,
    sortDirection,
    enabled: listingEnabled,
  });
  const tree = useTree({
    rootPath: currentPath,
    rootEntries: directory.entries,
    showHidden,
    sortField,
    sortDirection,
    query,
    enabled: listingEnabled,
  });
  const treeRef = useRef<UseTreeResult>(tree);
  treeRef.current = tree;

  /**
   * §8.4's optimistic move: the rows leave the screen the moment the drag is
   * dropped and come back if the backend refuses them. They stay hidden past
   * the answer, until the fresh listing that really drops them lands, so there
   * is no reappear-then-vanish flicker in between.
   */
  const [pendingMoved, setPendingMoved] = useState<readonly string[]>([]);
  const { rows, visiblePaths } = useMemo(() => {
    if (pendingMoved.length === 0) {
      return { rows: tree.rows, visiblePaths: tree.visiblePaths };
    }
    const hidden = (path: string): boolean =>
      pendingMoved.some((moved) => isSameOrDescendant(path, moved));
    const kept = tree.rows.filter((row) =>
      row.kind === "entry" ? !hidden(row.entry.path) : !hidden(row.parentPath),
    );
    return {
      rows: kept,
      visiblePaths: kept.flatMap((row) => (row.kind === "entry" ? [row.entry.path] : [])),
    };
  }, [pendingMoved, tree.rows, tree.visiblePaths]);

  /**
   * The gallery's own row set (§8.9): the current folder, nothing nested.
   *
   * The filter is applied here rather than in `useDirectory` for the same
   * reason the tree applies its own — one implementation per surface, and the
   * tree's has to keep the ancestors of a nested match visible, which a flat
   * grid has no use for. `useTree` keeps running while the gallery is up: it
   * is what the list comes back to, and its cached child listings survive the
   * trip.
   */
  const galleryEntries = useMemo(() => {
    if (!galleryView) return NO_ENTRIES;
    const matched =
      query.trim() === ""
        ? directory.entries
        : directory.entries.filter((entry) => matchesQuery(entry, query));
    if (pendingMoved.length === 0) return matched;
    return matched.filter(
      (entry) => !pendingMoved.some((moved) => isSameOrDescendant(entry.path, moved)),
    );
  }, [directory.entries, galleryView, pendingMoved, query]);

  const galleryPaths = useMemo(
    () => galleryEntries.map((entry) => entry.path),
    [galleryEntries],
  );

  // One short-lived URL per folder, and none at all while the list is up: the
  // list has no thumbnails to hang off it (§8.9).
  const previewBaseUrl = usePreviewBase({
    path: currentPath,
    enabled: galleryView && listingEnabled,
  });

  // A listing that lands is the authority on what is really gone: release the
  // optimistic set against it instead of holding rows hostage on an error.
  useEffect(() => {
    setPendingMoved((previous) => (previous.length === 0 ? previous : []));
  }, [directory.data]);

  // Selection is per *surface*: only the rows the active view actually paints
  // can be selected, so switching views prunes a selection the other view
  // could show but this one cannot (`useSelection` drops unknown paths).
  const selection = useSelection(galleryView ? galleryPaths : visiblePaths);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const clipboard = useClipboard();
  const uploads = useUploads();
  // §8.11. Independent of the bootstrap: the list is not about a folder, so it
  // does not have to wait for one, and the star is simply disabled until it
  // lands.
  const bookmarks = useBookmarks();
  const refetchRef = useRef(directory.refetch);
  refetchRef.current = directory.refetch;
  const directoryDataRef = useRef(directory.data);
  directoryDataRef.current = directory.data;
  const jobs = useJobs({
    onFinished: (job) => {
      if (job.state === "done") toast.success(`${job.label} finished`);
      else if (job.state === "failed") toast.error(job.errorMessage ?? `${job.label} failed`);
      refetchRef.current();
    },
    onVanished: () => {
      refetchRef.current();
    },
  });

  const writable = directory.data?.writable ?? true;
  const archiveSupport = state?.archiveSupport ?? DEFAULT_ARCHIVE_SUPPORT;
  // Built over the *flattened* rows, so every nested row is selectable,
  // openable and menu-addressable exactly like a top-level one.
  const rowByPath = useMemo(() => {
    const map = new Map<string, TreeEntryRow>();
    for (const row of rows) if (row.kind === "entry") map.set(row.entry.path, row);
    return map;
  }, [rows]);
  const rowByPathRef = useRef(rowByPath);
  rowByPathRef.current = rowByPath;
  /**
   * Path → entry for whatever the user can see right now. `rowByPath` above
   * stays list-only because it carries tree facts (depth, expanded) that the
   * gallery has no answer for; everything that only needs the *entry* — the
   * context menu, the selection, the keyboard's open and quick-look — reads
   * this instead, and so works identically in both views.
   */
  const entryByPath = useMemo(() => {
    const map = new Map<string, FileEntry>();
    if (galleryView) {
      for (const entry of galleryEntries) map.set(entry.path, entry);
      return map;
    }
    for (const [path, row] of rowByPath) map.set(path, row.entry);
    return map;
  }, [galleryEntries, galleryView, rowByPath]);
  const existingNames = useMemo(
    () => new Set((directory.data?.entries ?? []).map((entry) => entry.name)),
    [directory.data],
  );
  /**
   * Rename validates against the siblings of the row being renamed, which for
   * a nested row is a different directory than the one the panel is in.
   */
  const siblingNames = useCallback(
    (path: string): ReadonlySet<string> => {
      const parent = dirname(path);
      if (isSamePath(parent, currentPathRef.current)) return existingNames;
      const entries = treeRef.current.nodeEntries(parent);
      return entries === null
        ? new Set<string>()
        : new Set(entries.map((entry) => entry.name));
    },
    [existingNames],
  );
  const selectedEntries = useMemo(
    () =>
      selection.selectedPaths
        .map((path) => entryByPath.get(path))
        .filter((entry): entry is FileEntry => entry !== undefined),
    [selection.selectedPaths, entryByPath],
  );
  const canPaste = clipboard.canPasteInto(currentPath);
  // Stable across a pure expand/collapse so the memoised rows do not all
  // re-render; the relative "modified" column only needs a fresh clock when
  // the listing itself changed.
  const nowMs = useMemo(() => Date.now(), [directory.data]);

  /* -------------------------------------------------------------- */
  /* Location memory (§1)                                            */
  /* -------------------------------------------------------------- */

  /**
   * Remember the folder the backend *confirmed*, not the one the route names.
   *
   * `listDir` answers with the realpath'ed directory, so a route that went
   * through a symlink is remembered as the thing it actually opened — and a
   * route the backend refused never produces `directory.data` at all, which is
   * what stops a bad deep link from poisoning the memory for the next open.
   *
   * Tier 1 is written synchronously and tier 2 debounced, mirroring
   * `useTree`'s expanded set; the unmount flush below covers a folder opened
   * less than the debounce before the panel goes away.
   */
  useEffect(() => {
    const listed = directory.data?.path;
    if (!listingEnabled || listed === undefined || root === SEPARATOR) return;
    // A refetch — an `fs` signal, a reconnect, a finished job — re-delivers the
    // folder already recorded. Writing it again would be one `localStorage`
    // write per signal, and would undo the settings section's "Forget" button
    // the moment anything touched the folder on screen (§1.9).
    const written = lastFolderWrittenRef.current;
    if (written !== null && written.path === listed && written.root === root) return;
    const value: RememberedFolder = { path: listed, root };
    lastFolderWrittenRef.current = value;
    rememberLastFolder(value);
    lastFolderPendingRef.current = value;
    if (lastFolderTimerRef.current !== null) window.clearTimeout(lastFolderTimerRef.current);
    lastFolderTimerRef.current = window.setTimeout(() => {
      lastFolderTimerRef.current = null;
      lastFolderPendingRef.current = null;
      writeLastFolder(value);
    }, LAST_FOLDER_DEBOUNCE_MS);
  }, [directory.data, listingEnabled, root]);

  useEffect(
    () => () => {
      if (lastFolderTimerRef.current !== null) window.clearTimeout(lastFolderTimerRef.current);
      lastFolderTimerRef.current = null;
      const pending = lastFolderPendingRef.current;
      lastFolderPendingRef.current = null;
      if (pending !== null) writeLastFolder(pending);
    },
    [],
  );

  /**
   * The restore was optimistic (§1.6 (b)): the first `listDir` failure is how
   * the panel learns the remembered folder is gone. Only the codes that mean
   * "not there" count; anything else is a normal error with a retry.
   */
  const restoreFallbackCode: FileManagerErrorCode | null =
    restorePending !== null &&
    directory.error !== null &&
    directory.error.code !== null &&
    RESTORE_FALLBACK_CODES.has(directory.error.code) &&
    isSamePath(currentPath, restorePending)
      ? directory.error.code
      : null;

  /**
   * True only while the fallback is about to *move* the panel. When the
   * remembered folder is the start folder there is nowhere to go, and the
   * banner must render straight away instead of waiting for a listing that
   * will never be asked for.
   */
  const restoreFallbackMoves =
    restoreFallbackCode !== null &&
    state !== null &&
    !isSamePath(state.startFolder, currentPath);

  /**
   * The listing landed *for the restored folder*: the restore worked and
   * nothing else happens.
   *
   * The test is `directory.data.path`, not `currentPath`: between the route
   * changing and the new listing landing, `data` still holds the previous
   * folder's answer, so "the panel is standing on the restored path" would
   * disarm the fallback exactly one render before the failure it exists for.
   * A user navigation disarms it too, in `navigateTo`.
   */
  useEffect(() => {
    if (restorePending === null || directory.data === null) return;
    if (isSamePath(directory.data.path, restorePending)) setRestorePending(null);
  }, [directory.data, restorePending]);

  useEffect(() => {
    if (restoreFallbackCode === null || state === null || directory.error === null) return;
    setRestorePending(null);
    forgetLastFolder();
    lastFolderWrittenRef.current = null;
    // The remembered folder *is* the start folder — which is the case for
    // anyone who has opened the panel once with a start folder configured.
    // There is nowhere to fall back to: navigating would ask the host for the
    // route it is already on, no new listing would land, and the banner that
    // was held down for that listing would never come back up. Say nothing,
    // suppress nothing, and let the ordinary error banner offer its retry.
    if (!restoreFallbackMoves) return;
    // Hold the banner down until the folder we fall back to answers: the error
    // object survives the navigation and would flash for the new path.
    setSwallowedError(directory.error);
    locationRef.current.navigate(absoluteToSubPath(state.startFolder, state.root), {
      replace: true,
    });
    toast.message(
      restoreFallbackText(restoreFallbackCode, startFolderLabel(state.startFolder, state.root)),
    );
  }, [directory.error, restoreFallbackCode, restoreFallbackMoves, state]);

  // A different answer arrived: the suppression is over, whatever it says.
  useEffect(() => {
    if (swallowedError !== null && directory.error !== swallowedError) setSwallowedError(null);
  }, [directory.error, swallowedError]);

  /**
   * The caller's "reveal this file" (§10.2): a file-location opener names the
   * entry it resolved, and the same machinery the path bar uses selects it
   * once its folder is listed. Armed once — a re-render must not re-select a
   * row the user has since navigated away from.
   */
  const revealArmedRef = useRef(false);
  useEffect(() => {
    if (revealPath === null || state === null || revealArmedRef.current) return;
    revealArmedRef.current = true;
    const name = basename(revealPath);
    let since: ListDirResult | null = null;
    if (name.startsWith(".") && !showHiddenRef.current) {
      // State only, never `persist()` — same rule as the path bar's reveal.
      setShowHidden(true);
      since = directoryDataRef.current;
      toast.message(`Showing hidden files so ${name} is visible.`);
    }
    setPendingReveal({
      path: revealPath,
      dir: dirname(revealPath),
      name,
      since,
      extract: extractOnReveal,
    });
  }, [extractOnReveal, revealPath, state]);

  /**
   * The path bar's "reveal this file" (§5.3). It cannot select the row before
   * the row exists — `useSelection` prunes any path that is not visible — so
   * the request waits here until the new listing lands. The panel's existing
   * `selection.focus` effect does the scrolling.
   */
  useEffect(() => {
    const pending = pendingReveal;
    if (pending === null) return;
    if (visiblePaths.includes(pending.path)) {
      setPendingReveal(null);
      selectionRef.current.select(pending.path);
      const entry = pending.extract ? entryByPath.get(pending.path) : undefined;
      if (entry !== undefined && entry.archiveFormat !== null) setDialog({ kind: "extract", entry });
      return;
    }
    const data = directory.data;
    if (data === null || directory.isLoading || directory.isRefetching) return;
    if (!isSamePath(data.path, pending.dir)) return;
    if (pending.since !== null && data === pending.since && !data.truncated) return;
    setPendingReveal(null);
    toast.message(
      data.truncated
        ? `${pending.name} is in this folder, but the listing was cut off at ${String(
            state?.maxListEntries ?? MAX_LIST_ENTRIES,
          )} items. Use the filter to find it.`
        : `${pending.name} is not in this folder any more.`,
    );
  }, [
    directory.data,
    directory.isLoading,
    directory.isRefetching,
    entryByPath,
    pendingReveal,
    state,
    visiblePaths,
  ]);

  /* -------------------------------------------------------------- */
  /* Preferences                                                     */
  /* -------------------------------------------------------------- */

  const persist = useCallback(
    (values: Parameters<typeof rpc.call<"savePreferences">>[1]) => {
      void (async () => {
        try {
          await rpc.call("savePreferences", values);
        } catch (failure) {
          toast.error(errorToastText(failure, "Could not save your preferences."));
        }
      })();
    },
    [rpc],
  );

  const toggleHidden = useCallback(() => {
    setShowHidden((previous) => {
      persist({ showHiddenFiles: !previous });
      return !previous;
    });
  }, [persist]);

  const applySortField = useCallback(
    (field: SortField) => {
      setSortField(field);
      persist({ sortField: field });
    },
    [persist],
  );

  const applySortDirection = useCallback(
    (direction: SortDirection) => {
      setSortDirection(direction);
      persist({ sortDirection: direction });
    },
    [persist],
  );

  // Focus is deliberately left alone: the switch is always made from a
  // toolbar button or a menu item, so the grid never holds focus at that
  // moment, and yanking it out of the control the user is standing on would
  // be the rudest possible answer to a click.
  const applyViewMode = useCallback(
    (mode: ViewMode) => {
      setViewMode(mode);
      persist({ viewMode: mode });
    },
    [persist],
  );

  const handleHeaderSort = useCallback(
    (field: SortField) => {
      if (field === sortField) {
        const next: SortDirection = sortDirection === "asc" ? "desc" : "asc";
        setSortDirection(next);
        persist({ sortDirection: next });
        return;
      }
      setSortField(field);
      setSortDirection("asc");
      persist({ sortField: field, sortDirection: "asc" });
    },
    [persist, sortDirection, sortField],
  );

  /* -------------------------------------------------------------- */
  /* Navigation                                                      */
  /* -------------------------------------------------------------- */

  const navigateTo = useCallback((absolute: string) => {
    // Any move the user makes cancels a pending reveal, so a stale one cannot
    // steal the selection two folders later (§5.3). The reveal re-arms itself
    // straight after its own `navigateTo`, and the later `setState` wins.
    setPendingReveal(null);
    setRestorePending(null);
    // A move of the user's own outranks the bootstrap redirect: whatever the
    // host does with that redirect now, the listing gate must not stay shut.
    redirectFromRef.current = null;
    setRedirectPending(false);
    locationRef.current.navigate(absoluteToSubPath(absolute));
  }, []);

  const parentPath = directory.data?.parentPath ?? parentOf(currentPath, root);

  const goToParent = useCallback(() => {
    if (parentPath !== null) navigateTo(parentPath);
  }, [navigateTo, parentPath]);

  /* -------------------------------------------------------------- */
  /* Thread folder (§10.3)                                           */
  /* -------------------------------------------------------------- */

  const workspace = useThreadWorkspace(threadId);
  // Read from the click handler, which must stay stable: it is handed to the
  // memoized action cluster, and the lookup settles after the first render.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  /**
   * Jump to the thread's own checkout, through the same `navigateTo` every
   * other move uses — a second navigation path would be a second set of bugs.
   *
   * A "no" the lookup already knows about never reaches this handler: the
   * button is not rendered then. What does reach it is a lookup that *failed*,
   * because "bb did not answer" is not "there is nowhere to go" — so the click
   * retries once, and only a second failure becomes a toast.
   */
  const openThreadWorkspace = useCallback(() => {
    void (async () => {
      const current = workspaceRef.current;
      const answer =
        current.state.status === "ready" ? current.state : await current.reload();
      if (answer.status === "ready") {
        navigateTo(answer.path);
        return;
      }
      if (answer.status === "blocked") {
        toast.message(threadWorkspaceBlockedText(answer.reason));
        return;
      }
      if (answer.status === "failed") {
        toast.error(`Could not find this thread's folder. ${answer.message}`);
      }
    })();
  }, [navigateTo]);

  const threadFolder = useMemo<ThreadFolderAction | null>(() => {
    // Nothing for a surface with no thread — and nothing yet while the lookup
    // is in flight, because a control that appears only to vanish half a tick
    // later reads worse than one that arrives late.
    const status = workspace.state.status;
    if (status === "absent" || status === "loading") return null;
    return {
      available: status !== "blocked",
      blockedReason:
        workspace.state.status === "blocked"
          ? threadWorkspaceBlockedText(workspace.state.reason)
          : null,
      onOpen: openThreadWorkspace,
    };
  }, [openThreadWorkspace, workspace.state]);

  /* -------------------------------------------------------------- */
  /* Path bar (§3, §5)                                               */
  /* -------------------------------------------------------------- */

  /** Open, or re-select when it is already open — a browser's address bar. */
  const openPathBar = useCallback(() => {
    // Compact chrome shows the path bar *or* the unfolded filter, never both,
    // so opening one has to fold the other away — otherwise Ctrl+L would put
    // the panel into path-editing with no field on screen to edit.
    if (searchOpenRef.current) {
      setSearchOpen(false);
      setQuery("");
    }
    if (!pathEditingRef.current) setPathError(null);
    pathEditingRef.current = true;
    setPathEditing(true);
    setPathFocusTick((tick) => tick + 1);
  }, []);

  const closePathBar = useCallback((focusGrid: boolean) => {
    pathEditingRef.current = false;
    setPathEditing(false);
    setPathError(null);
    // Leaving edit mode drops a commit that is still in flight: the answer to
    // a path the user has walked away from must not navigate behind them.
    // (The success path closes the bar *after* it navigates, so its own
    // ticket going stale here costs nothing.)
    pathTicketRef.current += 1;
    setPathBusy(false);
    // Focus never lands on <body>: the grid is the panel's one keyboard widget.
    if (focusGrid) focusSurface();
  }, [focusSurface]);

  const handlePathCancel = useCallback(
    (options: { focusGrid: boolean }) => {
      closePathBar(options.focusGrid);
    },
    [closePathBar],
  );

  const handlePathDirty = useCallback(() => {
    setPathError((previous) => (previous === null ? previous : null));
  }, []);

  /**
   * Enter in the path bar. A folder navigates; a file navigates to its folder
   * and reveals it. Nothing here ever *opens* a file — `openEntry` downloads,
   * and pasting a path must not start a download nobody asked for (§5.2).
   */
  const submitPath = useCallback(
    (raw: string) => {
      const parsed = parsePathInput(raw, { root, currentPath: currentPathRef.current });
      if (parsed.kind === "empty") {
        closePathBar(true);
        return;
      }
      if (parsed.kind === "refused") {
        // Refused on the client: no RPC at all, and the caret stays put.
        setPathError(parsed.message);
        return;
      }
      const typed = parsed.absolute;
      const ticket = (pathTicketRef.current += 1);
      setPathBusy(true);
      void (async () => {
        try {
          const result = await rpc.call("statPath", { path: typed });
          // A second Enter, or an edit and re-submit, can never produce two
          // navigations: only the newest ticket may act.
          if (pathTicketRef.current !== ticket) return;
          const entry = result.entry;
          if (entry.escapesRoot) {
            // `escapesRoot` is also what a broken or looping link answers with:
            // `src/listing.ts#entryFrom` sets it when realpath *throws*, and
            // the wire carries no way to tell that apart from a link that
            // really resolves outside the root. One sentence has to be true of
            // both, so it says what is certain — the link leads nowhere this
            // panel can open (§5.2).
            setPathError(`That link does not lead anywhere inside ${rootPhrase(root)}.`);
            return;
          }
          if (effectiveKind(entry) === "directory") {
            // A symlink to a directory navigates to the link's own path, which
            // is what double-clicking that row already does; `listDir` then
            // answers with the realpath and the crumbs settle on the target.
            // Committing the folder already on screen is a no-op, not a
            // history step that a later Back would spend doing nothing (§5.1).
            if (isSamePath(entry.path, currentPathRef.current)) setPendingReveal(null);
            else navigateTo(entry.path);
            closePathBar(true);
            return;
          }
          // Only the root has `parentPath: null`, and the root is a directory.
          const dir = result.parentPath ?? dirname(entry.path);
          // Two things can hide the row before it is even asked for.
          if (queryRef.current !== "") setQuery("");
          let since: ListDirResult | null = null;
          if (entry.isHidden && !showHiddenRef.current) {
            // State only — never `persist()`. Silently rewriting a stored
            // preference is worse than the empty-looking folder it prevents.
            setShowHidden(true);
            since = directoryDataRef.current;
            toast.message(`Showing hidden files so ${entry.name} is visible.`);
          }
          // Same rule for a file: revealing a row in the folder already on
          // screen is a selection, not a navigation.
          if (!isSamePath(dir, currentPathRef.current)) navigateTo(dir);
          setPendingReveal({ path: entry.path, dir, name: entry.name, since, extract: false });
          closePathBar(true);
        } catch (failure) {
          if (pathTicketRef.current !== ticket) return;
          setPathError(pathCommitErrorText(failure, typed, root));
        } finally {
          if (pathTicketRef.current === ticket) setPathBusy(false);
        }
      })();
    },
    [closePathBar, navigateTo, root, rpc],
  );

  /* -------------------------------------------------------------- */
  /* Mutations                                                       */
  /* -------------------------------------------------------------- */

  const applyBatch = useCallback(
    (
      result: BatchResult,
      operation: "move" | "copy" | "delete",
      retry?: { destinationDir: string },
    ) => {
      const conflicts = result.failed.filter((failure) => failure.code === "exists");
      if (conflicts.length > 0 && retry !== undefined && operation !== "delete") {
        setDialog({
          kind: "conflict",
          operation,
          destinationDir: retry.destinationDir,
          paths: conflicts.map((conflict) => conflict.path),
          conflicts,
        });
      } else if (result.failed.length > 0) {
        const text = batchFailureText(result.failed, operation);
        if (text !== null) toast.error(text);
      }
      // Delete and move both consume their sources: `succeeded` echoes the
      // caller's own paths (src/mutations.ts), which is exactly what the tree
      // is keyed on. A move cannot be re-keyed — with `conflict: "rename"` the
      // destination base name is unknown — so it collapses instead (§5.4).
      if (operation !== "copy") treeRef.current.pruneSubtree(result.succeeded);
      refetchRef.current();
    },
    [],
  );

  const moveTo = useCallback(
    (paths: readonly string[], destinationDir: string) => {
      const targets = topLevelPaths(paths).filter(
        (path) => !isSamePath(dirname(path), destinationDir),
      );
      if (targets.length === 0) return;
      const restore = (only?: ReadonlySet<string>): void => {
        setPendingMoved((previous) =>
          previous.filter(
            (path) => !targets.includes(path) || (only !== undefined && !only.has(path)),
          ),
        );
      };
      void (async () => {
        // §8.4: the rows go the moment the drop happens, not a round trip later.
        setPendingMoved((previous) => [...previous, ...targets]);
        try {
          const result = await rpc.call("moveEntries", {
            paths: [...targets],
            destinationDir,
            conflict: "fail",
          });
          // Whatever the backend refused (a conflict included) comes straight
          // back; what it moved stays hidden until the refetch confirms it.
          restore(new Set(result.failed.map((failure) => failure.path)));
          applyBatch(result, "move", { destinationDir });
        } catch (failure) {
          restore();
          toast.error(errorToastText(failure, "Could not move those items."));
        }
      })();
    },
    [applyBatch, rpc],
  );

  const copyTo = useCallback(
    (paths: readonly string[], destinationDir: string) => {
      void (async () => {
        try {
          const result = await rpc.call("copyEntries", {
            paths: topLevelPaths(paths),
            destinationDir,
            conflict: "rename",
          });
          applyBatch(result, "copy");
        } catch (failure) {
          toast.error(errorToastText(failure, "Could not copy those items."));
        }
      })();
    },
    [applyBatch, rpc],
  );

  const deleteEntries = useCallback(
    async (entries: readonly FileEntry[]): Promise<void> => {
      if (entries.length === 0) return;
      try {
        const result = await rpc.call("deleteEntries", {
          paths: entries.map((entry) => entry.path),
          recursive: true,
        });
        applyBatch(result, "delete");
      } catch (failure) {
        toast.error(errorToastText(failure, "Could not delete those items."));
      }
    },
    [applyBatch, rpc],
  );

  const requestDelete = useCallback(
    (entries: readonly FileEntry[]) => {
      // Deleting a folder already removes its children; sending both would
      // come back as `not_found` on the child (§4.5).
      const keep = new Set(topLevelPaths(entries.map((entry) => entry.path)));
      const targets = entries.filter((entry) => keep.has(entry.path));
      if (targets.length === 0) return;
      if (confirmOnDelete) {
        setDialog({ kind: "delete", entries: targets });
        return;
      }
      void deleteEntries(targets);
    },
    [confirmOnDelete, deleteEntries],
  );

  const paste = useCallback(() => {
    const pending = clipboard.clipboard;
    if (pending === null) return;
    const destinationDir = currentPathRef.current;
    void (async () => {
      try {
        const result = await clipboard.paste(destinationDir);
        if (result === null) return;
        applyBatch(result, pending.mode === "cut" ? "move" : "copy", { destinationDir });
      } catch (failure) {
        toast.error(errorToastText(failure, "Could not paste here."));
      }
    })();
  }, [applyBatch, clipboard]);

  const copyPathsToClipboard = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    void (async () => {
      const ok = await writeClipboardText(paths.join("\n"));
      if (ok) toast.success(paths.length === 1 ? "Path copied" : `${String(paths.length)} paths copied`);
      else toast.error("This browser did not allow copying to the clipboard.");
    })();
  }, []);

  const downloadSelection = useCallback((entries: readonly FileEntry[]) => {
    const files = entries.filter(
      (entry) => !entry.escapesRoot && effectiveKind(entry) === "file",
    );
    if (files.length === 0) {
      toast.error("Folders cannot be downloaded in this version.");
      return;
    }
    if (files.length === 1 && files[0] !== undefined) {
      downloadEntry(files[0]);
      return;
    }
    void downloadPaths(files.map((entry) => entry.path));
  }, []);

  /**
   * "Add to chat" — one @-mention pill per selected file (§8.8).
   *
   * The pill carries the path, not the bytes: the backend's mention provider
   * re-reads the file when the message is actually sent, so a file edited (or
   * deleted) between picking and sending is not silently stale. Folders and
   * links that leave the root are dropped rather than refused one by one —
   * the menu item is disabled when the selection holds nothing else.
   */
  const addToChat = useCallback((entries: readonly FileEntry[]) => {
    const files = entries.filter(isFileEntry);
    if (files.length === 0) {
      toast.error("Only files can be added to the chat.");
      return;
    }
    for (const file of files) {
      composerRef.current.insertMention({
        provider: MENTION_PROVIDER_ID,
        id: file.path,
        label: file.name,
      });
    }
    toast.success(
      files.length === 1 && files[0] !== undefined
        ? `${files[0].name} added to the chat`
        : `${String(files.length)} files added to the chat`,
    );
  }, []);

  /**
   * Opening a file (double-click, or Enter) shows it in bb's preview panel
   * beside the manager rather than downloading it (§8.2).
   *
   * bb addresses a live file by host id, which is why `getState` carries the
   * machine bb runs on. Everything that can go wrong here answers `false`
   * rather than throwing: no host id (an older server, or a config call that
   * failed), no preview surface on this client, or a host that declined the
   * open. `showEntry` turns that `false` into the built-in viewer (§8.12) —
   * which is the ordinary case, not the exception, because the sidebar's own
   * File Manager page is a surface bb wires no preview panel into.
   */
  const previewEntry = useCallback(
    (entry: FileEntry): boolean => {
      const hostId = stateRef.current?.primaryHostId ?? null;
      if (hostId === null) return false;
      const open = navigateRef.current?.experimental_openFilePreview;
      if (typeof open !== "function") return false;
      try {
        return open({
          target: { kind: "host", hostId, path: entry.path },
          location: null,
        });
      } catch {
        // A throwing host must not take the panel's UI down with it.
        return false;
      }
    },
    [],
  );

  /**
   * Show one file: bb's shared preview panel when this surface has one, the
   * built-in viewer when it does not (§8.12).
   *
   * The order is not a preference for our own dialog — it is the opposite.
   * bb's panel sits *beside* the manager and survives navigation, so it wins
   * wherever it exists; the viewer is what the standalone page gets, where
   * the alternative was silently dropping the file in ~/Downloads.
   */
  const showEntry = useCallback(
    (entry: FileEntry) => {
      if (previewEntry(entry)) return;
      setDialog({ kind: "view", entry });
    },
    [previewEntry],
  );

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.escapesRoot) {
        toast.error(`Link points outside ${root}`);
        return;
      }
      const kind = effectiveKind(entry);
      if (kind === "directory") {
        navigateTo(entry.path);
        return;
      }
      if (entry.archiveFormat !== null) {
        // An archive has nothing to read; extracting it is the useful open.
        setDialog({ kind: "extract", entry });
        return;
      }
      if (!isViewableEntry(entry)) {
        // A socket, a fifo, a device node: there is no content to show, and
        // the bytes are still the one thing that can be handed over.
        downloadEntry(entry);
        return;
      }
      showEntry(entry);
    },
    [navigateTo, root, showEntry],
  );

  const startExtract = useCallback(
    async (submission: ExtractSubmission): Promise<void> => {
      const result = await rpc.call("extractArchive", {
        archivePath: submission.entry.path,
        destinationDir: submission.destinationDir,
        createSubfolder: submission.createSubfolder,
        conflict: "rename",
      });
      jobs.track(result.job);
    },
    [jobs, rpc],
  );

  // Same write the settings section performs (lib/start-folder.ts) — the panel
  // just reports it as a toast instead of inline text.
  const setStartFolder = useCallback(
    (path: string) => {
      void (async () => {
        try {
          await saveStartFolder(rpc, path);
          toast.success(START_FOLDER_SAVED_TEXT);
        } catch (failure) {
          toast.error(errorToastText(failure, START_FOLDER_SAVE_FAILED_TEXT));
        }
      })();
    },
    [rpc],
  );

  /* -------------------------------------------------------------- */
  /* Bookmarks (§8.11)                                               */
  /* -------------------------------------------------------------- */

  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;

  /**
   * Add or remove, whichever the folder needs.
   *
   * The full-list refusal is spoken here rather than let through to the
   * backend's `unsupported`: the panel knows the count and can say what to do
   * about it, and a round trip to be told "no" is a round trip wasted.
   */
  const toggleBookmark = useCallback((path: string) => {
    const state = bookmarksRef.current;
    if (path === "" || state.loading) return;
    if (state.isBookmarked(path)) {
      void state.remove(path).catch((failure: unknown) => {
        toast.error(errorToastText(failure, BOOKMARK_REMOVE_FAILED_TEXT));
      });
      return;
    }
    if (state.full) {
      toast.error(BOOKMARKS_FULL_TEXT);
      return;
    }
    void state.add(path).catch((failure: unknown) => {
      toast.error(errorToastText(failure, BOOKMARK_ADD_FAILED_TEXT));
    });
  }, []);

  /** The list's own "this folder is gone" row; see components/BookmarksMenu.tsx. */
  const removeBookmark = useCallback((path: string) => {
    void bookmarksRef.current.remove(path).catch((failure: unknown) => {
      toast.error(errorToastText(failure, BOOKMARK_REMOVE_FAILED_TEXT));
    });
  }, []);

  const openBookmarkRename = useCallback((path: string) => {
    const bookmark = findBookmark(bookmarksRef.current.bookmarks, path);
    if (bookmark === null) return;
    setDialog({ kind: "bookmark-name", path: bookmark.path, name: bookmark.name });
  }, []);

  /* -------------------------------------------------------------- */
  /* Uploads                                                         */
  /* -------------------------------------------------------------- */

  const enqueueUploads = useCallback(
    (requests: readonly UploadRequest[]) => {
      if (requests.length === 0) return;
      uploads.enqueue(requests);
    },
    [uploads],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** Manual refresh: the current directory *and* every cached child listing. */
  const handleRefresh = useCallback(() => {
    treeRef.current.refreshAll();
    refetchRef.current();
  }, []);

  /* -------------------------------------------------------------- */
  /* Selection / mouse                                               */
  /* -------------------------------------------------------------- */

  const handleRowClick = useCallback(
    (entry: FileEntry, event: ReactMouseEvent<HTMLElement>) => {
      focusSurface();
      selectionRef.current.handleRowClick(entry.path, {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
    },
    [focusSurface],
  );

  const handleToggleSelect = useCallback((entry: FileEntry) => {
    selectionRef.current.toggle(entry.path);
  }, []);

  /** Chevron: expansion only. Selection and anchor stay where they were. */
  const handleToggleExpand = useCallback(
    (entry: FileEntry) => {
      focusSurface();
      selectionRef.current.setFocus(entry.path);
      treeRef.current.toggle(entry);
    },
    [focusSurface],
  );

  const handleRetryNode = useCallback((path: string) => {
    treeRef.current.reload(path);
  }, []);

  const handleCollapseAll = useCallback(() => {
    treeRef.current.collapseAll();
  }, []);

  const handleBackgroundClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-fm-path]") !== null) return;
      selection.clear();
    },
    [selection],
  );

  const handleRowContextMenu = useCallback((entry: FileEntry) => {
    contextRowRef.current = entry.path;
    const current = selectionRef.current;
    if (!current.isSelected(entry.path)) current.select(entry.path);
  }, []);

  const handleContainerContextMenu = useCallback(() => {
    const path = contextRowRef.current;
    contextRowRef.current = null;
    setContextTarget(path);
  }, []);

  const menuEntries = useMemo(() => {
    if (contextTarget === null) return [];
    if (selection.selected.has(contextTarget) && selectedEntries.length > 0) return selectedEntries;
    const entry = entryByPath.get(contextTarget);
    return entry === undefined ? [] : [entry];
  }, [contextTarget, entryByPath, selectedEntries, selection.selected]);

  /**
   * Properties (§8.10), from either menu and from `Alt+Enter`. Rows describe
   * themselves; an empty list describes the folder on screen, which is the
   * only thing the empty-space menu has to talk about.
   */
  const openProperties = useCallback((entries: readonly FileEntry[]) => {
    setDialog(
      entries.length > 0
        ? { kind: "properties", target: { kind: "entries", entries: [...entries] } }
        : { kind: "properties", target: { kind: "path", path: currentPathRef.current } },
    );
  }, []);

  /* -------------------------------------------------------------- */
  /* Drag & drop (§8.4)                                              */
  /* -------------------------------------------------------------- */

  const dropTargetFor = useCallback((entry: FileEntry): string | null => {
    if (entry.escapesRoot) return null;
    if (effectiveKind(entry) === "directory") return entry.path;
    // A file row inside an expanded folder resolves to that folder, not to the
    // current directory — otherwise a drop on `docs/inner.txt` would land in
    // `~`. At depth 0 this still returns null, i.e. today's behaviour.
    const row = rowByPathRef.current.get(entry.path);
    return row !== undefined && row.depth > 0 ? row.parentPath : null;
  }, []);

  /* Spring-loaded folders: dwell over a collapsed folder during a drag and it
     opens, so a nested destination is reachable without dropping first. */
  const hoverExpandRef = useRef<{ path: string; timer: number } | null>(null);

  const clearHoverExpand = useCallback((path?: string) => {
    const pending = hoverExpandRef.current;
    if (pending === null) return;
    if (path !== undefined && pending.path !== path) return;
    window.clearTimeout(pending.timer);
    hoverExpandRef.current = null;
  }, []);

  const scheduleHoverExpand = useCallback(
    (entry: FileEntry) => {
      const row = rowByPathRef.current.get(entry.path);
      if (row === undefined || !row.expandable || row.expanded) {
        clearHoverExpand();
        return;
      }
      if (hoverExpandRef.current?.path === entry.path) return;
      clearHoverExpand();
      const path = entry.path;
      const timer = window.setTimeout(() => {
        hoverExpandRef.current = null;
        treeRef.current.expand(path);
      }, AUTO_EXPAND_HOVER_MS);
      hoverExpandRef.current = { path, timer };
    },
    [clearHoverExpand],
  );

  useEffect(() => () => clearHoverExpand(), [clearHoverExpand]);

  const handleRowDragStart = useCallback(
    (entry: FileEntry, event: ReactDragEvent<HTMLElement>) => {
      if (entry.escapesRoot) {
        event.preventDefault();
        return;
      }
      const current = selectionRef.current;
      let paths = topLevelPaths(current.selectedPaths);
      if (!current.isSelected(entry.path)) {
        current.select(entry.path);
        paths = [entry.path];
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
      event.dataTransfer.setData("text/plain", paths.join("\n"));
    },
    [],
  );

  const handleRowDragOver = useCallback(
    (entry: FileEntry, event: ReactDragEvent<HTMLElement>) => {
      const target = dropTargetFor(entry);
      if (target === null) return;
      const external = isExternalDrag(event);
      if (!external) {
        const dragged = selectionRef.current;
        if (dragged.isSelected(entry.path)) return;
        // A folder can never be dropped into itself or into one of its own
        // descendants — now reachable on screen, so it must not even
        // highlight (SPEC §8.4).
        if (dragged.selectedPaths.some((path) => isSameOrDescendant(target, path))) return;
      }
      scheduleHoverExpand(entry);
      pendingDropTargetRef.current = target;
      event.preventDefault();
      event.dataTransfer.dropEffect = external ? "copy" : "move";
    },
    [dropTargetFor, scheduleHoverExpand],
  );

  const handleRowDragLeave = useCallback(
    (entry: FileEntry, event: ReactDragEvent<HTMLElement>) => {
      // The browser fires `dragleave` for every hop between the nested
      // elements of one row (td → div → span). Restarting the spring-load
      // dwell on those would make a 700 ms hover unreachable for anyone whose
      // hand is not perfectly still.
      const related = event.relatedTarget;
      if (related instanceof Node && event.currentTarget.contains(related)) return;
      clearHoverExpand(entry.path);
    },
    [clearHoverExpand],
  );

  const handleTargetDragOver = useCallback((path: string, event: ReactDragEvent<HTMLElement>) => {
    pendingDropTargetRef.current = path;
    event.preventDefault();
    event.dataTransfer.dropEffect = isExternalDrag(event) ? "copy" : "move";
  }, []);

  const noopDragHandler = useCallback(() => undefined, []);

  const handleRootDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const pending = pendingDropTargetRef.current;
      pendingDropTargetRef.current = null;
      const external = isExternalDrag(event);
      if (external) {
        // Without preventDefault the browser navigates to the dropped file and
        // the panel is gone (§8.4).
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setExternalDrag(true);
      }
      setDropTarget(pending ?? (external ? currentPathRef.current : null));
    },
    [],
  );

  const handleRootDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    dragDepthRef.current += 1;
    if (isExternalDrag(event)) {
      event.preventDefault();
      setExternalDrag(true);
    }
  }, []);

  const handleRootDragLeave = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      // A hop between two elements *inside* the panel is not a leave, whatever
      // the enter/leave counter says: the counter drifts whenever a row is
      // re-rendered away under the pointer, and a drifted counter cancels the
      // spring-load dwell and the drop highlight mid-drag.
      const related = event.relatedTarget;
      if (related instanceof Node && event.currentTarget.contains(related)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        clearHoverExpand();
        setExternalDrag(false);
        setDropTarget(null);
      }
    },
    [clearHoverExpand],
  );

  const handleRootDragEnd = useCallback(() => {
    dragDepthRef.current = 0;
    clearHoverExpand();
    setExternalDrag(false);
    setDropTarget(null);
  }, [clearHoverExpand]);

  const handleRootDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      const pending = pendingDropTargetRef.current;
      pendingDropTargetRef.current = null;
      const destination = pending ?? dropTarget ?? currentPathRef.current;
      clearHoverExpand();
      dragDepthRef.current = 0;
      setExternalDrag(false);
      setDropTarget(null);

      if (isExternalDrag(event)) {
        const entries = snapshotDropEntries(event.dataTransfer);
        if (entries === null) {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          toast.message("Folder upload is not supported in this browser — drop individual files.");
          enqueueUploads(files.map((file) => ({ file, dirPath: destination, relativeDir: "" })));
          return;
        }
        void (async () => {
          const collected: { file: File; relativeDir: string }[] = [];
          for (const entry of entries) await walkDropEntry(entry, "", collected);
          enqueueUploads(
            collected.map((item) => ({
              file: item.file,
              dirPath: destination,
              relativeDir: item.relativeDir,
            })),
          );
        })();
        return;
      }

      const paths = readDraggedPaths(event.dataTransfer);
      if (paths.length === 0) return;
      moveTo(paths, destination);
    },
    [clearHoverExpand, dropTarget, enqueueUploads, moveTo],
  );

  /* -------------------------------------------------------------- */
  /* Keyboard map (§8.3)                                             */
  /* -------------------------------------------------------------- */

  const rowElement = useCallback((path: string | null): HTMLElement | null => {
    const container = scrollRef.current;
    if (path === null || container === null) return null;
    const escaped = path.replace(/["\\]/gu, "\\$&");
    const row = container.querySelector(`[data-fm-path="${escaped}"]`);
    return row instanceof HTMLElement ? row : null;
  }, []);

  const focusRow = useCallback(
    (path: string | null) => {
      rowElement(path)?.scrollIntoView({ block: "nearest" });
    },
    [rowElement],
  );

  /**
   * `Shift+F10` / the Menu key. Both context menus hang off the scroll
   * container, which never holds focus (the panel root does), so the browser's
   * own `contextmenu` event never reaches the Radix trigger. Synthesize it on
   * the focused row — the row handler then fills the menu exactly like a right
   * click would, and Radix positions the menu over that row.
   */
  const openKeyboardContextMenu = useCallback(
    (path: string | null) => {
      const container = scrollRef.current;
      if (container === null) return;
      const target = rowElement(path) ?? container;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(rect.left + 8),
          clientY: Math.round(rect.top + rect.height / 2),
        }),
      );
    },
    [rowElement],
  );

  useEffect(() => {
    focusRow(selection.focus);
  }, [focusRow, selection.focus]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // A dialog, a context menu and a dropdown all render through a portal,
      // so their keystrokes bubble up the *React* tree to this handler while
      // their DOM lives outside the panel. None of them are the panel's to
      // read: Ctrl+L would open the path bar behind the modal and steal the
      // focus its focus-trap is holding (§7.2).
      const panel = rootRef.current;
      if (panel !== null && event.target instanceof Node && !panel.contains(event.target)) return;
      // The one shortcut handled *above* the typing-target guard (§7.2):
      // Ctrl/Cmd+L has to work from the filter box and from the path input
      // itself, which is the behaviour of the thing it imitates. Nothing else
      // moves above this line.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === "l" || event.key === "L")
      ) {
        event.preventDefault();
        openPathBar();
        return;
      }
      if (isTypingTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      const focusedRow = selection.focus === null ? undefined : rowByPath.get(selection.focus);
      // From `entryByPath`, not from `focusedRow`: the gallery has no tree
      // rows, and everything below that only needs the entry must work there
      // too. In the list the two are the same object.
      const focusedEntry = selection.focus === null ? undefined : entryByPath.get(selection.focus);

      if (mod && event.shiftKey && (event.key === "." || event.key === ">")) {
        event.preventDefault();
        toggleHidden();
        return;
      }
      if (mod && event.shiftKey && (event.key === "N" || event.key === "n")) {
        event.preventDefault();
        if (writable) setDialog({ kind: "new-folder" });
        return;
      }
      if (!mod && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        event.preventDefault();
        openKeyboardContextMenu(selection.focus);
        return;
      }
      // `Alt+Enter` is the OS-wide properties gesture (§8.3), and it has to be
      // read here rather than in the switch below — that switch's `Enter` case
      // opens the focused row, and it does not look at `altKey`.
      if (event.altKey && !mod && !event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        openProperties(selectedEntries);
        return;
      }
      if (mod && !event.shiftKey) {
        switch (event.key) {
          case "a":
          case "A":
            event.preventDefault();
            selection.selectAll();
            return;
          case "x":
          case "X":
            event.preventDefault();
            clipboard.cut(topLevelPaths(selection.selectedPaths));
            return;
          case "c":
          case "C":
            event.preventDefault();
            clipboard.copy(topLevelPaths(selection.selectedPaths));
            return;
          case "v":
          case "V":
            event.preventDefault();
            paste();
            return;
          case "f":
          case "F":
            event.preventDefault();
            // Folded away in compact chrome: unfold first, and let the effect
            // below focus the field once it is on screen.
            if (inlineChrome && !searchOpenRef.current) {
              setSearchOpen(true);
              return;
            }
            searchRef.current?.focus();
            searchRef.current?.select();
            return;
          default:
            break;
        }
        return;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          selection.moveFocus(1, event.shiftKey);
          return;
        case "ArrowUp":
          event.preventDefault();
          selection.moveFocus(-1, event.shiftKey);
          return;
        case "Home":
          event.preventDefault();
          selection.focusEdge("start", event.shiftKey);
          return;
        case "End":
          event.preventDefault();
          selection.focusEdge("end", event.shiftKey);
          return;
        case "Enter":
          if (focusedEntry !== undefined) {
            event.preventDefault();
            openEntry(focusedEntry);
          }
          return;
        case " ": {
          /* Quick look (§8.9): the preview a double-click opens, without
             leaving the keyboard. */
          // Space is the activation key of whatever control has focus, and
          // that meaning wins: a press on the toolbar's Refresh must not
          // refresh *and* open a preview from one keystroke.
          if (isActivationTarget(event.target)) return;
          // With no row under the cursor there is nothing to look at, and
          // Space is still the browser's page-down over the listing.
          if (focusedEntry === undefined) return;
          // Claimed before the outcome is known: whatever the row turns out to
          // be, scrolling the listing out from under the cursor is not it.
          event.preventDefault();
          // A folder is Enter's business, not quick look's — there is nothing
          // to read, and opening it would make Space a second Enter. A link
          // that leaves the root is not readable through this plugin at all.
          if (!isViewableEntry(focusedEntry)) return;
          // Still no download fallback, unlike `openEntry`: a peek that
          // silently puts a file in the downloads folder is not a peek. What
          // 0.7 could not do is the rest of it — a surface with no preview
          // panel got nothing at all, and now gets the built-in viewer.
          showEntry(focusedEntry);
          return;
        }
        case "Backspace":
          event.preventDefault();
          goToParent();
          return;
        case "ArrowRight": {
          // `Alt+ArrowRight` is the host's history-forward gesture, exactly
          // like `Alt+ArrowLeft` below — leave it alone (§8.3).
          if (event.altKey) return;
          // In the gallery the rows run left to right, so left/right are the
          // previous and next tile. There is no tree there to expand into.
          if (galleryView) {
            event.preventDefault();
            selection.moveFocus(1, event.shiftKey);
            return;
          }
          // Tree semantics only: open the folder, else step into it. Never
          // preventDefault for a row that has nothing to open (§8.3).
          if (focusedRow === undefined || !focusedRow.expandable) return;
          if (!focusedRow.expanded) {
            event.preventDefault();
            tree.expand(focusedRow.entry.path);
            return;
          }
          // Step *into* the folder only when a child row is really on screen.
          // Children arrive asynchronously, and an empty or filtered-away
          // folder never gets any, so a blind moveFocus(1) walks past the
          // folder the user is trying to enter and onto its next sibling.
          const index = rows.indexOf(focusedRow);
          const next = index < 0 ? undefined : rows[index + 1];
          if (next?.kind === "entry" && isSamePath(next.parentPath, focusedRow.entry.path)) {
            event.preventDefault();
            selection.moveFocus(1);
          }
          return;
        }
        case "ArrowLeft":
          // `Alt+ArrowLeft` (and `Backspace`) stay "go up a directory"; the
          // bare key collapses, or walks to the parent *row*.
          if (event.altKey) {
            event.preventDefault();
            goToParent();
            return;
          }
          if (galleryView) {
            event.preventDefault();
            selection.moveFocus(-1, event.shiftKey);
            return;
          }
          if (focusedRow === undefined) return;
          if (focusedRow.expandable && focusedRow.expanded) {
            event.preventDefault();
            tree.collapse(focusedRow.entry.path);
            return;
          }
          if (focusedRow.depth > 0) {
            event.preventDefault();
            selection.select(focusedRow.parentPath);
          }
          return;
        case "F2":
          if (selectedEntries.length === 1 && selectedEntries[0] !== undefined) {
            event.preventDefault();
            setDialog({ kind: "rename", entry: selectedEntries[0] });
          }
          return;
        case "Delete":
          if (selectedEntries.length > 0) {
            event.preventDefault();
            requestDelete(selectedEntries);
          }
          return;
        case "Escape":
          // §8.3: "clear search box if focused, else clear selection". The box
          // clears itself (Toolbar stops the event there), so by the time the
          // panel sees an Escape the focus is elsewhere and it belongs to the
          // selection — clearing the filter here would strand the selection.
          if (selection.count > 0) {
            event.preventDefault();
            selection.clear();
          }
          return;
        default:
          // Never preventDefault on keys we do not handle (§8.3).
          return;
      }
    },
    [
      clipboard,
      entryByPath,
      galleryView,
      goToParent,
      openEntry,
      openKeyboardContextMenu,
      openPathBar,
      openProperties,
      paste,
      showEntry,
      inlineChrome,
      requestDelete,
      rowByPath,
      rows,
      selectedEntries,
      selection,
      toggleHidden,
      tree,
      writable,
    ],
  );

  /* -------------------------------------------------------------- */
  /* Title-bar bridge                                                */
  /* -------------------------------------------------------------- */

  /**
   * Only the nav panel is on the bus. A panel tab renders the very same
   * actions inside its toolbar, and publishing from both would leave the title
   * bar describing whichever surface rendered last — while a header click
   * would run in both.
   */
  const snapshot: PanelSnapshot = useMemo(
    () => ({
      currentPath,
      writable,
      ready: listingEnabled,
      showHidden,
      selectionCount: selection.count,
      canPaste,
    }),
    [canPaste, currentPath, listingEnabled, selection.count, showHidden, writable],
  );

  useEffect(() => {
    if (inlineChrome) return;
    publishPanelSnapshot(snapshot);
  }, [inlineChrome, snapshot]);

  useEffect(() => {
    if (inlineChrome) return;
    return resetPanelSnapshot;
  }, [inlineChrome]);

  const commandRef = useRef<(command: PanelCommand) => void>(() => undefined);
  commandRef.current = (command) => {
    switch (command.type) {
      case "upload":
        openFilePicker();
        return;
      case "new-folder":
        setDialog({ kind: "new-folder" });
        return;
      case "refresh":
        treeRef.current.refreshAll();
        refetchRef.current();
        return;
      case "toggle-hidden":
        toggleHidden();
        return;
      case "select-all":
        selection.selectAll();
        return;
      case "paste":
        paste();
        return;
      case "copy-path":
        copyPathsToClipboard([currentPathRef.current]);
        return;
      case "set-start-folder":
        setStartFolder(currentPathRef.current);
        return;
      case "collapse-all":
        handleCollapseAll();
        return;
      default:
        return;
    }
  };

  const runCommand = useCallback((command: PanelCommand) => {
    commandRef.current(command);
  }, []);

  const handleSearchOpenChange = useCallback(
    (open: boolean) => {
      setSearchOpen(open);
      // The other half of the same rule as `openPathBar`: unfolding the filter
      // takes the path bar off screen, so it must not stay in edit mode.
      if (open) {
        closePathBar(false);
        return;
      }
      // Folding the field away has to take the filter with it, or rows stay
      // hidden behind a control that is no longer on screen.
      setQuery("");
      focusSurface();
    },
    [closePathBar, focusSurface],
  );

  useEffect(() => {
    if (!searchOpen) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [searchOpen]);

  useEffect(() => {
    if (inlineChrome) return;
    return subscribePanelCommands((command) => {
      commandRef.current(command);
    });
  }, [inlineChrome]);

  /* -------------------------------------------------------------- */
  /* Render                                                          */
  /* -------------------------------------------------------------- */

  const emptyKind: EmptyStateKind =
    query.trim() !== ""
      ? "no-results"
      : directory.error?.code === "path_escape"
        ? "escapes-root"
        : writable
          ? "empty"
          : "not-writable";

  const hiddenCount = directory.data?.hiddenCount ?? 0;
  const truncated = directory.data?.truncated ?? false;

  /* Bookmarks (§8.11). The only thing that disables a bookmark control is not
     knowing yet: a full list still answers, with the sentence that says what
     to do about it (`toggleBookmark`). */
  const currentBookmarked = bookmarks.isBookmarked(currentPath);
  const canToggleCurrentBookmark = listingEnabled && !bookmarks.loading;
  const rowMenuEntry = menuEntries.length === 1 ? menuEntries[0] : undefined;
  const rowMenuBookmarked =
    rowMenuEntry !== undefined && bookmarks.isBookmarked(rowMenuEntry.path);
  const selectedActionEntry = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const selectedActionBookmarked =
    selectedActionEntry !== undefined && bookmarks.isBookmarked(selectedActionEntry.path);
  const actionPropsFor = (
    entries: readonly FileEntry[],
    bookmarked: boolean,
  ): SelectedEntryActionsProps => ({
    entries,
    writable,
    canPaste,
    canExtract:
      entries.length === 1 &&
      entries[0]?.archiveFormat != null &&
      isFormatSupported(entries[0].archiveFormat, archiveSupport),
    onOpen: openEntry,
    onDownload: () => downloadSelection(entries),
    onAddToChat: () => addToChat(entries),
    onExtract: (entry) => setDialog({ kind: "extract", entry }),
    onCut: () => clipboard.cut(topLevelPaths(entries.map((entry) => entry.path))),
    onCopy: () => clipboard.copy(topLevelPaths(entries.map((entry) => entry.path))),
    onPaste: paste,
    onMoveTo: () =>
      setDialog({
        kind: "picker",
        mode: "move",
        paths: entries.map((entry) => entry.path),
      }),
    onCopyTo: () =>
      setDialog({
        kind: "picker",
        mode: "copy",
        paths: entries.map((entry) => entry.path),
      }),
    onRename: (entry) => setDialog({ kind: "rename", entry }),
    onCopyPath: () => copyPathsToClipboard(entries.map((entry) => entry.path)),
    onDelete: () => requestDelete(entries),
    onSetStartFolder: (entry) => setStartFolder(entry.path),
    onProperties: () => openProperties(entries),
    bookmarked,
    canToggleBookmark: !bookmarks.loading,
    onToggleBookmark: (entry) => toggleBookmark(entry.path),
  });
  const selectedActionProps = actionPropsFor(selectedEntries, selectedActionBookmarked);
  const rowMenuActionProps = actionPropsFor(menuEntries, rowMenuBookmarked);
  const bookmarkItems = {
    bookmarks: bookmarks.bookmarks,
    currentBookmarked,
    ready: canToggleCurrentBookmark,
    onNavigate: navigateTo,
    onToggleCurrent: () => toggleBookmark(currentPath),
    onRenameCurrent: () => openBookmarkRename(currentPath),
    onRemove: removeBookmark,
    onRefresh: bookmarks.refresh,
  };
  /* The two surfaces are one folder shown two ways, so everything they are
     told about it is built once, here, and handed to whichever is mounted. */
  const surfaceLoading = directory.isLoading || !ready || redirectPending;
  const cutPaths =
    clipboard.clipboard?.mode === "cut"
      ? new Set(clipboard.clipboard.paths)
      : new Set<string>();
  const handleParentDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    if (parentPath !== null) handleTargetDragOver(parentPath, event);
  };
  const emptyStateNode = (
    <EmptyState
      kind={emptyKind}
      query={query}
      root={root}
      onClearSearch={() => setQuery("")}
      onNewFolder={writable ? () => setDialog({ kind: "new-folder" }) : undefined}
      onUpload={writable ? openFilePicker : undefined}
    />
  );

  return (
    <div
      ref={rootRef}
      data-testid="fm-panel"
      data-current-path={currentPath}
      // `flex-1` beside `h-full`: BB mounts a file opener into a flex column,
      // where a definite height comes from the flex line rather than from the
      // parent's box, and the panel body is the same surface either way.
      className="@container relative flex h-full min-h-0 flex-1 flex-col bg-background text-foreground outline-none"
      onKeyDown={handleKeyDown}
      onDragEnter={handleRootDragEnter}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDragEnd={handleRootDragEnd}
      onDrop={handleRootDrop}
    >
      <Toolbar
        variant={inlineChrome ? "compact" : "wide"}
        searchOpen={searchOpen}
        onSearchOpenChange={handleSearchOpenChange}
        actions={
          inlineChrome ? (
            <PanelActions
              ready={listingEnabled}
              writable={writable}
              canPaste={canPaste}
              showHidden={showHidden}
              sortField={sortField}
              sortDirection={sortDirection}
              viewMode={viewMode}
              expandedCount={tree.expandedCount}
              bookmarks={<BookmarkMenuItems {...bookmarkItems} />}
              onCommand={runCommand}
              onSortFieldChange={applySortField}
              onSortDirectionChange={applySortDirection}
              threadFolder={threadFolder}
              onViewModeChange={applyViewMode}
            />
          ) : null
        }
        path={currentPath}
        root={root}
        onNavigate={navigateTo}
        query={query}
        onQueryChange={setQuery}
        searchInputRef={searchRef}
        sortField={sortField}
        sortDirection={sortDirection}
        onSortFieldChange={applySortField}
        onSortDirectionChange={applySortDirection}
        viewMode={viewMode}
        onViewModeChange={applyViewMode}
        showHidden={showHidden}
        onToggleHidden={toggleHidden}
        expandedCount={tree.expandedCount}
        onCollapseAll={handleCollapseAll}
        onRefresh={handleRefresh}
        refreshing={directory.isRefetching}
        hiddenCount={hiddenCount}
        bookmarked={currentBookmarked}
        canToggleBookmark={canToggleCurrentBookmark}
        onToggleBookmark={() => toggleBookmark(currentPath)}
        bookmarksMenu={<BookmarksMenu {...bookmarkItems} />}
        volume={directory.data?.volume ?? null}
        dropTargetPath={dropTarget}
        onDragOverCrumb={handleTargetDragOver}
        onDragLeaveCrumb={noopDragHandler}
        onDropOnCrumb={noopDragHandler}
        pathEditing={pathEditing}
        onPathOpen={openPathBar}
        onPathCancel={handlePathCancel}
        onPathSubmit={submitPath}
        pathError={pathError}
        onPathDirty={handlePathDirty}
        pathBusy={pathBusy}
        pathFocusTick={pathFocusTick}
      />

      {touchActionsEnabled && selectedEntries.length > 0 ? (
        <SelectionActionBar
          {...selectedActionProps}
          onClear={selection.clear}
        />
      ) : null}

      {stateError === null ? null : (
        <ErrorBanner
          error={stateError}
          title="The file manager backend did not answer"
          onRetry={() => {
            setReady(false);
            setStateError(null);
            window.setTimeout(() => setReady(true), 0);
          }}
        />
      )}

      {/* One navigation and one toast, never an error that repairs itself half
          a second later: while a restored folder is being answered for, and
          until the folder we fell back to answers, the banner stays down
          (§1.6). Every other failure renders exactly as it did before. */}
      {directory.error === null || restoreFallbackMoves || directory.error === swallowedError ? null : (
        <ErrorBanner
          error={directory.error.rawMessage}
          title="Could not open this folder"
          onRetry={handleRefresh}
        />
      )}

      {truncated ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface-attention px-3 py-1.5 text-xs text-warning-text">
          Showing the first {String(state?.maxListEntries ?? directory.entries.length)} of{" "}
          {String(directory.data?.totalEntries ?? 0)} items. Use the filter to narrow it down.
        </div>
      ) : null}

      {/* A tree-row cap has nothing to say about a grid of one folder: the
          gallery never renders those rows, so the banner would be describing
          a surface that is not on screen. */}
      {tree.rowsTruncated && !galleryView ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface-attention px-3 py-1.5 text-xs text-warning-text">
          Showing the first {String(MAX_TREE_ROWS)} rows. Collapse a folder to see more.
        </div>
      ) : null}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            data-testid="fm-scroll"
            className="min-h-0 flex-1 overflow-auto"
            onClick={handleBackgroundClick}
            onContextMenu={handleContainerContextMenu}
          >
            {/* One surface at a time, sharing every handler: selection, the
                context menu, double-click and drag & drop are the panel's, so
                the gallery inherits them rather than reimplementing them. */}
            {galleryView ? (
              <FileGallery
                gridRef={galleryRef}
                entries={galleryEntries}
                loading={surfaceLoading}
                selectedPaths={selection.selected}
                focusedPath={selection.focus}
                cutPaths={cutPaths}
                dragEnabled={!touchActionsEnabled}
                dropTargetPath={dropTarget}
                previewBaseUrl={previewBaseUrl}
                parentPath={parentPath}
                onNavigateParent={goToParent}
                onRowClick={handleRowClick}
                onRowDoubleClick={openEntry}
                onRowContextMenu={handleRowContextMenu}
                onToggleSelect={handleToggleSelect}
                onRowDragStart={handleRowDragStart}
                onRowDragOver={handleRowDragOver}
                onRowDragLeave={handleRowDragLeave}
                onRowDrop={noopDragHandler}
                onRowDragEnd={handleRootDragEnd}
                onParentDragOver={handleParentDragOver}
                onParentDragLeave={noopDragHandler}
                onParentDrop={noopDragHandler}
                emptyState={emptyStateNode}
              />
            ) : (
              <FileTable
                gridRef={gridRef}
                rows={rows}
                loading={surfaceLoading}
                selectedPaths={selection.selected}
                focusedPath={selection.focus}
                cutPaths={cutPaths}
                dragEnabled={!touchActionsEnabled}
                sortField={sortField}
                sortDirection={sortDirection}
                onSort={handleHeaderSort}
                parentPath={parentPath}
                onNavigateParent={goToParent}
                dropTargetPath={dropTarget}
                nowMs={nowMs}
                onSelectAll={(selectAll) => {
                  if (selectAll) selection.selectAll();
                  else selection.clear();
                }}
                onToggleExpand={handleToggleExpand}
                onRetryNode={handleRetryNode}
                onRowClick={handleRowClick}
                onRowDoubleClick={openEntry}
                onRowContextMenu={handleRowContextMenu}
                onToggleSelect={handleToggleSelect}
                onRowDragStart={handleRowDragStart}
                onRowDragOver={handleRowDragOver}
                onRowDragLeave={handleRowDragLeave}
                onRowDrop={noopDragHandler}
                onRowDragEnd={handleRootDragEnd}
                onParentDragOver={handleParentDragOver}
                onParentDragLeave={noopDragHandler}
                onParentDrop={noopDragHandler}
                emptyState={emptyStateNode}
              />
            )}
          </div>
        </ContextMenuTrigger>

        {menuEntries.length > 0 ? (
          <RowContextMenu {...rowMenuActionProps} />
        ) : (
          <BackgroundContextMenu
            writable={writable}
            canPaste={canPaste}
            showHidden={showHidden}
            onNewFolder={() => setDialog({ kind: "new-folder" })}
            onUpload={openFilePicker}
            onPaste={paste}
            onSelectAll={() => selection.selectAll()}
            onRefresh={handleRefresh}
            onToggleHidden={toggleHidden}
            expandedCount={tree.expandedCount}
            onCollapseAll={handleCollapseAll}
            onCopyPath={() => copyPathsToClipboard([currentPath])}
            onSetStartFolder={() => setStartFolder(currentPath)}
            onProperties={() => openProperties([])}
            bookmarked={currentBookmarked}
            canToggleBookmark={canToggleCurrentBookmark}
            onToggleBookmark={() => toggleBookmark(currentPath)}
          />
        )}
      </ContextMenu>

      <ActivityTray
        uploads={uploads.uploads}
        jobs={jobs.jobs}
        onCancelUpload={uploads.cancel}
        onRetryUpload={uploads.retry}
        onDismissUpload={uploads.remove}
        onClearFinished={() => {
          uploads.clearFinished();
          jobs.clearFinished();
        }}
        onCancelJob={(jobId) => {
          void jobs.cancel(jobId).catch((failure: unknown) => {
            toast.error(errorToastText(failure, "Could not cancel that job."));
          });
        }}
        onDismissJob={jobs.dismiss}
      />

      {externalDrag ? (
        <div
          data-testid="fm-drop-overlay"
          className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-primary/50"
        />
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="fm-file-input"
        onChange={(event) => {
          const files = event.target.files;
          if (files !== null) {
            enqueueUploads(
              Array.from(files).map((file) => ({
                file,
                dirPath: currentPathRef.current,
                relativeDir: "",
              })),
            );
          }
          event.target.value = "";
        }}
      />

      {dialog.kind === "new-folder" ? (
        <NewFolderDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          existingNames={existingNames}
          destinationLabel={currentPath}
          onSubmit={async (name) => {
            await rpc.call("createFolder", { path: currentPath, name });
            refetchRef.current();
          }}
        />
      ) : null}

      {dialog.kind === "rename" ? (
        <RenameDialog
          open
          entry={dialog.entry}
          existingNames={siblingNames(dialog.entry.path)}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onSubmit={async (entry, newName) => {
            const result = await rpc.call("renameEntry", { path: entry.path, newName });
            // The one mutation whose new absolute path is knowable, so the one
            // that keeps its subtree open instead of collapsing it (§5.4).
            treeRef.current.remapPrefix(entry.path, result.entry.path);
            refetchRef.current();
          }}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <ConfirmDeleteDialog
          open
          entries={dialog.entries}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onConfirm={deleteEntries}
        />
      ) : null}

      {dialog.kind === "extract" ? (
        <ExtractDialog
          open
          entry={dialog.entry}
          root={root}
          showHidden={showHidden}
          archiveSupport={archiveSupport}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onSubmit={startExtract}
        />
      ) : null}

      {dialog.kind === "bookmark-name" ? (
        <BookmarkNameDialog
          open
          initialName={dialog.name}
          pathLabel={dialog.path}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          // The dialog keeps its own inline error, so this one rejects rather
          // than toasting: a message under the field beats a toast over a
          // dialog the user is still looking at.
          onSubmit={async (name) => {
            await bookmarksRef.current.rename(dialog.path, name).catch((failure: unknown) => {
              throw new Error(errorToastText(failure, BOOKMARK_RENAME_FAILED_TEXT));
            });
          }}
        />
      ) : null}

      {dialog.kind === "view" ? (
        <FileViewerDialog
          open
          entry={dialog.entry}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          // An archive's "Extract…" swaps the viewer for the ordinary dialog:
          // one extraction flow, whichever surface it starts from (§8.13).
          onExtract={(entry) => setDialog({ kind: "extract", entry })}
        />
      ) : null}

      {dialog.kind === "properties" ? (
        <PropertiesDialog
          open
          target={dialog.target}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
        />
      ) : null}

      {dialog.kind === "picker" ? (
        <FolderPickerDialog
          open
          title={dialog.mode === "move" ? "Move to…" : "Copy to…"}
          initialPath={currentPath}
          root={root}
          showHidden={showHidden}
          confirmLabel="Choose this folder"
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onChoose={(destination) => {
            // "Set as start folder" takes the folder it was invoked on (§8.6),
            // both from the row menu and from the background menu, so the
            // picker only ever runs the two batch destinations.
            if (dialog.mode === "move") moveTo(dialog.paths, destination);
            else copyTo(dialog.paths, destination);
          }}
        />
      ) : null}

      {dialog.kind === "conflict" ? (
        <ConflictDialog
          open
          conflicts={dialog.conflicts}
          destinationDir={dialog.destinationDir}
          operation={dialog.operation === "move" ? "Move" : "Copy"}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onResolve={(choice: ConflictChoice) => {
            if (choice === "skip") {
              refetchRef.current();
              return;
            }
            const conflictPolicy = choice === "overwrite" ? "overwrite" : "rename";
            const { operation, destinationDir, paths } = dialog;
            void (async () => {
              try {
                const result =
                  operation === "move"
                    ? await rpc.call("moveEntries", {
                        paths,
                        destinationDir,
                        conflict: conflictPolicy,
                      })
                    : await rpc.call("copyEntries", {
                        paths,
                        destinationDir,
                        conflict: conflictPolicy,
                      });
                applyBatch(result, operation);
              } catch (failure) {
                toast.error(errorToastText(failure, "Could not finish that operation."));
              }
            })();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

/**
 * The nav panel (§10): the route carries the folder, and bb renders
 * `HeaderActions` in the shared title bar above this component.
 */
export function FileManagerPanel({ subPath }: PluginNavPanelProps) {
  const location = useRouteLocation(subPath);
  return <FileManagerSurface location={location} chrome="host-header" />;
}
