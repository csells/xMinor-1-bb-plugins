// @vitest-environment jsdom
//
// Bookmarks (§8.11) from the panel's side: what the star does, what the list
// does, where each of them lives in the two chromes, and which RPC every one
// of those produces. The backend suite owns the storage rules; this one owns
// "the control the user pressed sent exactly this".
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import { MAX_BOOKMARKS, type Bookmark, type FileEntry, type FileManagerContract } from "../../contract";
import { BOOKMARKS_FULL_TEXT, findBookmark, isBookmarked } from "../../lib/bookmarks";

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

const app = await loadPluginApp(() => import("../../app"));
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore } = await import("../../lib/last-folder");

const navRegistration = app.navPanels[0]!;
const threadAction = app.threadPanelActions[0]!;
const ROOT = "/home/coder";
const DOCS = `${ROOT}/docs`;
const PICS = `${ROOT}/pics`;

// Radix positions its menus through floating-ui, which observes the anchor.
class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

function entryFor(name: string, kind: FileEntry["kind"] = "file", parent = ROOT): FileEntry {
  return {
    name,
    path: `${parent}/${name}`,
    kind,
    targetKind: null,
    sizeBytes: 12,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
  };
}

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

function listing(path: string, entries: readonly FileEntry[]) {
  return {
    path,
    parentPath: path === ROOT ? null : ROOT,
    isRoot: path === ROOT,
    entries: [...entries],
    truncated: false,
    totalEntries: entries.length,
    hiddenCount: 0,
    writable: true,
    volume: null,
  };
}

/** The fake backend's bookmark row: order is the array index, as on the server. */
interface Row {
  path: string;
  name: string;
  available?: boolean;
}

/** Mutable across one test, so add/remove really change what `list` answers. */
let rows: Row[] = [];

function currentList(): { bookmarks: Bookmark[] } {
  return {
    bookmarks: rows.map((row, order) => ({
      path: row.path,
      name: row.name,
      order,
      available: row.available ?? true,
    })),
  };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function baseRpc(
  overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {},
): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  const tree: Record<string, ReturnType<typeof listing>> = {
    [ROOT]: listing(ROOT, [
      entryFor("docs", "directory"),
      entryFor("pics", "directory"),
      entryFor("notes.txt"),
    ]),
    [DOCS]: listing(DOCS, [entryFor("spec.md", "file", DOCS)]),
    [PICS]: listing(PICS, []),
  };
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.6.3",
      primaryHostId: HOST_ID,
    }),
    listDir: (input) => {
      const found = tree[input.path];
      if (found === undefined) throw new Error(`not_found: ${input.path}`);
      return found;
    },
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
    listBookmarks: () => currentList(),
    addBookmark: (input) => {
      if (!rows.some((row) => row.path === input.path)) {
        rows = [...rows, { path: input.path, name: input.name ?? baseName(input.path) }];
      }
      return currentList();
    },
    removeBookmark: (input) => {
      rows = rows.filter((row) => row.path !== input.path);
      return currentList();
    },
    renameBookmark: (input) => {
      rows = rows.map((row) => (row.path === input.path ? { ...row, name: input.name } : row));
      return currentList();
    },
    ...overrides,
  };
}

async function mountPanel(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): Promise<RenderedSlot> {
  const slot = renderSlot(
    { component: navRegistration.component },
    { subPath: "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  );
  await slot.findByText("notes.txt");
  // The star is disabled until the list lands, so every test would otherwise
  // have to race it.
  await waitFor(() => {
    expect((slot.getByTestId("fm-bookmark-toggle") as HTMLButtonElement).disabled).toBe(false);
  });
  return slot;
}

async function mountTab(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): Promise<RenderedSlot> {
  const slot = renderSlot(
    { component: threadAction.component },
    { threadId: "thr_1", params: null },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  ) as RenderedSlot;
  await slot.findByText("notes.txt");
  return slot;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

/** Radix opens a DropdownMenu on pointerdown, not on click. */
function openDropdown(slot: RenderedSlot, triggerTestId: string): void {
  fireEvent.pointerDown(slot.getByTestId(triggerTestId), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

async function openBookmarksMenu(slot: RenderedSlot): Promise<HTMLElement> {
  openDropdown(slot, "fm-bookmarks-menu");
  return slot.findByTestId("fm-bookmarks-list");
}

function itemStarting(scope: HTMLElement, label: string): HTMLElement {
  const item = within(scope)
    .getAllByRole("menuitem")
    .concat(within(scope).queryAllByRole("menuitemcheckbox"))
    .find((candidate) => (candidate.textContent ?? "").startsWith(label));
  if (item === undefined) {
    throw new Error(
      `no menu item matching "${label}"; saw ${within(scope)
        .getAllByRole("menuitem")
        .map((node) => node.textContent ?? "")
        .join(" | ")}`,
    );
  }
  return item;
}

async function openRowMenu(slot: RenderedSlot, path: string): Promise<HTMLElement> {
  const row = slot
    .getAllByTestId("fm-row")
    .find((candidate) => candidate.getAttribute("data-fm-path") === path)!;
  fireEvent.contextMenu(row, { button: 2 });
  return slot.findByTestId("fm-row-menu");
}

async function openBackgroundMenu(slot: RenderedSlot): Promise<HTMLElement> {
  fireEvent.contextMenu(slot.getByTestId("fm-scroll"), { button: 2 });
  return slot.findByTestId("fm-background-menu");
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  rows = [];
  resetUploadManager();
  resetPanelSnapshot();
  window.localStorage.clear();
  resetLastFolderStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("the pure half (lib/bookmarks.ts)", () => {
  const list: Bookmark[] = [
    { path: DOCS, name: "Docs", order: 0, available: true },
    { path: PICS, name: "Pics", order: 1, available: false },
  ];

  it("matches a path whatever trailing slash it arrived with", () => {
    expect(isBookmarked(list, DOCS)).toBe(true);
    expect(isBookmarked(list, `${DOCS}/`)).toBe(true);
    expect(isBookmarked(list, `${ROOT}/docs2`)).toBe(false);
    // "" is the panel before the bootstrap, not the root.
    expect(isBookmarked(list, "")).toBe(false);
    expect(isBookmarked([], DOCS)).toBe(false);
  });

  it("finds the row so the rename dialog can open on its current name", () => {
    expect(findBookmark(list, `${PICS}/`)?.name).toBe("Pics");
    expect(findBookmark(list, ROOT)).toBeNull();
    expect(findBookmark(list, "")).toBeNull();
  });
});

describe("the toolbar star", () => {
  it("is dark for a folder that is not bookmarked and lit for one that is", async () => {
    rows = [{ path: ROOT, name: "Home" }];
    const slot = await mountPanel();

    expect(slot.getByTestId("fm-bookmark-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByTestId("fm-bookmark-toggle").getAttribute("aria-label")).toBe(
      "Remove bookmark",
    );
  });

  it("adds on the first click and removes on the second", async () => {
    const slot = await mountPanel();
    const star = slot.getByTestId("fm-bookmark-toggle");
    expect(star.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(star);
    await waitFor(() => {
      expect(callsTo(slot, "addBookmark")).toEqual([
        { method: "addBookmark", input: { path: ROOT, name: null } },
      ]);
    });
    await waitFor(() => {
      expect(slot.getByTestId("fm-bookmark-toggle").getAttribute("aria-pressed")).toBe("true");
    });

    fireEvent.click(slot.getByTestId("fm-bookmark-toggle"));
    await waitFor(() => {
      expect(callsTo(slot, "removeBookmark")).toEqual([
        { method: "removeBookmark", input: { path: ROOT } },
      ]);
    });
    await waitFor(() => {
      expect(slot.getByTestId("fm-bookmark-toggle").getAttribute("aria-pressed")).toBe("false");
    });
  });

  it("says what to do instead of asking the server for the 51st", async () => {
    rows = Array.from({ length: MAX_BOOKMARKS }, (_, index) => ({
      path: `${ROOT}/p${String(index)}`,
      name: `p${String(index)}`,
    }));
    const slot = await mountPanel();

    // Enabled on purpose: a grey star would not explain itself.
    expect((slot.getByTestId("fm-bookmark-toggle") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(slot.getByTestId("fm-bookmark-toggle"));

    await waitFor(() => {
      expect(toasts.error).toContain(BOOKMARKS_FULL_TEXT);
    });
    expect(callsTo(slot, "addBookmark")).toEqual([]);
  });

  it("reports a rejected add instead of swallowing it", async () => {
    const slot = await mountPanel(
      baseRpc({
        addBookmark: () => {
          throw new Error("permission_denied: /home/coder");
        },
      }),
    );

    fireEvent.click(slot.getByTestId("fm-bookmark-toggle"));
    await waitFor(() => {
      expect(toasts.error).toContain("Permission denied.");
    });
    expect(slot.getByTestId("fm-bookmark-toggle").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the bookmark list", () => {
  it("goes to a bookmark in one click, through the panel's own navigation", async () => {
    rows = [{ path: DOCS, name: "Docs" }];
    const slot = await mountPanel();

    fireEvent.click(itemStarting(await openBookmarksMenu(slot), "Docs"));

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
      ]);
    });
  });

  it("marks a bookmark whose folder is gone, and removes it when chosen", async () => {
    rows = [{ path: PICS, name: "Pics", available: false }];
    const slot = await mountPanel();

    const menu = await openBookmarksMenu(slot);
    const missing = within(menu).getByTestId("fm-bookmark-missing");
    expect(missing.textContent).toContain("Pics");
    expect(missing.textContent).toContain("Missing");
    expect(within(menu).queryByTestId("fm-bookmark")).toBeNull();

    fireEvent.click(missing);
    await waitFor(() => {
      expect(callsTo(slot, "removeBookmark")).toEqual([
        { method: "removeBookmark", input: { path: PICS } },
      ]);
    });
  });

  it("says the list is empty rather than showing an empty menu", async () => {
    const slot = await mountPanel();
    const menu = await openBookmarksMenu(slot);
    expect(within(menu).getByTestId("fm-bookmarks-empty").textContent).toContain(
      "No bookmarks yet",
    );
  });

  it("re-reads the list every time it opens, because 'missing' goes stale", async () => {
    rows = [{ path: DOCS, name: "Docs" }];
    const slot = await mountPanel();
    const afterMount = callsTo(slot, "listBookmarks").length;

    await openBookmarksMenu(slot);
    await waitFor(() => {
      expect(callsTo(slot, "listBookmarks").length).toBeGreaterThan(afterMount);
    });
  });

  it("renames the current folder's bookmark through the dialog", async () => {
    rows = [{ path: ROOT, name: "Home" }];
    const slot = await mountPanel();

    fireEvent.click(within(await openBookmarksMenu(slot)).getByTestId("fm-bookmark-rename"));

    const dialog = await slot.findByTestId("fm-bookmark-name-dialog");
    const input = within(dialog).getByLabelText("Bookmark name") as HTMLInputElement;
    expect(input.value).toBe("Home");

    fireEvent.change(input, { target: { value: "Everything" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(callsTo(slot, "renameBookmark")).toEqual([
        { method: "renameBookmark", input: { path: ROOT, name: "Everything" } },
      ]);
    });
  });

  it("offers no rename for a folder that is not bookmarked", async () => {
    const slot = await mountPanel();
    const menu = await openBookmarksMenu(slot);
    expect(within(menu).queryByTestId("fm-bookmark-rename")).toBeNull();
    expect(within(menu).getByTestId("fm-bookmark-toggle-item").textContent).toContain(
      "Bookmark this folder",
    );
  });
});

describe("the context menus", () => {
  it("bookmarks the current folder from the empty-space menu", async () => {
    const slot = await mountPanel();

    fireEvent.click(within(await openBackgroundMenu(slot)).getByTestId("fm-background-bookmark"));
    await waitFor(() => {
      expect(callsTo(slot, "addBookmark")).toEqual([
        { method: "addBookmark", input: { path: ROOT, name: null } },
      ]);
    });

    const menu = await openBackgroundMenu(slot);
    expect(within(menu).getByTestId("fm-background-bookmark").textContent).toContain(
      "Remove bookmark",
    );
  });

  it("bookmarks a folder row, and offers nothing of the sort for a file", async () => {
    const slot = await mountPanel();

    const folderMenu = await openRowMenu(slot, DOCS);
    expect(within(folderMenu).getByTestId("fm-row-bookmark").textContent).toContain("Bookmark");
    fireEvent.click(within(folderMenu).getByTestId("fm-row-bookmark"));

    await waitFor(() => {
      expect(callsTo(slot, "addBookmark")).toEqual([
        { method: "addBookmark", input: { path: DOCS, name: null } },
      ]);
    });

    const fileMenu = await openRowMenu(slot, `${ROOT}/notes.txt`);
    expect(within(fileMenu).queryByTestId("fm-row-bookmark")).toBeNull();
  });
});

describe("the compact chrome (§10.1)", () => {
  it("keeps the star on the strip and moves the list into the overflow", async () => {
    rows = [{ path: DOCS, name: "Docs" }];
    const slot = await mountTab();

    // The one bookmark control a ~450px column has room for.
    expect(slot.getByTestId("fm-bookmark-toggle")).toBeDefined();
    expect(slot.queryByTestId("fm-bookmarks-menu")).toBeNull();

    openDropdown(slot, "fm-panel-overflow");
    const overflow = await slot.findByRole("menu");
    expect(within(overflow).getByTestId("fm-bookmark").textContent).toContain("Docs");
    // The list sits above the panel actions, not buried under them.
    expect(within(overflow).getByTestId("fm-panel-refresh")).toBeDefined();
  });

  it("navigates from the overflow without touching the route", async () => {
    rows = [{ path: DOCS, name: "Docs" }];
    const slot = await mountTab();

    openDropdown(slot, "fm-panel-overflow");
    const overflow = await slot.findByRole("menu");
    fireEvent.click(within(overflow).getByTestId("fm-bookmark"));

    await waitFor(() => {
      expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(DOCS);
    });
    // A panel tab owns no route: navigating through one would take the thread
    // off screen (§10.1).
    expect(slot.inspection.navigateCalls).toEqual([]);
  });
});
