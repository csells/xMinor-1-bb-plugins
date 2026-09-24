// @vitest-environment jsdom
//
// TREE-SPEC §8.2 — the tree through the real panel, not through the hook.
//
// Everything here goes in via the DOM the user touches (a chevron, a key, a
// drag) and comes out as an RPC call or a row, because the whole claim of the
// feature is that "an ordered list of visible row paths" kept its shape:
// selection, ranges, clipboard, drag & drop and the keyboard had to keep
// working on rows that live in a different directory than the panel does.
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract } from "../../contract";

const HOST_ID = "host_test";

const toasts = vi.hoisted(() => ({ error: [] as string[], success: [] as string[] }));

vi.mock("sonner", () => ({
  toast: {
    error: (text: string) => void toasts.error.push(text),
    success: (text: string) => void toasts.success.push(text),
    message: () => undefined,
    warning: () => undefined,
    info: () => undefined,
  },
}));

// `app.tsx` registers into the runtime at import time, so the plugin's own
// modules may only be imported after `loadPluginApp` installed it.
const app = await loadPluginApp(() => import("../../app"));
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore } = await import("../../lib/last-folder");
const { resetTreeStore } = await import("../../hooks/useTree");
const { AUTO_EXPAND_HOVER_MS, EXPANDED_STORAGE_KEY, MAX_EXPANDED_PATHS } = await import(
  "../../lib/fm-tree"
);

const registration = app.navPanels[0]!;

const ROOT = "/home/coder";
const DOCS = `${ROOT}/docs`;
const NESTED = `${DOCS}/nested`;
const PICS = `${ROOT}/pics`;
const EMPTY = `${ROOT}/empty`;
const BROKEN = `${ROOT}/broken`;
const DRAG_MIME = "application/x-bb-file-manager";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeEntry(partial: Partial<FileEntry> & { name: string; path: string }): FileEntry {
  return {
    kind: "file",
    targetKind: null,
    sizeBytes: 4,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: partial.name.startsWith("."),
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
    ...partial,
  };
}

function makeDir(name: string, path: string): FileEntry {
  return makeEntry({ name, path, kind: "directory" });
}

const BROKEN_DIR = makeDir("broken", BROKEN);
const DOCS_DIR = makeDir("docs", DOCS);
const EMPTY_DIR = makeDir("empty", EMPTY);
const PICS_DIR = makeDir("pics", PICS);
const NOTES = makeEntry({ name: "notes.txt", path: `${ROOT}/notes.txt` });
const ZETA = makeEntry({ name: "zeta.txt", path: `${ROOT}/zeta.txt` });

const NESTED_DIR = makeDir("nested", NESTED);
const INNER = makeEntry({ name: "inner.txt", path: `${DOCS}/inner.txt` });
const DEEP = makeEntry({ name: "deep.txt", path: `${NESTED}/deep.txt` });
const PHOTO = makeEntry({ name: "photo.png", path: `${PICS}/photo.png`, sizeBytes: 90 });
const RAW = makeEntry({ name: "raw.cr2", path: `${PICS}/raw.cr2`, sizeBytes: 10 });
const HIDDEN_IN_DOCS = makeEntry({ name: ".secret", path: `${DOCS}/.secret` });

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

const STATE = {
  root: ROOT,
  startFolder: ROOT,
  preferences: PREFERENCES,
  chunkSizeBytes: 8 * 1024 * 1024,
  maxListEntries: 5000,
  archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
  pluginVersion: "0.2.0",
  primaryHostId: HOST_ID,
};

/** Mutable per test: delete and move really do change what `listDir` returns. */
let listings: Record<string, FileEntry[]>;
/** Paths whose `listDir` rejects, so the error branch is reachable and curable. */
let failing: Set<string>;
/** Paths whose `listDir` waits for the test to let it through. */
let holds: Map<string, Promise<void>>;

function freshListings(): Record<string, FileEntry[]> {
  return {
    [ROOT]: [BROKEN_DIR, DOCS_DIR, EMPTY_DIR, PICS_DIR, NOTES, ZETA],
    [DOCS]: [NESTED_DIR, INNER],
    [NESTED]: [DEEP],
    [PICS]: [PHOTO, RAW],
    [EMPTY]: [],
    [BROKEN]: [],
  };
}

function listingFor(path: string, showHidden: boolean) {
  const entries = listings[path] ?? [];
  const visible = showHidden ? entries : entries.filter((entry) => !entry.isHidden);
  return {
    path,
    parentPath: path === ROOT ? null : path.slice(0, path.lastIndexOf("/")),
    isRoot: path === ROOT,
    entries: visible,
    truncated: false,
    totalEntries: entries.length,
    hiddenCount: entries.length - visible.length,
    writable: true,
    volume: null,
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function baseRpc(
  overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {},
): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  return {
    getState: () => STATE,
    listDir: async (input) => {
      const { path, showHidden } = input as { path: string; showHidden: boolean };
      const hold = holds.get(path);
      if (hold !== undefined) await hold;
      if (failing.has(path)) throw new Error(`permission_denied: EACCES, scandir '${path}'`);
      if (listings[path] === undefined) throw new Error(`not_found: ${path}`);
      return listingFor(path, showHidden);
    },
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: STATE.chunkSizeBytes,
    }),
    deleteEntries: (input) => ({ succeeded: (input as { paths: string[] }).paths, failed: [] }),
    moveEntries: (input) => ({ succeeded: (input as { paths: string[] }).paths, failed: [] }),
    ...overrides,
  };
}

async function mountPanel(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
  options: { subPath?: string } & Record<string, unknown> = {},
): Promise<RenderedSlot> {
  const { subPath = "", ...renderOptions } = options;
  const slot = renderSlot(
    { component: registration.component },
    { subPath },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract>, ...renderOptions },
  );
  await waitFor(() => {
    expect(slot.queryAllByTestId("fm-row").length).toBeGreaterThan(0);
  });
  return slot;
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function rowPaths(slot: RenderedSlot): string[] {
  return slot.getAllByTestId("fm-row").map((row) => row.getAttribute("data-fm-path") ?? "");
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement {
  const row = slot
    .getAllByTestId("fm-row")
    .find((candidate) => candidate.getAttribute("data-fm-path") === path);
  if (row === undefined) throw new Error(`no row for ${path}; saw ${rowPaths(slot).join(", ")}`);
  return row;
}

function depthOf(slot: RenderedSlot, path: string): string {
  return rowFor(slot, path).getAttribute("data-fm-depth") ?? "";
}

function chevronFor(slot: RenderedSlot, path: string): HTMLElement {
  const chevron = rowFor(slot, path).querySelector('[data-testid="fm-chevron"]');
  if (!(chevron instanceof HTMLElement)) throw new Error(`no chevron on ${path}`);
  return chevron;
}

function hasChevron(slot: RenderedSlot, path: string): boolean {
  return rowFor(slot, path).querySelector('[data-testid="fm-chevron"]') !== null;
}

function selectedPaths(slot: RenderedSlot): string[] {
  return slot
    .getAllByTestId("fm-row")
    .filter((row) => row.getAttribute("data-selected") === "true")
    .map((row) => row.getAttribute("data-fm-path") ?? "");
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

function listDirCallsFor(slot: RenderedSlot, path: string): RpcCall[] {
  return callsTo(slot, "listDir").filter((call) => (call.input as { path: string }).path === path);
}

/** fireEvent returns false when a handler called preventDefault(). */
function press(target: HTMLElement, init: Record<string, unknown>): boolean {
  return fireEvent.keyDown(target, init);
}

/** Expands one folder through its chevron and waits for the children to land. */
async function expandFolder(slot: RenderedSlot, path: string, firstChild: string): Promise<void> {
  fireEvent.click(chevronFor(slot, path));
  await waitFor(() => {
    expect(rowPaths(slot)).toContain(firstChild);
  });
}

/** jsdom has no DragEvent: bolt a dataTransfer onto a hand-built MouseEvent. */
function withTransfer(event: MouseEvent, transfer: DataTransfer): MouseEvent {
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  return event;
}

/** A DataTransfer that actually stores what setData wrote, like the real one. */
function internalTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files: [],
    items: [],
    get types(): string[] {
      return [...store.keys()];
    },
    setData(format: string, data: string): void {
      store.set(format, data);
    },
    getData(format: string): string {
      return store.get(format) ?? "";
    },
    clearData(): void {
      store.clear();
    },
  } as unknown as DataTransfer;
}

function externalTransfer(files: readonly File[] = []): DataTransfer {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    types: ["Files"],
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => ({
        isFile: true,
        isDirectory: false,
        name: file.name,
        file: (resolve: (value: File) => void) => resolve(file),
      }),
    })),
    getData: () => "",
    setData: () => undefined,
  } as unknown as DataTransfer;
}

/** Enough of XMLHttpRequest for the upload manager to start a transfer. */
class SilentXhr {
  readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  open(): void {}
  setRequestHeader(): void {}
  send(): void {}
  abort(): void {}
}

async function openRowMenu(slot: RenderedSlot, path: string): Promise<HTMLElement> {
  fireEvent.contextMenu(rowFor(slot, path), { button: 2 });
  return slot.findByTestId("fm-row-menu");
}

function clickItem(menu: HTMLElement, label: string): void {
  const item = within(menu)
    .getAllByRole("menuitem")
    .find((candidate) => (candidate.textContent ?? "").startsWith(label));
  if (item === undefined) {
    throw new Error(
      `no menu item "${label}"; saw ${within(menu)
        .getAllByRole("menuitem")
        .map((node) => node.textContent ?? "")
        .join(" | ")}`,
    );
  }
  fireEvent.click(item);
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  listings = freshListings();
  failing = new Set([BROKEN]);
  holds = new Map();
  resetUploadManager();
  resetPanelSnapshot();
  // The location memory decides where the panel opens, so it leaks
  // between mounts unless every suite that mounts one clears it
  // (PATHBAR-SPEC §9.5).
  window.localStorage.clear();
  resetLastFolderStore();
  resetTreeStore();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Rendering and lazy loading (§8.2 1-7)                               */
/* ------------------------------------------------------------------ */

describe("chevrons and lazy loading (§8.2)", () => {
  it("gives every folder row a chevron and every file row none", async () => {
    const slot = await mountPanel();

    expect(
      slot.getAllByTestId("fm-chevron").map((node) => node.getAttribute("data-fm-chevron")),
    ).toEqual([BROKEN, DOCS, EMPTY, PICS]);
    expect(hasChevron(slot, NOTES.path)).toBe(false);
    expect(hasChevron(slot, ZETA.path)).toBe(false);
    // Files keep the 16px placeholder, so the names still line up.
    expect(rowFor(slot, NOTES.path).querySelectorAll("span.size-4")).toHaveLength(1);
    expect(chevronFor(slot, DOCS).getAttribute("aria-label")).toBe("Expand docs");
  });

  it("expands in place: one listDir, children at depth 1, no navigation", async () => {
    const slot = await mountPanel();
    expect(listDirCallsFor(slot, DOCS)).toHaveLength(0);

    await expandFolder(slot, DOCS, NESTED);

    expect(rowPaths(slot)).toEqual([
      BROKEN,
      DOCS,
      NESTED,
      INNER.path,
      EMPTY,
      PICS,
      NOTES.path,
      ZETA.path,
    ]);
    expect(depthOf(slot, DOCS)).toBe("0");
    expect(depthOf(slot, NESTED)).toBe("1");
    expect(depthOf(slot, INNER.path)).toBe("1");
    expect(rowFor(slot, NESTED).getAttribute("aria-level")).toBe("2");

    expect(listDirCallsFor(slot, DOCS)).toEqual([
      { method: "listDir", input: { path: DOCS, showHidden: false } },
    ]);
    // The panel did not move: same directory, same breadcrumbs, no navigation.
    expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(ROOT);
    expect(listDirCallsFor(slot, ROOT)).toHaveLength(1);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("keeps DOM focus in the grid and announces the cursor row (§3.4)", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.click(rowFor(slot, DOCS));
    const grid = slot.getByTestId("fm-table");
    // Without focus inside the treegrid, aria-level/-expanded/-selected on the
    // rows are inert: nothing tells the screen reader where the cursor is.
    expect(document.activeElement).toBe(grid);
    expect(grid.getAttribute("aria-activedescendant")).toBe(rowFor(slot, DOCS).id);

    press(slot.getByTestId("fm-panel"), { key: "ArrowDown" });
    await waitFor(() => {
      expect(grid.getAttribute("aria-activedescendant")).toBe(rowFor(slot, NESTED).id);
    });
    expect(rowFor(slot, NESTED).id).not.toBe("");
  });

  it("spins the chevron while the child listing is in flight", async () => {
    const gate = deferred();
    holds.set(PICS, gate.promise);
    const slot = await mountPanel();

    fireEvent.click(chevronFor(slot, PICS));
    await waitFor(() => {
      expect(chevronFor(slot, PICS).querySelector(".animate-spin")).not.toBeNull();
    });
    expect(rowPaths(slot)).not.toContain(PHOTO.path);

    holds.delete(PICS);
    gate.release();

    await waitFor(() => {
      expect(rowPaths(slot)).toContain(PHOTO.path);
    });
    expect(chevronFor(slot, PICS).querySelector(".animate-spin")).toBeNull();
  });

  it("collapses without losing the cache: re-expanding issues no second listDir", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.click(chevronFor(slot, DOCS));
    await waitFor(() => {
      expect(rowPaths(slot)).not.toContain(NESTED);
    });

    fireEvent.click(chevronFor(slot, DOCS));
    await waitFor(() => {
      expect(rowPaths(slot)).toContain(NESTED);
    });
    expect(listDirCallsFor(slot, DOCS)).toHaveLength(1);
  });

  it("flips aria-expanded on the row and on the chevron", async () => {
    const slot = await mountPanel();
    expect(rowFor(slot, DOCS).getAttribute("aria-expanded")).toBe("false");
    expect(rowFor(slot, NOTES.path).getAttribute("aria-expanded")).toBeNull();

    await expandFolder(slot, DOCS, NESTED);

    expect(rowFor(slot, DOCS).getAttribute("aria-expanded")).toBe("true");
    expect(chevronFor(slot, DOCS).getAttribute("aria-expanded")).toBe("true");
    expect(chevronFor(slot, DOCS).getAttribute("aria-label")).toBe("Collapse docs");
  });

  it("renders an inline error row with a scoped Retry that reloads only that folder", async () => {
    const slot = await mountPanel();

    fireEvent.click(chevronFor(slot, BROKEN));
    const failure = await slot.findByTestId("fm-tree-error");

    expect(failure.getAttribute("data-fm-parent-path")).toBe(BROKEN);
    expect(failure.textContent).toContain("EACCES, scandir");
    // No `data-fm-path`, so the status row can never be selected or focused.
    expect(failure.getAttribute("data-fm-path")).toBeNull();
    expect(rowPaths(slot)).toHaveLength(6);
    // The bare "Retry" of ErrorBanner stays unambiguous (§2.3).
    expect(slot.queryAllByRole("button", { name: "Retry" })).toHaveLength(0);

    failing.delete(BROKEN);
    listings[BROKEN] = [makeEntry({ name: "ok.txt", path: `${BROKEN}/ok.txt` })];
    fireEvent.click(slot.getByRole("button", { name: "Retry loading broken" }));

    await waitFor(() => {
      expect(rowPaths(slot)).toContain(`${BROKEN}/ok.txt`);
    });
    expect(slot.queryByTestId("fm-tree-error")).toBeNull();
    expect(listDirCallsFor(slot, BROKEN)).toHaveLength(2);
  });

  it("renders one empty-folder row for a folder with nothing in it", async () => {
    const slot = await mountPanel();

    fireEvent.click(chevronFor(slot, EMPTY));
    const empty = await slot.findByTestId("fm-tree-empty");

    expect(empty.getAttribute("data-fm-parent-path")).toBe(EMPTY);
    expect(empty.textContent).toContain("Empty folder");
    expect(rowPaths(slot)).toHaveLength(6);
    // The whole-directory empty state is a different surface and stays away.
    expect(slot.queryByTestId("fm-empty-state")).toBeNull();
  });

  it("keeps two expanded folders in depth-major order", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);
    await expandFolder(slot, PICS, PHOTO.path);
    await expandFolder(slot, NESTED, DEEP.path);

    expect(rowPaths(slot)).toEqual([
      BROKEN,
      DOCS,
      NESTED,
      DEEP.path,
      INNER.path,
      EMPTY,
      PICS,
      PHOTO.path,
      RAW.path,
      NOTES.path,
      ZETA.path,
    ]);
    expect(depthOf(slot, DEEP.path)).toBe("2");
  });
});

/* ------------------------------------------------------------------ */
/* Mouse, keyboard, selection (§8.2 8-14)                              */
/* ------------------------------------------------------------------ */

describe("tree interaction (§8.2)", () => {
  it("toggles expansion without touching the selection", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, NOTES.path));
    expect(selectedPaths(slot)).toEqual([NOTES.path]);

    await expandFolder(slot, DOCS, NESTED);

    expect(selectedPaths(slot)).toEqual([NOTES.path]);
  });

  it("still navigates on a double click, and never from the chevron", async () => {
    const slot = await mountPanel();

    fireEvent.doubleClick(chevronFor(slot, DOCS));
    expect(slot.inspection.navigateCalls).toHaveLength(0);

    fireEvent.doubleClick(rowFor(slot, DOCS));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
    ]);
  });

  it("walks the tree with ArrowRight and ArrowLeft", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, DOCS));

    // → on a collapsed folder opens it…
    expect(press(slot.getByTestId("fm-panel"), { key: "ArrowRight" })).toBe(false);
    await waitFor(() => {
      expect(rowPaths(slot)).toContain(NESTED);
    });
    expect(selectedPaths(slot)).toEqual([DOCS]);

    // …and again steps onto its first child.
    press(slot.getByTestId("fm-panel"), { key: "ArrowRight" });
    await waitFor(() => {
      expect(selectedPaths(slot)).toEqual([NESTED]);
    });

    // ← on a collapsed nested row walks up to the parent row.
    press(slot.getByTestId("fm-panel"), { key: "ArrowLeft" });
    await waitFor(() => {
      expect(selectedPaths(slot)).toEqual([DOCS]);
    });

    // ← on the expanded parent collapses it.
    press(slot.getByTestId("fm-panel"), { key: "ArrowLeft" });
    await waitFor(() => {
      expect(rowPaths(slot)).not.toContain(NESTED);
    });

    // ← at depth 0 with nothing to close is not ours: no preventDefault.
    expect(press(slot.getByTestId("fm-panel"), { key: "ArrowLeft" })).toBe(true);
  });

  it("does not step past a folder whose children are still loading", async () => {
    const gate = deferred();
    holds.set(DOCS, gate.promise);
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, DOCS));

    // → opens the folder; the listing is still in flight.
    press(slot.getByTestId("fm-panel"), { key: "ArrowRight" });
    await waitFor(() => {
      expect(listDirCallsFor(slot, DOCS)).toHaveLength(1);
    });

    // → again must not walk onto the *next sibling*: there is no child row to
    // step onto yet, so the cursor stays on the folder the user is entering.
    expect(press(slot.getByTestId("fm-panel"), { key: "ArrowRight" })).toBe(true);
    expect(selectedPaths(slot)).toEqual([DOCS]);

    gate.release();
    await waitFor(() => {
      expect(rowPaths(slot)).toContain(NESTED);
    });
    press(slot.getByTestId("fm-panel"), { key: "ArrowRight" });
    await waitFor(() => {
      expect(selectedPaths(slot)).toEqual([NESTED]);
    });
  });

  it("stays on an expanded empty folder instead of jumping to its sibling", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, EMPTY, EMPTY);
    fireEvent.click(rowFor(slot, EMPTY));
    await waitFor(() => {
      expect(slot.queryAllByTestId("fm-tree-empty").length).toBeGreaterThan(0);
    });

    // The only row under `empty` is the status row, which is not selectable.
    expect(press(slot.getByTestId("fm-panel"), { key: "ArrowRight" })).toBe(true);
    expect(selectedPaths(slot)).toEqual([EMPTY]);
  });

  it("leaves Alt+ArrowRight to the browser's history-forward", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);
    fireEvent.click(rowFor(slot, DOCS));

    expect(press(slot.getByTestId("fm-panel"), { key: "ArrowRight", altKey: true })).toBe(true);
    expect(selectedPaths(slot)).toEqual([DOCS]);
  });

  it("leaves ArrowRight on a file row to the browser", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, NOTES.path));

    expect(press(slot.getByTestId("fm-panel"), { key: "ArrowRight" })).toBe(true);
    expect(selectedPaths(slot)).toEqual([NOTES.path]);
  });

  it("keeps Alt+ArrowLeft as go-to-parent-directory, not as collapse", async () => {
    const slot = await mountPanel(baseRpc(), { subPath: "docs" });
    await expandFolder(slot, NESTED, DEEP.path);
    fireEvent.click(rowFor(slot, NESTED));

    expect(press(slot.getByTestId("fm-panel"), { key: "ArrowLeft", altKey: true })).toBe(false);

    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "" } },
    ]);
    expect(rowPaths(slot)).toContain(DEEP.path);
  });

  it("shift-clicks a range straight across the expanded boundary", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.click(rowFor(slot, DOCS));
    fireEvent.click(rowFor(slot, EMPTY), { shiftKey: true });

    expect(selectedPaths(slot)).toEqual([DOCS, NESTED, INNER.path, EMPTY]);
  });

  it("Ctrl+A now takes the nested rows too", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "a", ctrlKey: true });

    expect(selectedPaths(slot)).toEqual(rowPaths(slot));
    expect(selectedPaths(slot)).toContain(INNER.path);
    await waitFor(() => {
      expect((slot.getByTestId("fm-select-all") as HTMLInputElement).checked).toBe(true);
    });
  });

  it("deletes a mixed-depth selection in a single call carrying both depths", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.click(rowFor(slot, INNER.path));
    fireEvent.click(rowFor(slot, NOTES.path), { ctrlKey: true });
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });

    const dialog = await slot.findByTestId("fm-delete-dialog");
    expect(dialog.textContent).toContain("Delete 2 items?");
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(callsTo(slot, "deleteEntries")).toEqual([
        { method: "deleteEntries", input: { paths: [INNER.path, NOTES.path], recursive: true } },
      ]);
    });
  });

  it("drops a child from a Ctrl+A delete when its own folder is going too", async () => {
    // Not in TREE-SPEC §8.2's wording, but forced by it: `Ctrl+A` over an
    // expanded folder now selects the folder *and* its children, and
    // `deleteEntries` removes a folder recursively, so sending the child as
    // well comes back as `not_found` — a false error toast on a successful
    // delete. The panel normalizes to top-level paths first.
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "a", ctrlKey: true });
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });

    const dialog = await slot.findByTestId("fm-delete-dialog");
    expect(dialog.textContent).toContain("Delete 6 items?");
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(callsTo(slot, "deleteEntries")).toHaveLength(1);
    });
    expect(callsTo(slot, "deleteEntries")[0]?.input).toEqual({
      paths: [BROKEN, DOCS, EMPTY, PICS, NOTES.path, ZETA.path],
      recursive: true,
    });
    expect(toasts.error).toEqual([]);
  });

  it("deselects the children a collapse hides, so a later Delete does nothing", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.click(rowFor(slot, INNER.path));
    expect(selectedPaths(slot)).toEqual([INNER.path]);

    fireEvent.click(chevronFor(slot, DOCS));
    await waitFor(() => {
      expect(rowPaths(slot)).not.toContain(INNER.path);
    });
    expect(selectedPaths(slot)).toEqual([]);

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.queryByTestId("fm-delete-dialog")).toBeNull();
    expect(callsTo(slot, "deleteEntries")).toHaveLength(0);
  });

  it("offers the row context menu on a nested row and acts on its absolute path", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    const menu = await openRowMenu(slot, INNER.path);
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.startsWith("Rename"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Cut"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Delete"))).toBe(true);
    expect(menu.textContent).toContain("inner.txt");
    expect(selectedPaths(slot)).toEqual([INNER.path]);

    clickItem(menu, "Delete");
    const dialog = await slot.findByTestId("fm-delete-dialog");
    expect(dialog.textContent).toContain("inner.txt");
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(callsTo(slot, "deleteEntries")).toEqual([
        { method: "deleteEntries", input: { paths: [INNER.path], recursive: true } },
      ]);
    });
  });

  it("collapses everything from the toolbar, and disables the button when nothing is open", async () => {
    const slot = await mountPanel();
    const collapseAll = slot.getByTestId("fm-collapse-all") as HTMLButtonElement;
    expect(collapseAll.disabled).toBe(true);

    await expandFolder(slot, DOCS, NESTED);
    await expandFolder(slot, PICS, PHOTO.path);
    await waitFor(() => {
      expect((slot.getByTestId("fm-collapse-all") as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(slot.getByTestId("fm-collapse-all"));

    await waitFor(() => {
      expect(rowPaths(slot)).toEqual([BROKEN, DOCS, EMPTY, PICS, NOTES.path, ZETA.path]);
    });
    expect((slot.getByTestId("fm-collapse-all") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the same collapse-all in the background menu", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.contextMenu(slot.getByTestId("fm-scroll"), { button: 2 });
    const menu = await slot.findByTestId("fm-background-menu");
    clickItem(menu, "Collapse all folders");

    await waitFor(() => {
      expect(rowPaths(slot)).not.toContain(NESTED);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Drag & drop, uploads (§8.2 15-19)                                   */
/* ------------------------------------------------------------------ */

describe("tree drag & drop (§8.2)", () => {
  it("drags a nested row by its absolute path in both flavours", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);
    const transfer = internalTransfer();

    fireEvent.click(rowFor(slot, INNER.path));
    fireEvent.dragStart(rowFor(slot, INNER.path), { dataTransfer: transfer });

    expect(JSON.parse(transfer.getData(DRAG_MIME))).toEqual([INNER.path]);
    expect(transfer.getData("text/plain")).toBe(INNER.path);
  });

  it("moves into a nested folder when the drop lands on it", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);
    const transfer = internalTransfer();

    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.dragStart(rowFor(slot, NOTES.path), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(slot, NESTED), { dataTransfer: transfer });

    await waitFor(() => {
      expect(rowFor(slot, NESTED).getAttribute("data-drop-target")).toBe("true");
    });

    fireEvent.drop(rowFor(slot, NESTED), { dataTransfer: transfer });
    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toEqual([
        {
          method: "moveEntries",
          input: { paths: [NOTES.path], destinationDir: NESTED, conflict: "fail" },
        },
      ]);
    });
  });

  it("removes the dragged row on drop and puts it back when the move fails", async () => {
    const gate = deferred();
    const slot = await mountPanel(
      baseRpc({
        moveEntries: async (input) => {
          await gate.promise;
          const paths = (input as { paths: string[] }).paths;
          return {
            succeeded: [],
            failed: paths.map((path) => ({
              path,
              code: "permission_denied" as const,
              message: `EACCES, rename '${path}'`,
            })),
          };
        },
      }),
    );
    const transfer = internalTransfer();

    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.dragStart(rowFor(slot, NOTES.path), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(slot, DOCS), { dataTransfer: transfer });
    fireEvent.drop(rowFor(slot, DOCS), { dataTransfer: transfer });

    // §8.4: "remove the moved rows immediately" — before the round trip ends.
    await waitFor(() => {
      expect(rowPaths(slot)).not.toContain(NOTES.path);
    });
    expect(callsTo(slot, "moveEntries")).toHaveLength(1);

    // "…restore on failure".
    gate.release();
    await waitFor(() => {
      expect(rowPaths(slot)).toContain(NOTES.path);
    });
  });

  it("resolves a file row to its own folder at depth 1 and to the current directory at depth 0", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);
    const intoDocs = internalTransfer();

    // A file row one level deep stands for the folder it lives in.
    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.dragStart(rowFor(slot, NOTES.path), { dataTransfer: intoDocs });
    fireEvent.dragOver(rowFor(slot, INNER.path), { dataTransfer: intoDocs });
    fireEvent.drop(rowFor(slot, INNER.path), { dataTransfer: intoDocs });

    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toHaveLength(1);
    });
    expect(callsTo(slot, "moveEntries")[0]?.input).toEqual({
      paths: [NOTES.path],
      destinationDir: DOCS,
      conflict: "fail",
    });

    // A file row at depth 0 still means "the directory the panel is in".
    const intoRoot = internalTransfer();
    fireEvent.click(rowFor(slot, INNER.path));
    fireEvent.dragStart(rowFor(slot, INNER.path), { dataTransfer: intoRoot });
    fireEvent.dragOver(rowFor(slot, ZETA.path), { dataTransfer: intoRoot });
    fireEvent.drop(rowFor(slot, ZETA.path), { dataTransfer: intoRoot });

    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toHaveLength(2);
    });
    expect(callsTo(slot, "moveEntries")[1]?.input).toEqual({
      paths: [INNER.path],
      destinationDir: ROOT,
      conflict: "fail",
    });
  });

  it("springs a collapsed folder open after the hover dwell, and not before it", async () => {
    const slot = await mountPanel();
    const transfer = internalTransfer();
    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.dragStart(rowFor(slot, NOTES.path), { dataTransfer: transfer });

    vi.useFakeTimers();
    fireEvent.dragOver(rowFor(slot, DOCS), { dataTransfer: transfer });
    act(() => {
      vi.advanceTimersByTime(AUTO_EXPAND_HOVER_MS - 50);
    });
    expect(rowPaths(slot)).not.toContain(NESTED);

    // Leaving the row before the dwell is up cancels it for good.
    fireEvent.dragLeave(rowFor(slot, DOCS), { dataTransfer: transfer });
    act(() => {
      vi.advanceTimersByTime(AUTO_EXPAND_HOVER_MS * 2);
    });
    expect(listDirCallsFor(slot, DOCS)).toHaveLength(0);

    fireEvent.dragOver(rowFor(slot, DOCS), { dataTransfer: transfer });
    act(() => {
      vi.advanceTimersByTime(AUTO_EXPAND_HOVER_MS + 10);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(rowPaths(slot)).toContain(NESTED);
    });
  });

  it("keeps the spring-load dwell across hops inside one row", async () => {
    const slot = await mountPanel();
    const transfer = internalTransfer();
    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.dragStart(rowFor(slot, NOTES.path), { dataTransfer: transfer });

    vi.useFakeTimers();
    fireEvent.dragEnter(rowFor(slot, DOCS), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(slot, DOCS), { dataTransfer: transfer });
    act(() => {
      vi.advanceTimersByTime(AUTO_EXPAND_HOVER_MS - 100);
    });

    // The pointer crosses from one element of the row to another (td → span):
    // the browser fires `dragleave` with a `relatedTarget` still inside the
    // row. Restarting the dwell on those makes it unreachable in practice.
    // The browser fires `dragenter` on the element being entered *before* the
    // `dragleave` of the one being left. jsdom has no DragEvent and
    // fireEvent.dragLeave drops `relatedTarget`, so build it by hand.
    const inside = rowFor(slot, DOCS).querySelector("span");
    if (inside === null) throw new Error("no inner element on the docs row");
    fireEvent(inside, withTransfer(new MouseEvent("dragenter", { bubbles: true }), transfer));
    fireEvent(
      rowFor(slot, DOCS),
      withTransfer(
        new MouseEvent("dragleave", { bubbles: true, relatedTarget: inside }),
        transfer,
      ),
    );
    fireEvent.dragOver(rowFor(slot, DOCS), { dataTransfer: transfer });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(rowPaths(slot)).toContain(NESTED);
    });
  });

  it("uploads an external file drop into the nested folder it landed on", async () => {
    vi.stubGlobal("XMLHttpRequest", SilentXhr as unknown as typeof XMLHttpRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => ({ token: "test-token" }) }) as unknown as Response,
      ),
    );
    let created = 0;
    const slot = await mountPanel(
      baseRpc({
        uploadCreate: () => {
          created += 1;
          return {
            uploadId: `upload-${String(created)}`,
            receivedBytes: 0,
            chunkSizeBytes: 4 * 1024 * 1024,
            resumed: false,
          };
        },
      }),
    );
    await expandFolder(slot, DOCS, NESTED);

    const payload = externalTransfer([new File([new Uint8Array(8)], "dropped.bin")]);
    fireEvent.dragOver(rowFor(slot, NESTED), { dataTransfer: payload });
    fireEvent.drop(rowFor(slot, NESTED), { dataTransfer: payload });

    await waitFor(() => {
      expect(callsTo(slot, "uploadCreate")).toHaveLength(1);
    });
    expect(callsTo(slot, "uploadCreate")[0]?.input).toMatchObject({
      dirPath: NESTED,
      fileName: "dropped.bin",
      relativeDir: "",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Composition with the rest of the panel (§8.2 20-27)                 */
/* ------------------------------------------------------------------ */

describe("the tree next to the rest of the panel (§8.2)", () => {
  it("refetches exactly the cached folder an fs signal names, and nothing else", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);
    expect(listDirCallsFor(slot, DOCS)).toHaveLength(1);

    await slot.behavior.emitRealtime("fs", { paths: [DOCS], reason: "create" });
    await waitFor(() => {
      expect(listDirCallsFor(slot, DOCS)).toHaveLength(2);
    });
    // The current directory is `useDirectory`'s business, not the tree's.
    expect(listDirCallsFor(slot, ROOT)).toHaveLength(1);

    await slot.behavior.emitRealtime("fs", { paths: [`${ROOT}/never-listed`], reason: "create" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callsTo(slot, "listDir")).toHaveLength(3);
  });

  it("does not let a listing in flight overwrite a signal that arrived during it", async () => {
    const gate = deferred();
    const slot = await mountPanel();
    holds.set(DOCS, gate.promise);
    fireEvent.click(chevronFor(slot, DOCS));
    await waitFor(() => {
      expect(listDirCallsFor(slot, DOCS)).toHaveLength(1);
    });

    // The folder changes while its listing is in flight — an upload landing in
    // it, say. The answer already on the wire is stale before it arrives.
    listings[DOCS] = [NESTED_DIR, INNER, makeEntry({ name: "fresh.txt", path: `${DOCS}/fresh.txt` })];
    await slot.behavior.emitRealtime("fs", { paths: [DOCS], reason: "upload" });
    gate.release();
    holds.delete(DOCS);

    // The stale answer must not settle the node as `ready`: the row has to end
    // up showing the post-signal listing without the user touching anything.
    await waitFor(() => {
      expect(rowPaths(slot)).toContain(`${DOCS}/fresh.txt`);
    });
    expect(listDirCallsFor(slot, DOCS).length).toBeGreaterThanOrEqual(2);
  });

  it("refetches every cached node once when the realtime connection comes back", async () => {
    const slot = await mountPanel(baseRpc(), { realtimeConnectionState: "connecting" });
    await expandFolder(slot, DOCS, NESTED);
    await expandFolder(slot, PICS, PHOTO.path);

    await slot.behavior.setRealtimeConnectionState("connected");

    await waitFor(() => {
      expect(listDirCallsFor(slot, DOCS)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(listDirCallsFor(slot, PICS)).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listDirCallsFor(slot, DOCS)).toHaveLength(2);
    expect(listDirCallsFor(slot, PICS)).toHaveLength(2);
  });

  it("refetches an expanded node when the hidden-files toggle flips", async () => {
    listings[DOCS] = [NESTED_DIR, INNER, HIDDEN_IN_DOCS];
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);
    expect(rowPaths(slot)).not.toContain(HIDDEN_IN_DOCS.path);

    fireEvent.click(slot.getByTestId("fm-toggle-hidden"));

    await waitFor(() => {
      expect(rowPaths(slot)).toContain(HIDDEN_IN_DOCS.path);
    });
    expect(listDirCallsFor(slot, DOCS)).toEqual([
      { method: "listDir", input: { path: DOCS, showHidden: false } },
      { method: "listDir", input: { path: DOCS, showHidden: true } },
    ]);
  });

  it("re-sorts the children of every parent client-side, with no new listDir", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, PICS, PHOTO.path);
    expect(rowPaths(slot)).toEqual([
      BROKEN,
      DOCS,
      EMPTY,
      PICS,
      PHOTO.path,
      RAW.path,
      NOTES.path,
      ZETA.path,
    ]);

    fireEvent.click(slot.getByTestId("fm-sort-name"));

    await waitFor(() => {
      expect(rowPaths(slot)).toEqual([
        PICS,
        RAW.path,
        PHOTO.path,
        EMPTY,
        DOCS,
        BROKEN,
        ZETA.path,
        NOTES.path,
      ]);
    });
    expect(callsTo(slot, "listDir")).toHaveLength(2);
  });

  it("keeps a folder visible when only its child survives the filter", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.change(slot.getByTestId("fm-search"), { target: { value: "inner" } });

    await waitFor(() => {
      expect(rowPaths(slot)).toEqual([DOCS, INNER.path]);
    });
    expect(callsTo(slot, "listDir")).toHaveLength(2);
  });

  it("says so when a filtered expansion has nothing left to show", async () => {
    const slot = await mountPanel();
    fireEvent.change(slot.getByTestId("fm-search"), { target: { value: "docs" } });
    await waitFor(() => {
      expect(rowPaths(slot)).toEqual([DOCS]);
    });

    fireEvent.click(chevronFor(slot, DOCS));

    // Neither `nested` nor `inner.txt` matches "docs": §1.2 forbids answering
    // the click with a turned chevron and nothing else.
    const status = await slot.findByTestId("fm-tree-empty");
    expect(status.textContent).toContain("matches the filter");
    expect(rowPaths(slot)).toEqual([DOCS]);
  });

  it("keeps a renamed nested folder expanded, and validates it against its own siblings", async () => {
    const renamed = `${DOCS}/manuals`;
    const slot = await mountPanel(
      baseRpc({
        renameEntry: () => ({ entry: makeDir("manuals", renamed) }),
      }),
    );
    await expandFolder(slot, DOCS, NESTED);
    await expandFolder(slot, NESTED, DEEP.path);

    clickItem(await openRowMenu(slot, NESTED), "Rename");
    const dialog = await slot.findByTestId("fm-rename-dialog");
    const input = within(dialog).getByLabelText("New name");

    // `inner.txt` is a sibling *in docs*: rejected without ever hitting the wire.
    fireEvent.change(input, { target: { value: "inner.txt" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("already exists");
    expect(callsTo(slot, "renameEntry")).toHaveLength(0);

    // A free name in the row's own directory goes through, and the subtree
    // follows the rename instead of collapsing.
    fireEvent.change(input, { target: { value: "manuals" } });
    listings[DOCS] = [makeDir("manuals", renamed), INNER];
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(callsTo(slot, "renameEntry")).toEqual([
        { method: "renameEntry", input: { path: NESTED, newName: "manuals" } },
      ]);
    });
    await waitFor(() => {
      expect(rowPaths(slot)).toContain(renamed);
    });
    expect(rowFor(slot, renamed).getAttribute("aria-expanded")).toBe("true");
    expect(rowPaths(slot)).toContain(`${renamed}/deep.txt`);
    // Re-keyed, not re-fetched: the subtree came back from the cache.
    expect(listDirCallsFor(slot, renamed)).toHaveLength(0);
  });

  it("accepts a name that is only taken in the current directory, not in the row's own", async () => {
    const renamed = `${DOCS}/zeta.txt`;
    const slot = await mountPanel(
      baseRpc({ renameEntry: () => ({ entry: makeDir("zeta.txt", renamed) }) }),
    );
    await expandFolder(slot, DOCS, NESTED);

    clickItem(await openRowMenu(slot, NESTED), "Rename");
    const dialog = await slot.findByTestId("fm-rename-dialog");
    fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: "zeta.txt" } });
    listings[DOCS] = [makeDir("zeta.txt", renamed), INNER];
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(callsTo(slot, "renameEntry")).toHaveLength(1);
    });
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("removes the rows and the expansion of a deleted folder", async () => {
    const slot = await mountPanel(
      baseRpc({
        deleteEntries: (input) => {
          const paths = new Set((input as { paths: string[] }).paths);
          listings[ROOT] = (listings[ROOT] ?? []).filter((entry) => !paths.has(entry.path));
          return { succeeded: [...paths], failed: [] };
        },
      }),
    );
    await expandFolder(slot, DOCS, NESTED);

    fireEvent.click(rowFor(slot, DOCS));
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });
    await slot.findByTestId("fm-delete-dialog");
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(rowPaths(slot)).not.toContain(DOCS);
    });
    expect(rowPaths(slot)).not.toContain(NESTED);
    // The expansion went with it: nothing is open any more.
    await waitFor(() => {
      expect((slot.getByTestId("fm-collapse-all") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("collapses a moved folder instead of leaving a node keyed to a path that is gone", async () => {
    const slot = await mountPanel(
      baseRpc({
        moveEntries: (input) => {
          const paths = new Set((input as { paths: string[] }).paths);
          listings[ROOT] = (listings[ROOT] ?? []).filter((entry) => !paths.has(entry.path));
          return { succeeded: [...paths], failed: [] };
        },
      }),
    );
    await expandFolder(slot, DOCS, NESTED);

    const transfer = internalTransfer();
    fireEvent.click(rowFor(slot, DOCS));
    fireEvent.dragStart(rowFor(slot, DOCS), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(slot, PICS), { dataTransfer: transfer });
    fireEvent.drop(rowFor(slot, PICS), { dataTransfer: transfer });

    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toEqual([
        { method: "moveEntries", input: { paths: [DOCS], destinationDir: PICS, conflict: "fail" } },
      ]);
    });
    await waitFor(() => {
      expect(rowPaths(slot)).not.toContain(DOCS);
    });
    await waitFor(() => {
      expect((slot.getByTestId("fm-collapse-all") as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Persistence (§8.2 28-30, §6)                                        */
/* ------------------------------------------------------------------ */

describe("expanded-set persistence (§6)", () => {
  it("survives a remount of the slot (tier 1)", async () => {
    const first = await mountPanel();
    await expandFolder(first, DOCS, NESTED);
    // Both tiers are written by the same debounced effect (§6: 250 ms), so
    // "the write happened" is the thing to wait for, not a fixed delay.
    await waitFor(() => {
      expect(window.localStorage.getItem(EXPANDED_STORAGE_KEY)).toContain("docs");
    });
    // Knock tier 2 out, so only the module-scope set can answer the remount.
    window.localStorage.clear();
    first.lifecycle.unmount();

    const second = await mountPanel();
    await waitFor(() => {
      expect(rowPaths(second)).toContain(NESTED);
    });
    expect(rowFor(second, DOCS).getAttribute("aria-expanded")).toBe("true");
  });

  it("survives a cold start by reading localStorage (tier 2)", async () => {
    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(EXPANDED_STORAGE_KEY) ?? "[]")).toEqual([DOCS]);
    });

    slot.lifecycle.unmount();
    cleanup();
    // Drop tier 1 the way a fresh page load would.
    resetTreeStore();

    const cold = await mountPanel();
    await waitFor(() => {
      expect(rowPaths(cold)).toContain(NESTED);
    });
    expect(listDirCallsFor(cold, DOCS)).toHaveLength(1);
  });

  it("keeps an expansion made just before the panel goes away", async () => {
    // TREE-SPEC §6 (b): a remount restores the shape. The localStorage write
    // is debounced by 250 ms, so an unmount right after the click used to
    // throw the expansion away in *both* tiers.
    const slot = await mountPanel();
    fireEvent.click(chevronFor(slot, DOCS));
    slot.lifecycle.unmount();

    expect(JSON.parse(window.localStorage.getItem(EXPANDED_STORAGE_KEY) ?? "[]")).toEqual([DOCS]);

    cleanup();
    resetTreeStore();
    const cold = await mountPanel();
    await waitFor(() => {
      expect(rowPaths(cold)).toContain(NESTED);
    });
  });

  it("degrades to an empty tree on a corrupt or out-of-root storage row", async () => {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, "{{{not json");
    const corrupt = await mountPanel();
    expect(rowPaths(corrupt)).toHaveLength(6);
    expect((corrupt.getByTestId("fm-collapse-all") as HTMLButtonElement).disabled).toBe(true);

    corrupt.lifecycle.unmount();
    cleanup();
    resetTreeStore();

    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(["/etc", 42, DOCS]));
    const guarded = await mountPanel();
    await waitFor(() => {
      expect(rowPaths(guarded)).toContain(NESTED);
    });
    // `/etc` is outside the root and was dropped; only `docs` was restored.
    expect(callsTo(guarded, "listDir").map((call) => (call.input as { path: string }).path)).toEqual(
      [ROOT, DOCS],
    );
  });

  it("never persists more than MAX_EXPANDED_PATHS paths", async () => {
    const seeded = Array.from(
      { length: MAX_EXPANDED_PATHS + 50 },
      (_unused, index) => `${ROOT}/seed${String(index)}`,
    );
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(seeded));

    const slot = await mountPanel();
    await expandFolder(slot, DOCS, NESTED);

    await waitFor(() => {
      const stored: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_STORAGE_KEY) ?? "[]");
      expect(Array.isArray(stored) ? stored : []).toContain(DOCS);
    });
    const stored: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_STORAGE_KEY) ?? "[]");
    expect((stored as string[]).length).toBe(MAX_EXPANDED_PATHS);
    // The oldest hydrated path is the one that made room.
    expect(stored as string[]).not.toContain(`${ROOT}/seed50`);
  });
});
