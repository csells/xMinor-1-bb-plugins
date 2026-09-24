// @vitest-environment jsdom
//
// PATHBAR-SPEC §3, §5, §9.2 — the address bar, through the real panel.
//
// The pure judgement of what a typed path *means* lives in
// `test/frontend/fm-pathbar.test.ts`; this file is about the parts only the
// panel can answer for: the two states of the strip, the three ways in, the
// three ways out, what a commit does to the route and the selection, and the
// promise that a path outside the root costs no round trip at all.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract, Preferences } from "../../contract";

const HOST_ID = "host_test";

const toasts = vi.hoisted(() => ({
  error: [] as string[],
  success: [] as string[],
  message: [] as string[],
}));

vi.mock("sonner", () => ({
  toast: {
    error: (text: string) => void toasts.error.push(text),
    success: (text: string) => void toasts.success.push(text),
    message: (text: string) => void toasts.message.push(text),
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
const PROJECTS = `${ROOT}/projects`;
const DRAG_MIME = "application/x-bb-file-manager";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeEntry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: partial.sizeBytes ?? 7,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: partial.isHidden ?? partial.name.startsWith("."),
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    archiveFormat: null,
  };
}

const README = makeEntry({ name: "readme.md" });
const ENV = makeEntry({ name: ".env" });
const DOCS_DIR = makeEntry({ name: "docs", kind: "directory", path: DOCS });
const PROJECTS_DIR = makeEntry({ name: "projects", kind: "directory", path: PROJECTS });
const INNER = makeEntry({ name: "inner.txt", path: `${DOCS}/inner.txt` });
const MY_DOCS = makeEntry({ name: "My Docs", kind: "directory", path: `${ROOT}/My Docs` });
const SHORTCUT = makeEntry({
  name: "shortcut",
  kind: "symlink",
  targetKind: "directory",
  isSymlink: true,
  path: `${ROOT}/shortcut`,
});
const ELSEWHERE = makeEntry({
  name: "elsewhere",
  kind: "symlink",
  targetKind: "directory",
  isSymlink: true,
  escapesRoot: true,
  path: `${ROOT}/elsewhere`,
});

const ENTRIES: Record<string, FileEntry[]> = {
  [ROOT]: [DOCS_DIR, PROJECTS_DIR, MY_DOCS, SHORTCUT, ELSEWHERE, README, ENV],
  [`${ROOT}/My Docs`]: [makeEntry({ name: "spaced.txt", path: `${ROOT}/My Docs/spaced.txt` })],
  [DOCS]: [INNER],
  [PROJECTS]: [makeEntry({ name: "notes.md", path: `${PROJECTS}/notes.md` })],
  [`${ROOT}/shortcut`]: [makeEntry({ name: "linked.txt", path: `${ROOT}/shortcut/linked.txt` })],
};

const PREFERENCES: Preferences = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name",
  sortDirection: "asc",
  viewMode: "list",
};

function listingFor(path: string, showHidden: boolean) {
  const all = ENTRIES[path] ?? [];
  const entries = showHidden ? all : all.filter((entry) => !entry.isHidden);
  return {
    path,
    parentPath: path === ROOT ? null : path.slice(0, path.lastIndexOf("/")),
    isRoot: path === ROOT,
    entries,
    truncated: false,
    totalEntries: entries.length,
    hiddenCount: all.length - entries.length,
    writable: true,
    volume: null,
  };
}

/** Every entry the fixtures know about, keyed by absolute path. */
const BY_PATH = new Map<string, FileEntry>(
  Object.values(ENTRIES)
    .flat()
    .map((entry) => [entry.path, entry]),
);

interface RpcOptions {
  /** Replaces the default `statPath`; the default answers from the fixtures. */
  statPath?: (input: { path: string }) => unknown;
}

function baseRpc(options: RpcOptions = {}): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.4.0",
      primaryHostId: HOST_ID,
    }),
    listDir: (input) => listingFor(input.path, input.showHidden ?? false),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
    moveEntries: (input) => ({ succeeded: (input as { paths: string[] }).paths, failed: [] }),
    statPath: ((input: { path: string }) => {
      if (options.statPath !== undefined) return options.statPath(input);
      const entry = BY_PATH.get(input.path);
      if (entry === undefined) throw new Error(`not_found: ${input.path}`);
      return { entry, parentPath: input.path.slice(0, input.path.lastIndexOf("/")) };
    }) as never,
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
  await waitFor(() => {
    expect(slot.queryAllByTestId("fm-row").length).toBeGreaterThan(0);
  });
  return slot;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement | undefined {
  return slot.queryAllByTestId("fm-row").find((row) => row.getAttribute("data-fm-path") === path);
}

function crumbFor(slot: RenderedSlot, path: string): HTMLElement {
  return slot
    .getByTestId("fm-breadcrumbs")
    .querySelector(`[data-fm-crumb="${path}"]`) as HTMLElement;
}

/** Open the bar the way `Ctrl+L` does and hand back the focused input. */
function openWithShortcut(slot: RenderedSlot): HTMLInputElement {
  fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "l", ctrlKey: true });
  return slot.getByTestId("fm-path-input") as HTMLInputElement;
}

function typeAndCommit(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

/** A DataTransfer that stores what setData wrote, like the real one. */
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
    setData: (format: string, data: string) => void store.set(format, data),
    getData: (format: string) => store.get(format) ?? "",
    clearData: () => store.clear(),
  } as unknown as DataTransfer;
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  toasts.message.length = 0;
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
/* Entering and leaving edit mode (§3.3, §3.5)                         */
/* ------------------------------------------------------------------ */

describe("path bar — the two states (§3.2)", () => {
  it("shows crumbs until asked, then the input, and back again", async () => {
    const slot = await mountPanel();
    expect(slot.getByTestId("fm-breadcrumbs")).toBeDefined();
    expect(slot.queryByTestId("fm-path-input")).toBeNull();

    fireEvent.click(slot.getByTestId("fm-path-edit"));
    expect(slot.getByTestId("fm-path-input")).toBeDefined();
    expect(slot.queryByTestId("fm-breadcrumbs")).toBeNull();
    expect(slot.getByTestId("fm-path-edit").getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(slot.getByTestId("fm-path-input"), { key: "Escape" });
    expect(slot.getByTestId("fm-breadcrumbs")).toBeDefined();
    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(slot.getByTestId("fm-path-edit").getAttribute("aria-pressed")).toBe("false");
  });

  it("opens from Ctrl+L, from the button and from the empty area right of the crumbs", async () => {
    const slot = await mountPanel(baseRpc(), "docs");

    openWithShortcut(slot);
    expect(slot.getByTestId("fm-path-input")).toBeDefined();
    fireEvent.keyDown(slot.getByTestId("fm-path-input"), { key: "Escape" });

    fireEvent.click(slot.getByTestId("fm-path-edit"));
    expect(slot.getByTestId("fm-path-input")).toBeDefined();
    fireEvent.keyDown(slot.getByTestId("fm-path-input"), { key: "Escape" });

    // The click has to land on the nav itself; a crumb is a descendant.
    fireEvent.click(slot.getByTestId("fm-breadcrumbs"));
    expect(slot.getByTestId("fm-path-input")).toBeDefined();
  });

  it("still navigates on a crumb click instead of opening the bar", async () => {
    const slot = await mountPanel(baseRpc(), "docs");

    fireEvent.click(crumbFor(slot, ROOT));

    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "" } },
    ]);
  });

  it("seeds the input with the absolute current path, entirely selected", async () => {
    const slot = await mountPanel(baseRpc(), "docs");

    const input = openWithShortcut(slot);
    expect(input.value).toBe(DOCS);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(DOCS.length);
    expect(document.activeElement).toBe(input);
  });

  it("re-selects the value when Ctrl+L is pressed again instead of resetting it", async () => {
    const slot = await mountPanel(baseRpc(), "docs");
    const input = openWithShortcut(slot);

    fireEvent.change(input, { target: { value: `${DOCS}/x` } });
    input.setSelectionRange(2, 2);
    fireEvent.keyDown(input, { key: "l", ctrlKey: true });

    const again = slot.getByTestId("fm-path-input") as HTMLInputElement;
    expect(again).toBe(input);
    expect(again.value).toBe(`${DOCS}/x`);
    expect(again.selectionStart).toBe(0);
    expect(again.selectionEnd).toBe(`${DOCS}/x`.length);
  });

  it("Escape reverts, returns focus to the grid and leaves the selection alone", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, README.path)!);
    expect(rowFor(slot, README.path)!.getAttribute("data-selected")).toBe("true");

    const input = openWithShortcut(slot);
    fireEvent.change(input, { target: { value: "/etc" } });
    const before = slot.inspection.rpcCalls.length;
    fireEvent.keyDown(input, { key: "Escape" });

    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(document.activeElement).toBe(slot.getByTestId("fm-table"));
    expect(rowFor(slot, README.path)!.getAttribute("data-selected")).toBe("true");
    expect(slot.inspection.rpcCalls).toHaveLength(before);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("blur reverts without committing and without a call", async () => {
    const slot = await mountPanel();
    const input = openWithShortcut(slot);
    fireEvent.change(input, { target: { value: `${ROOT}/docs` } });
    const before = slot.inspection.rpcCalls.length;

    fireEvent.blur(input);

    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(slot.getByTestId("fm-breadcrumbs")).toBeDefined();
    expect(slot.inspection.rpcCalls).toHaveLength(before);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("closes on an empty commit and changes nothing", async () => {
    const slot = await mountPanel();
    const input = openWithShortcut(slot);
    const before = slot.inspection.rpcCalls.length;

    typeAndCommit(input, "   ");

    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(before);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("keeps the crumbs working as drop targets after a revert (§3.5)", async () => {
    const slot = await mountPanel(baseRpc(), "docs");
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "l", ctrlKey: true });
    fireEvent.keyDown(slot.getByTestId("fm-path-input"), { key: "Escape" });

    const transfer = internalTransfer();
    const row = rowFor(slot, INNER.path)!;
    fireEvent.click(row);
    fireEvent.dragStart(row, { dataTransfer: transfer });
    expect(transfer.getData(DRAG_MIME)).not.toBe("");
    fireEvent.dragOver(crumbFor(slot, ROOT), { dataTransfer: transfer });
    fireEvent.drop(crumbFor(slot, ROOT), { dataTransfer: transfer });

    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toEqual([
        {
          method: "moveEntries",
          input: { paths: [INNER.path], destinationDir: ROOT, conflict: "fail" },
        },
      ]);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Committing a folder (§5.2)                                          */
/* ------------------------------------------------------------------ */

describe("path bar — committing a folder (§5.2)", () => {
  it("navigates once and closes the bar", async () => {
    const slot = await mountPanel();
    typeAndCommit(openWithShortcut(slot), `${ROOT}/docs`);

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
      ]);
    });
    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    expect(callsTo(slot, "statPath")).toEqual([
      { method: "statPath", input: { path: DOCS } },
    ]);
  });

  it("does nothing but close when the folder committed is the one on screen", async () => {
    const slot = await mountPanel(baseRpc(), "docs");
    const listings = callsTo(slot, "listDir").length;

    // Ctrl+L and Enter, with the seeded value untouched.
    const input = openWithShortcut(slot);
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(slot.queryByTestId("fm-path-input")).toBeNull();
    });
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(callsTo(slot, "listDir")).toHaveLength(listings);
    expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(DOCS);
  });

  it("accepts `~`, a trailing slash and a quoted value", async () => {
    for (const typed of ["~/docs", `${ROOT}/docs/`, `"${ROOT}/docs"`]) {
      const slot = await mountPanel();
      typeAndCommit(openWithShortcut(slot), typed);
      await waitFor(() => {
        expect(slot.inspection.navigateCalls).toEqual([
          { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
        ]);
      });
      expect(callsTo(slot, "statPath")[0]?.input).toEqual({ path: DOCS });
      cleanup();
      resetLastFolderStore();
      window.localStorage.clear();
    }
  });

  it("opens a folder whose name has spaces, quoted or backslash-escaped", async () => {
    for (const typed of [`"${ROOT}/My Docs"`, `'${ROOT}/My Docs'`, `${ROOT}/My\\ Docs`]) {
      const slot = await mountPanel();
      typeAndCommit(openWithShortcut(slot), typed);
      await waitFor(() => {
        expect(callsTo(slot, "statPath")[0]?.input).toEqual({ path: `${ROOT}/My Docs` });
      });
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "My Docs" } },
      ]);
      cleanup();
      resetLastFolderStore();
      window.localStorage.clear();
    }
  });

  it("resolves a relative path against the folder on screen, not the root (§4.2)", async () => {
    const relative = await mountPanel(baseRpc(), "docs");
    typeAndCommit(openWithShortcut(relative), "inner.txt");
    await waitFor(() => {
      expect(callsTo(relative, "statPath")[0]?.input).toEqual({ path: `${DOCS}/inner.txt` });
    });
    cleanup();
    resetLastFolderStore();
    window.localStorage.clear();

    // The same three characters, `~`-prefixed, mean a different file.
    const tilde = await mountPanel(baseRpc(), "docs");
    typeAndCommit(openWithShortcut(tilde), "~/docs");
    await waitFor(() => {
      expect(callsTo(tilde, "statPath")[0]?.input).toEqual({ path: DOCS });
    });
  });

  it("follows a symlink to a directory by its own path", async () => {
    const slot = await mountPanel();
    typeAndCommit(openWithShortcut(slot), `${ROOT}/shortcut`);

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "shortcut" } },
      ]);
    });
  });

  it("navigates exactly once when Enter is pressed twice (stale-ticket guard)", async () => {
    const gates: Array<(value: unknown) => void> = [];
    const slot = await mountPanel(
      baseRpc({
        statPath: (input) =>
          new Promise((resolve) => {
            gates.push(() =>
              resolve({
                entry: BY_PATH.get(input.path),
                parentPath: input.path.slice(0, input.path.lastIndexOf("/")),
              }),
            );
          }),
      }),
    );

    const input = openWithShortcut(slot);
    typeAndCommit(input, `${ROOT}/docs`);
    await waitFor(() => {
      expect(gates).toHaveLength(1);
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(gates).toHaveLength(2);
    });

    gates[0]?.(undefined);
    gates[1]?.(undefined);

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toHaveLength(1);
    });
    expect(callsTo(slot, "statPath")).toHaveLength(2);
    // Give the losing ticket every chance to navigate behind our back.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slot.inspection.navigateCalls).toHaveLength(1);
  });

  it("drops an answer that arrives after Escape closed the bar", async () => {
    const gates: Array<() => void> = [];
    const slot = await mountPanel(
      baseRpc({
        statPath: (input) =>
          new Promise((resolve) => {
            gates.push(() =>
              resolve({
                entry: BY_PATH.get(input.path),
                parentPath: input.path.slice(0, input.path.lastIndexOf("/")),
              }),
            );
          }),
      }),
    );

    const input = openWithShortcut(slot);
    typeAndCommit(input, `${ROOT}/docs`);
    await waitFor(() => {
      expect(gates).toHaveLength(1);
    });
    fireEvent.keyDown(input, { key: "Escape" });
    gates[0]?.();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(slot.queryByTestId("fm-path-input")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Committing a file (§5.3)                                            */
/* ------------------------------------------------------------------ */

describe("path bar — committing a file (§5.3)", () => {
  it("selects and scrolls to a file that is already on screen, without downloading it", async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");

    const slot = await mountPanel();
    typeAndCommit(openWithShortcut(slot), `${ROOT}/readme.md`);

    await waitFor(() => {
      expect(rowFor(slot, README.path)?.getAttribute("data-selected")).toBe("true");
    });
    expect(rowFor(slot, README.path)?.getAttribute("aria-selected")).toBe("true");
    expect(scrolled.mock.instances).toContain(rowFor(slot, README.path));
    expect(clicked).toHaveLength(0);
    expect(slot.queryByTestId("fm-path-input")).toBeNull();
    // Revealing a row in the folder already on screen is a selection, not a
    // navigation: a history step here would make the next Back do nothing.
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("navigates to the parent folder and reveals the file once its listing lands", async () => {
    const slot = await mountPanel();
    typeAndCommit(openWithShortcut(slot), `${ROOT}/docs/inner.txt`);

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
      ]);
    });
    // The host answers the navigation by re-rendering the panel on the route.
    slot.lifecycle.rerender(<Panel subPath="docs" />);

    await waitFor(() => {
      expect(rowFor(slot, INNER.path)?.getAttribute("data-selected")).toBe("true");
    });
    expect(toasts.message).toHaveLength(0);
  });

  it("turns hidden files on for a hidden file — in state only, never persisted", async () => {
    const slot = await mountPanel();
    expect(rowFor(slot, ENV.path)).toBeUndefined();

    typeAndCommit(openWithShortcut(slot), "~/.env");

    await waitFor(() => {
      expect(rowFor(slot, ENV.path)?.getAttribute("data-selected")).toBe("true");
    });
    expect(toasts.message).toEqual(["Showing hidden files so .env is visible."]);
    expect(callsTo(slot, "savePreferences")).toHaveLength(0);
    expect(callsTo(slot, "listDir").at(-1)?.input).toEqual({ path: ROOT, showHidden: true });
  });

  it("clears the filter box so the revealed row cannot be hidden by it", async () => {
    const slot = await mountPanel();
    const search = slot.getByTestId("fm-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zzz" } });
    await waitFor(() => {
      expect(rowFor(slot, README.path)).toBeUndefined();
    });

    typeAndCommit(openWithShortcut(slot), `${ROOT}/readme.md`);

    await waitFor(() => {
      expect((slot.getByTestId("fm-search") as HTMLInputElement).value).toBe("");
    });
    expect(rowFor(slot, README.path)?.getAttribute("data-selected")).toBe("true");
  });

  it("says so when the file is not in the folder any more", async () => {
    // `statPath` answers for the file, but the listing on screen has no such
    // row — the file was deleted between the two calls.
    const slot = await mountPanel(
      baseRpc({
        statPath: (input) => ({
          entry: makeEntry({ name: "ghost.txt", path: input.path }),
          parentPath: ROOT,
        }),
      }),
    );
    typeAndCommit(openWithShortcut(slot), `${ROOT}/ghost.txt`);

    await waitFor(() => {
      expect(toasts.message).toEqual(["ghost.txt is not in this folder any more."]);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Refusals and failures (§4.3, §5.4)                                  */
/* ------------------------------------------------------------------ */

describe("path bar — refusals (§4.3)", () => {
  it("refuses a path outside the root with no RPC of any kind", async () => {
    const slot = await mountPanel();
    const input = openWithShortcut(slot);
    const before = slot.inspection.rpcCalls.length;

    typeAndCommit(input, "/etc/passwd");

    const alert = slot.getByTestId("fm-path-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(`That path is outside ${ROOT}.`);
    expect(slot.inspection.rpcCalls).toHaveLength(before);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    // Still open, with the text and the input intact.
    expect((slot.getByTestId("fm-path-input") as HTMLInputElement).value).toBe("/etc/passwd");
    expect(slot.getByTestId("fm-path-input").getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses a Windows path and a foreign scheme in the same way", async () => {
    const slot = await mountPanel();
    const input = openWithShortcut(slot);
    const before = slot.inspection.rpcCalls.length;

    typeAndCommit(input, "C:\\Users\\me");
    expect(slot.getByTestId("fm-path-error").textContent).toBe(
      `That looks like a Windows path. This panel opens paths under ${ROOT}.`,
    );

    typeAndCommit(input, "https://example.com/x");
    expect(slot.getByTestId("fm-path-error").textContent).toBe(
      "Only paths on this computer can be opened here.",
    );
    expect(slot.inspection.rpcCalls).toHaveLength(before);
  });

  it("clears the message as soon as the value is edited", async () => {
    const slot = await mountPanel();
    const input = openWithShortcut(slot);
    typeAndCommit(input, "/etc/passwd");
    expect(slot.getByTestId("fm-path-error")).toBeDefined();

    fireEvent.change(input, { target: { value: "/etc/passw" } });
    expect(slot.queryByTestId("fm-path-error")).toBeNull();
  });

  it("refuses a link that leaves the root, using the backend's own verdict", async () => {
    const slot = await mountPanel();
    typeAndCommit(openWithShortcut(slot), `${ROOT}/elsewhere`);

    await waitFor(() => {
      expect(slot.getByTestId("fm-path-error").textContent).toBe(
        `That link does not lead anywhere inside ${ROOT}.`,
      );
    });
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(slot.getByTestId("fm-path-input")).toBeDefined();
  });

  it("says the same thing about a broken link, which the wire cannot tell apart", async () => {
    // `src/listing.ts#entryFrom` sets `escapesRoot` when realpath *throws*, so
    // a dangling link inside the root arrives looking exactly like one that
    // resolves outside it. The sentence has to be true of both (§5.2).
    const broken = makeEntry({
      name: "dangling",
      path: `${ROOT}/dangling`,
      kind: "symlink",
      isSymlink: true,
      escapesRoot: true,
    });
    const slot = await mountPanel(
      baseRpc({ statPath: () => ({ entry: broken, parentPath: ROOT }) }),
    );
    typeAndCommit(openWithShortcut(slot), `${ROOT}/dangling`);

    await waitFor(() => {
      expect(slot.getByTestId("fm-path-error").textContent).toBe(
        `That link does not lead anywhere inside ${ROOT}.`,
      );
    });
    expect(broken.targetKind).toBeNull();
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });
});

describe("path bar — an IME is mid-composition (§3.5)", () => {
  it("lets Enter confirm the candidate instead of committing the draft", async () => {
    const slot = await mountPanel();
    const input = openWithShortcut(slot);

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: `${ROOT}/ドキ` } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(slot, "statPath")).toHaveLength(0);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(slot.getByTestId("fm-path-input")).toBeDefined();

    // The composition ends, and the very same Enter commits.
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(callsTo(slot, "statPath")).toHaveLength(1);
    });
  });

  it("lets Escape cancel the composition without closing the bar", async () => {
    const slot = await mountPanel();
    const input = openWithShortcut(slot);

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: `${ROOT}/ド` } });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229, isComposing: true });

    expect(slot.getByTestId("fm-path-input")).toBeDefined();
    // And the panel's own Escape did not fire either — the key never left the
    // input, which the typing-target guard would have stopped anyway.
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });
});

describe("path bar — backend failures become the message (§5.4)", () => {
  it("names the path the user typed on not_found, and stays open", async () => {
    const slot = await mountPanel();
    const input = openWithShortcut(slot);

    typeAndCommit(input, "~/nope/missing.txt");

    await waitFor(() => {
      expect(slot.getByTestId("fm-path-error").textContent).toBe(
        `There is nothing at ${ROOT}/nope/missing.txt.`,
      );
    });
    expect((slot.getByTestId("fm-path-input") as HTMLInputElement).value).toBe(
      "~/nope/missing.txt",
    );
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("maps permission_denied, path_escape, invalid_path and io_error", async () => {
    const cases: Array<[string, string]> = [
      ["permission_denied: EACCES", `You do not have permission to open ${ROOT}/x.`],
      ["path_escape: outside the root", `That path is outside ${ROOT}.`],
      ["invalid_path: nope", "That path is not valid."],
      ["io_error: disk", "The filesystem reported an error. Try again."],
    ];

    for (const [thrown, expected] of cases) {
      const slot = await mountPanel(
        baseRpc({
          statPath: () => {
            throw new Error(thrown);
          },
        }),
      );
      typeAndCommit(openWithShortcut(slot), `${ROOT}/x`);
      await waitFor(() => {
        expect(slot.getByTestId("fm-path-error").textContent).toBe(expected);
      });
      expect(slot.inspection.navigateCalls).toHaveLength(0);
      cleanup();
      resetLastFolderStore();
      window.localStorage.clear();
    }
  });
});
