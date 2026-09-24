// @vitest-environment jsdom
//
// The keyboard map of §8.3, key by key, plus the cut/copy/paste round trip of
// §8.5. Two rules in that table are as important as the shortcuts themselves:
// keys the panel does not handle must never be preventDefault()ed, and the
// whole map is skipped while the user is typing in an input.
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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

const app = await loadPluginApp(() => import("../../app"));
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore } = await import("../../lib/last-folder");

const registration = app.navPanels[0]!;
const Panel = registration.component;
const ROOT = "/home/coder";
const DOCS = `${ROOT}/docs`;

function makeEntry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: partial.sizeBytes ?? 3,
    modifiedAtMs: partial.modifiedAtMs ?? Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

const A = makeEntry({ name: "a.txt" });
const B = makeEntry({ name: "b.txt" });
const C = makeEntry({ name: "c.txt" });
const FOLDER = makeEntry({ name: "docs", kind: "directory", path: DOCS });

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

function listingFor(path: string) {
  const entries = path === ROOT ? [FOLDER, A, B, C] : [makeEntry({ name: "inner.txt", path: `${path}/inner.txt` })];
  return {
    path,
    parentPath: path === ROOT ? null : path.slice(0, path.lastIndexOf("/")),
    isRoot: path === ROOT,
    entries,
    truncated: false,
    totalEntries: entries.length,
    hiddenCount: 0,
    writable: true,
    volume: null,
  };
}

function baseRpc(
  overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {},
): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.1.0",
      primaryHostId: HOST_ID,
    }),
    listDir: (input) => listingFor(input.path),
    readTextFile: (input) => ({
      path: input.path,
      text: "hello",
      sizeBytes: 5,
      readBytes: 5,
      truncated: false,
    }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
    ...overrides,
  };
}

async function mountPanel(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
  subPath = "",
): Promise<RenderedSlot> {
  const slot = renderSlot(
    { component: registration.component },
    { subPath },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  );
  await slot.findByTestId("fm-table");
  await waitFor(() => {
    expect(slot.queryAllByTestId("fm-row").length).toBeGreaterThan(0);
  });
  return slot;
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement {
  return slot.getAllByTestId("fm-row").find((row) => row.getAttribute("data-fm-path") === path)!;
}

function selectedNames(slot: RenderedSlot): string[] {
  return slot
    .getAllByTestId("fm-row")
    .filter((row) => row.getAttribute("data-selected") === "true")
    .map((row) => (row.getAttribute("data-fm-path") ?? "").slice(ROOT.length + 1));
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

/** fireEvent returns false when a handler called preventDefault(). */
function press(target: HTMLElement, init: Record<string, unknown>): boolean {
  return fireEvent.keyDown(target, init);
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  resetUploadManager();
  resetPanelSnapshot();
  // The location memory decides where the panel opens, so it leaks
  // between mounts unless every suite that mounts one clears it
  // (PATHBAR-SPEC §9.5).
  window.localStorage.clear();
  resetLastFolderStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("keyboard map (§8.3)", () => {
  it("moves the cursor with ArrowDown / ArrowUp and extends with Shift", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");

    press(panel, { key: "ArrowDown" });
    expect(selectedNames(slot)).toEqual(["docs"]);

    press(panel, { key: "ArrowDown" });
    expect(selectedNames(slot)).toEqual(["a.txt"]);

    press(panel, { key: "ArrowDown", shiftKey: true });
    expect(selectedNames(slot)).toEqual(["a.txt", "b.txt"]);

    press(panel, { key: "ArrowUp", shiftKey: true });
    expect(selectedNames(slot)).toEqual(["a.txt"]);

    press(panel, { key: "ArrowUp" });
    expect(selectedNames(slot)).toEqual(["docs"]);
  });

  it("jumps to the first and last row with Home / End", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");

    press(panel, { key: "End" });
    expect(selectedNames(slot)).toEqual(["c.txt"]);

    press(panel, { key: "Home" });
    expect(selectedNames(slot)).toEqual(["docs"]);

    press(panel, { key: "End", shiftKey: true });
    expect(selectedNames(slot)).toEqual(["docs", "a.txt", "b.txt", "c.txt"]);
  });

  it("opens a directory and shows a file with Enter", async () => {
    // This host declines previews, which is what the sidebar's own File
    // Manager page always does (§8.12) — so the file lands in the built-in
    // viewer rather than in the downloads folder.
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");

    fireEvent.click(rowFor(slot, DOCS));
    press(panel, { key: "Enter" });
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
    ]);

    fireEvent.click(rowFor(slot, A.path));
    press(panel, { key: "Enter" });
    await slot.findByTestId("fm-viewer");
    expect(clicked).toHaveLength(0);
  });

  it("goes to the parent with Backspace and with Alt+ArrowLeft", async () => {
    const slot = await mountPanel(baseRpc(), "docs");
    const panel = slot.getByTestId("fm-panel");

    press(panel, { key: "Backspace" });
    press(panel, { key: "ArrowLeft", altKey: true });

    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "" } },
      { method: "toPluginPanel", path: "files", options: { subPath: "" } },
    ]);
  });

  it("does nothing on Backspace at the root", async () => {
    const slot = await mountPanel();
    press(slot.getByTestId("fm-panel"), { key: "Backspace" });
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("opens the rename dialog with F2 only for a single selection", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");

    fireEvent.click(rowFor(slot, A.path));
    fireEvent.click(rowFor(slot, B.path), { ctrlKey: true });
    press(panel, { key: "F2" });
    expect(slot.queryByTestId("fm-rename-dialog")).toBeNull();

    fireEvent.click(rowFor(slot, B.path));
    press(panel, { key: "F2" });
    const dialog = await slot.findByTestId("fm-rename-dialog");
    expect((within(dialog).getByLabelText("New name") as HTMLInputElement).value).toBe("b.txt");
  });

  it("focuses the filter box with Ctrl+F", async () => {
    const slot = await mountPanel();
    press(slot.getByTestId("fm-panel"), { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(slot.getByTestId("fm-search"));
  });

  it("opens the new-folder dialog with Ctrl+Shift+N", async () => {
    const slot = await mountPanel();
    press(slot.getByTestId("fm-panel"), { key: "N", ctrlKey: true, shiftKey: true });
    expect(await slot.findByTestId("fm-new-folder-dialog")).toBeDefined();
  });

  it("toggles hidden files with Ctrl+Shift+.", async () => {
    const slot = await mountPanel();
    press(slot.getByTestId("fm-panel"), { key: ".", ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(callsTo(slot, "listDir")).toHaveLength(2);
    });
    expect(callsTo(slot, "listDir")[1]?.input).toEqual({ path: ROOT, showHidden: true });
    await waitFor(() => {
      expect(callsTo(slot, "savePreferences")).toEqual([
        { method: "savePreferences", input: { showHiddenFiles: true } },
      ]);
    });
  });

  it("Escape over the table clears the selection and leaves the filter alone", async () => {
    // §8.3: "clear search box if focused, else clear selection" — the box is
    // not focused here, so the filter must survive.
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");
    const search = slot.getByTestId("fm-search") as HTMLInputElement;

    fireEvent.change(search, { target: { value: "a" } });
    fireEvent.click(rowFor(slot, A.path));
    expect(selectedNames(slot)).toEqual(["a.txt"]);

    press(panel, { key: "Escape" });
    expect(selectedNames(slot)).toEqual([]);
    expect(search.value).toBe("a");
  });

  it("Escape inside the focused filter box clears it without touching the selection", async () => {
    const slot = await mountPanel();
    const search = slot.getByTestId("fm-search") as HTMLInputElement;

    fireEvent.click(rowFor(slot, A.path));
    fireEvent.change(search, { target: { value: "a" } });
    press(search, { key: "Escape" });

    await waitFor(() => {
      expect(search.value).toBe("");
    });
    expect(selectedNames(slot)).toEqual(["a.txt"]);
  });

  it("leaves F5 and Ctrl+R to the browser (§8.3: not bound)", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");
    const before = callsTo(slot, "listDir").length;

    expect(press(panel, { key: "F5" })).toBe(true);
    expect(press(panel, { key: "r", ctrlKey: true })).toBe(true);
    // Sanity: a key the panel *does* handle is cancelled.
    expect(press(panel, { key: "ArrowDown" })).toBe(false);

    expect(callsTo(slot, "listDir")).toHaveLength(before);
  });

  it("skips the whole map while the event target is a text input", async () => {
    const slot = await mountPanel();
    const search = slot.getByTestId("fm-search");

    press(search, { key: "a", ctrlKey: true });
    press(search, { key: "ArrowDown" });
    press(search, { key: "Delete" });

    expect(selectedNames(slot)).toEqual([]);
    expect(slot.queryByTestId("fm-delete-dialog")).toBeNull();
  });
});

describe("Space — quick look (§8.9)", () => {
  /** The panel plus a host that accepts previews, which `mountPanel` omits. */
  async function mountPreviewing(
    handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
  ): Promise<RenderedSlot> {
    const slot = renderSlot(
      { component: registration.component },
      { subPath: "" },
      {
        rpc: handlers as PluginRpcTestHandlers<FileManagerContract>,
        openFilePreview: () => true,
      },
    ) as RenderedSlot;
    await slot.findByTestId("fm-table");
    await waitFor(() => {
      expect(slot.queryAllByTestId("fm-row").length).toBeGreaterThan(0);
    });
    return slot;
  }

  it("opens the focused file in bb's preview panel, the same way a double click does", async () => {
    const slot = await mountPreviewing();
    const panel = slot.getByTestId("fm-panel");

    fireEvent.click(rowFor(slot, A.path));
    // Cancelled, so the listing does not page down under the cursor.
    expect(press(panel, { key: " " })).toBe(false);

    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "experimental_openFilePreview",
        options: { target: { kind: "host", hostId: HOST_ID, path: A.path }, location: null },
      },
    ]);
  });

  it("shows the file in the built-in viewer when the host declines", async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });
    // No `openFilePreview` option: the host answers false, exactly as a client
    // with no preview surface does.
    const slot = await mountPanel();

    fireEvent.click(rowFor(slot, A.path));
    press(slot.getByTestId("fm-panel"), { key: " " });

    // Still the rule that survives from 0.7: a peek never downloads.
    await slot.findByTestId("fm-viewer");
    expect(clicked).toHaveLength(0);
  });

  it("does not open a folder — that is Enter's job", async () => {
    const slot = await mountPreviewing();
    const panel = slot.getByTestId("fm-panel");

    fireEvent.click(rowFor(slot, DOCS));
    // Still cancelled: the cursor is on a row, and scrolling it away is not an
    // answer to a quick look.
    expect(press(panel, { key: " " })).toBe(false);

    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(callsTo(slot, "listDir")).toHaveLength(1);
  });

  it("leaves Space to the browser when no row is focused", async () => {
    const slot = await mountPreviewing();

    expect(press(slot.getByTestId("fm-panel"), { key: " " })).toBe(true);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("leaves Space alone in the filter box and in the path bar", async () => {
    const slot = await mountPreviewing();
    fireEvent.click(rowFor(slot, A.path));

    const search = slot.getByTestId("fm-search");
    expect(press(search, { key: " " })).toBe(true);
    fireEvent.change(search, { target: { value: "a b" } });
    expect((search as HTMLInputElement).value).toBe("a b");

    press(slot.getByTestId("fm-panel"), { key: "l", ctrlKey: true });
    const input = await slot.findByTestId("fm-path-input");
    expect(press(input, { key: " " })).toBe(true);

    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("leaves Space to the control it belongs to", async () => {
    // A toolbar button is activated by Space. Stealing it here would refresh
    // *and* open a preview from one keystroke.
    const slot = await mountPreviewing();
    fireEvent.click(rowFor(slot, A.path));

    expect(press(slot.getByTestId("fm-refresh"), { key: " " })).toBe(true);

    expect(slot.inspection.navigateCalls).toEqual([]);
  });
});

describe("cut / copy / paste (§8.5)", () => {
  it("Ctrl+X then Ctrl+V moves through moveEntries and clears the clipboard", async () => {
    const slot = await mountPanel(
      baseRpc({ moveEntries: () => ({ succeeded: [A.path], failed: [] }) }),
    );
    const panel = slot.getByTestId("fm-panel");

    fireEvent.click(rowFor(slot, A.path));
    press(panel, { key: "x", ctrlKey: true });
    await waitFor(() => {
      expect(rowFor(slot, A.path).className).toContain("opacity-50");
    });

    slot.lifecycle.rerender(<Panel subPath="docs" />);
    await slot.findByText("inner.txt");
    press(slot.getByTestId("fm-panel"), { key: "v", ctrlKey: true });

    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toEqual([
        {
          method: "moveEntries",
          input: { paths: [A.path], destinationDir: DOCS, conflict: "fail" },
        },
      ]);
    });

    // The cut clipboard is consumed by the paste.
    press(slot.getByTestId("fm-panel"), { key: "v", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(slot, "moveEntries")).toHaveLength(1);
  });

  it("Ctrl+C then Ctrl+V copies through copyEntries and keeps the clipboard", async () => {
    const slot = await mountPanel(
      baseRpc({ copyEntries: () => ({ succeeded: [A.path], failed: [] }) }),
    );
    const panel = slot.getByTestId("fm-panel");

    fireEvent.click(rowFor(slot, A.path));
    fireEvent.click(rowFor(slot, B.path), { ctrlKey: true });
    press(panel, { key: "c", ctrlKey: true });
    expect(rowFor(slot, A.path).className).not.toContain("opacity-50");

    slot.lifecycle.rerender(<Panel subPath="docs" />);
    await slot.findByText("inner.txt");
    press(slot.getByTestId("fm-panel"), { key: "v", ctrlKey: true });

    await waitFor(() => {
      expect(callsTo(slot, "copyEntries")).toEqual([
        {
          method: "copyEntries",
          input: { paths: [A.path, B.path], destinationDir: DOCS, conflict: "rename" },
        },
      ]);
    });

    press(slot.getByTestId("fm-panel"), { key: "v", ctrlKey: true });
    await waitFor(() => {
      expect(callsTo(slot, "copyEntries")).toHaveLength(2);
    });
  });

  it("re-issues the move with overwrite when the conflict dialog says Replace", async () => {
    const moves: unknown[] = [];
    const slot = await mountPanel(
      baseRpc({
        moveEntries: (input) => {
          moves.push(input);
          return moves.length === 1
            ? {
                succeeded: [],
                failed: [{ path: A.path, code: "exists" as const, message: "exists" }],
              }
            : { succeeded: [A.path], failed: [] };
        },
      }),
    );

    fireEvent.click(rowFor(slot, A.path));
    press(slot.getByTestId("fm-panel"), { key: "x", ctrlKey: true });
    slot.lifecycle.rerender(<Panel subPath="docs" />);
    await slot.findByText("inner.txt");
    press(slot.getByTestId("fm-panel"), { key: "v", ctrlKey: true });

    const dialog = await slot.findByTestId("fm-conflict-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }));

    await waitFor(() => {
      expect(moves).toEqual([
        { paths: [A.path], destinationDir: DOCS, conflict: "fail" },
        { paths: [A.path], destinationDir: DOCS, conflict: "overwrite" },
      ]);
    });
  });

  it("refuses to paste a cut folder into itself", async () => {
    const slot = await mountPanel(
      baseRpc({ moveEntries: () => ({ succeeded: [], failed: [] }) }),
    );

    fireEvent.click(rowFor(slot, DOCS));
    press(slot.getByTestId("fm-panel"), { key: "x", ctrlKey: true });

    slot.lifecycle.rerender(<Panel subPath="docs" />);
    await slot.findByText("inner.txt");
    press(slot.getByTestId("fm-panel"), { key: "v", ctrlKey: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(slot, "moveEntries")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* v0.4.0 — the one new binding (PATHBAR-SPEC §7.1, §7.2, §7.3)         */
/* ------------------------------------------------------------------ */

describe("Ctrl/Cmd+L — the address bar (§7.1)", () => {
  it("opens the path bar from the grid, focused and fully selected", async () => {
    const slot = await mountPanel();

    expect(press(slot.getByTestId("fm-panel"), { key: "l", ctrlKey: true })).toBe(false);

    const input = slot.getByTestId("fm-path-input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(ROOT);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, ROOT.length]);
  });

  it("is the one shortcut that works while the filter box has focus (§7.2)", async () => {
    const slot = await mountPanel();
    const search = slot.getByTestId("fm-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "b" } });
    search.focus();

    press(search, { key: "l", ctrlKey: true });

    expect(slot.getByTestId("fm-path-input")).toBeDefined();
    // The filter itself is untouched: this opens a bar, it does not reset the view.
    expect((slot.getByTestId("fm-search") as HTMLInputElement).value).toBe("b");
  });

  it("also answers to Cmd+L, and ignores Ctrl+Shift+L and Alt+L", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");

    press(panel, { key: "l", metaKey: true });
    expect(slot.getByTestId("fm-path-input")).toBeDefined();
    press(slot.getByTestId("fm-path-input"), { key: "Escape" });

    expect(press(panel, { key: "L", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(press(panel, { key: "l", altKey: true })).toBe(true);
    expect(slot.queryByTestId("fm-path-input")).toBeNull();
  });

  it("Escape inside the path input closes the bar and never reaches the selection (§7.3)", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, A.path));
    expect(selectedNames(slot)).toEqual(["a.txt"]);

    press(slot.getByTestId("fm-panel"), { key: "l", ctrlKey: true });
    press(slot.getByTestId("fm-path-input"), { key: "Escape" });

    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(selectedNames(slot)).toEqual(["a.txt"]);
    expect(document.activeElement).toBe(slot.getByTestId("fm-table"));
  });

  it("leaves the rest of the map to the grid while the bar is open", async () => {
    const slot = await mountPanel();
    press(slot.getByTestId("fm-panel"), { key: "l", ctrlKey: true });
    const input = slot.getByTestId("fm-path-input");

    // The typing-target guard still owns everything below Ctrl+L.
    press(input, { key: "ArrowDown" });
    press(input, { key: "Delete" });
    press(input, { key: "F2" });

    expect(selectedNames(slot)).toEqual([]);
    expect(slot.queryByTestId("fm-delete-dialog")).toBeNull();
    expect(slot.queryByTestId("fm-rename-dialog")).toBeNull();
  });

  it("stays out of a portalled overlay: Ctrl+L in a dialog field does nothing", async () => {
    const slot = await mountPanel();
    press(slot.getByTestId("fm-panel"), { key: "N", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    // A portal: the dialog's DOM is outside the panel even though its events
    // bubble up the React tree to the panel's onKeyDown.
    expect(slot.getByTestId("fm-panel").contains(dialog)).toBe(false);

    const field = dialog.querySelector("input") as HTMLInputElement;
    field.focus();
    press(field, { key: "l", ctrlKey: true });

    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // Nor does the rest of the map run from inside the overlay.
    press(dialog, { key: "ArrowDown" });
    press(dialog, { key: "Delete" });
    expect(selectedNames(slot)).toEqual([]);
    expect(slot.queryByTestId("fm-delete-dialog")).toBeNull();
  });

  it("still runs the whole existing map once the bar is closed again", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");
    press(panel, { key: "l", ctrlKey: true });
    press(slot.getByTestId("fm-path-input"), { key: "Escape" });

    press(panel, { key: "ArrowDown" });
    expect(selectedNames(slot)).toEqual(["docs"]);
    press(panel, { key: "End" });
    expect(selectedNames(slot)).toEqual(["c.txt"]);
    press(panel, { key: "Escape" });
    expect(selectedNames(slot)).toEqual([]);
  });
});
