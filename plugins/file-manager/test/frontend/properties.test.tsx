// @vitest-environment jsdom
//
// The Properties dialog of §8.10, as the panel mounts it. Three things carry
// the feature: the dialog has to ask about the *right* path from all three
// entry points, a folder's size has to stay behind the button (and say so when
// the walk was cut short), and closing the dialog mid-walk has to make the
// answer harmless — bb's RPC cannot cancel a call, so an answer that arrives
// late must land on nothing.
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import type {
  DirectorySize,
  FileEntry,
  FileManagerContract,
  PathProperties,
} from "../../contract";

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
// Through the thunk-installed runtime like the app itself: the module binds
// `@get-bb/plugin-sdk/app` at import time (see dialogs.test.tsx).
const { describeKind, needsSizeWalk, summarizeEntries } = await import(
  "../../components/dialogs/PropertiesDialog"
);
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore } = await import("../../lib/last-folder");

const registration = app.navPanels[0]!;
const ROOT = "/home/coder";
const DOCS = `${ROOT}/docs`;

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

function makeEntry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: partial.sizeBytes ?? 12,
    modifiedAtMs: partial.modifiedAtMs ?? Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

const NOTES = makeEntry({ name: "notes.txt", sizeBytes: 12 });
const OTHER = makeEntry({ name: "other.txt", sizeBytes: 30 });
const FOLDER = makeEntry({ name: "docs", kind: "directory", path: DOCS, sizeBytes: 0 });

function makeProperties(partial: Partial<PathProperties> & { name: string }): PathProperties {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    parentPath: partial.parentPath ?? ROOT,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    linkTarget: partial.linkTarget ?? null,
    linkTargetPath: partial.linkTargetPath ?? null,
    sizeBytes: partial.sizeBytes ?? 12,
    modifiedAtMs: partial.modifiedAtMs ?? Date.UTC(2024, 2, 12),
    createdAtMs: partial.createdAtMs ?? null,
    accessedAtMs: partial.accessedAtMs ?? Date.UTC(2024, 2, 13),
    modeOctal: partial.modeOctal ?? "0644",
    modeText: partial.modeText ?? "-rw-r--r--",
    ownerUid: partial.ownerUid ?? 1000,
    ownerGid: partial.ownerGid ?? 1000,
    ownerName: partial.ownerName ?? "coder",
    linkCount: partial.linkCount ?? 1,
    contentType: partial.contentType ?? "text/plain",
  };
}

const FOLDER_PROPERTIES = makeProperties({
  name: "docs",
  path: DOCS,
  kind: "directory",
  contentType: null,
  modeOctal: "0755",
  modeText: "drwxr-xr-x",
  sizeBytes: 4096,
});

function makeSize(partial: Partial<DirectorySize> = {}): DirectorySize {
  return {
    path: partial.path ?? DOCS,
    sizeBytes: partial.sizeBytes ?? 5 * 1024 * 1024,
    fileCount: partial.fileCount ?? 42,
    directoryCount: partial.directoryCount ?? 7,
    visitedEntries: partial.visitedEntries ?? 49,
    partial: partial.partial ?? false,
    stoppedBy: partial.stoppedBy ?? null,
    elapsedMs: partial.elapsedMs ?? 12,
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

function listingFor(path: string) {
  const entries = path === ROOT ? [FOLDER, NOTES, OTHER] : [];
  return {
    path,
    parentPath: path === ROOT ? null : ROOT,
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
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
    pathProperties: (input) =>
      input.path === DOCS
        ? FOLDER_PROPERTIES
        : input.path === ROOT
          ? makeProperties({
              name: "coder",
              path: ROOT,
              parentPath: null,
              kind: "directory",
              contentType: null,
              modeText: "drwxr-xr-x",
              modeOctal: "0755",
            })
          : makeProperties({ name: "notes.txt", path: input.path }),
    directorySize: () => makeSize(),
    ...overrides,
  };
}

async function mountPanel(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): Promise<RenderedSlot> {
  const slot = renderSlot(
    { component: registration.component },
    { subPath: "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  );
  await slot.findByText("notes.txt");
  return slot;
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement {
  return slot.getAllByTestId("fm-row").find((row) => row.getAttribute("data-fm-path") === path)!;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

function clickItem(menu: HTMLElement, label: string): void {
  const item = within(menu)
    .getAllByRole("menuitem")
    .concat(within(menu).queryAllByRole("menuitemcheckbox"))
    .find((candidate) => (candidate.textContent ?? "").startsWith(label));
  if (item === undefined) throw new Error(`no menu item matching ${label}`);
  fireEvent.click(item);
}

async function openViaRowMenu(slot: RenderedSlot, path: string): Promise<HTMLElement> {
  fireEvent.contextMenu(rowFor(slot, path), { button: 2 });
  const menu = await slot.findByTestId("fm-row-menu");
  clickItem(menu, "Properties");
  return slot.findByTestId("fm-properties-dialog");
}

function fieldText(dialog: HTMLElement, id: string): string {
  return within(dialog).getByTestId(`fm-properties-${id}`).textContent ?? "";
}

function escape(): void {
  fireEvent.keyDown(document, { key: "Escape" });
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
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

describe("summarizeEntries", () => {
  it("counts files and folders and adds up only the plain files", () => {
    expect(summarizeEntries([NOTES, OTHER])).toEqual({
      total: 2,
      files: 2,
      folders: 0,
      others: 0,
      knownBytes: 42,
      hasUnmeasured: false,
    });
  });

  it("leaves a folder out of the total and says the total is incomplete", () => {
    const summary = summarizeEntries([FOLDER, NOTES]);
    expect(summary).toMatchObject({ files: 1, folders: 1, knownBytes: 12, hasUnmeasured: true });
  });

  it("counts a symlink by what it points at, but never by its listed size", () => {
    const link = makeEntry({
      name: "alias",
      kind: "symlink",
      targetKind: "file",
      sizeBytes: 9, // length of the target string, not of the file
      isSymlink: true,
    });
    expect(summarizeEntries([link])).toMatchObject({
      files: 1,
      knownBytes: 0,
      hasUnmeasured: true,
    });
  });
});

describe("describeKind / needsSizeWalk", () => {
  it("names what the entry actually is", () => {
    expect(describeKind(makeProperties({ name: "a.txt" }))).toBe("File");
    expect(describeKind(FOLDER_PROPERTIES)).toBe("Folder");
    expect(
      describeKind(
        makeProperties({ name: "l", kind: "symlink", isSymlink: true, targetKind: "directory" }),
      ),
    ).toBe("Symbolic link to folder");
    expect(
      describeKind(
        makeProperties({
          name: "l",
          kind: "symlink",
          isSymlink: true,
          targetKind: null,
          escapesRoot: true,
        }),
      ),
    ).toBe("Symbolic link (unresolved)");
  });

  it("offers the walk for folders and for links into folders, never past the root", () => {
    expect(needsSizeWalk(FOLDER_PROPERTIES)).toBe(true);
    expect(needsSizeWalk(makeProperties({ name: "a.txt" }))).toBe(false);
    expect(
      needsSizeWalk(
        makeProperties({ name: "l", kind: "symlink", isSymlink: true, targetKind: "directory" }),
      ),
    ).toBe(true);
    expect(
      needsSizeWalk(
        makeProperties({
          name: "l",
          kind: "symlink",
          isSymlink: true,
          targetKind: "directory",
          escapesRoot: true,
        }),
      ),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("opening the dialog (§8.10)", () => {
  it("asks about the row the menu was opened on", async () => {
    const slot = await mountPanel();
    const dialog = await openViaRowMenu(slot, NOTES.path);

    await waitFor(() => {
      expect(callsTo(slot, "pathProperties")).toEqual([
        { method: "pathProperties", input: { path: NOTES.path } },
      ]);
    });
    await waitFor(() => {
      expect(fieldText(dialog, "name")).toBe("notes.txt");
    });
    expect(fieldText(dialog, "kind")).toBe("File");
    expect(fieldText(dialog, "type")).toBe("text/plain");
    expect(fieldText(dialog, "size")).toBe("12 B");
    expect(fieldText(dialog, "permissions")).toBe("-rw-r--r-- (0644)");
    expect(fieldText(dialog, "owner")).toBe("coder (uid 1000, gid 1000)");
    expect(fieldText(dialog, "links")).toBe("1");
    expect(fieldText(dialog, "location")).toBe(ROOT);
  });

  it("opens on Alt+Enter for the selected row, without opening the row itself", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, FOLDER.path));

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Enter", altKey: true });

    await slot.findByTestId("fm-properties-dialog");
    await waitFor(() => {
      expect(callsTo(slot, "pathProperties")).toEqual([
        { method: "pathProperties", input: { path: DOCS } },
      ]);
    });
    // Plain Enter navigates into a folder; Alt+Enter must not (§8.3).
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("falls back to the folder on screen when nothing is selected", async () => {
    const slot = await mountPanel();

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Enter", altKey: true });

    await slot.findByTestId("fm-properties-dialog");
    await waitFor(() => {
      expect(callsTo(slot, "pathProperties")).toEqual([
        { method: "pathProperties", input: { path: ROOT } },
      ]);
    });
  });

  it("describes the current folder from the empty-space menu", async () => {
    const slot = await mountPanel();
    fireEvent.contextMenu(slot.getByTestId("fm-scroll"), { button: 2 });
    const menu = await slot.findByTestId("fm-background-menu");

    clickItem(menu, "Properties");

    const dialog = await slot.findByTestId("fm-properties-dialog");
    await waitFor(() => {
      expect(callsTo(slot, "pathProperties")).toEqual([
        { method: "pathProperties", input: { path: ROOT } },
      ]);
    });
    await waitFor(() => {
      expect(fieldText(dialog, "kind")).toBe("Folder");
    });
  });

  it("closes on Escape", async () => {
    const slot = await mountPanel();
    await openViaRowMenu(slot, NOTES.path);

    escape();

    await waitFor(() => {
      expect(slot.queryByTestId("fm-properties-dialog")).toBeNull();
    });
  });

  it("shows the backend's message when the path cannot be read", async () => {
    const slot = await mountPanel(
      baseRpc({
        pathProperties: () => {
          throw new Error("not_found: /home/coder/notes.txt");
        },
      }),
    );
    const dialog = await openViaRowMenu(slot, NOTES.path);

    await waitFor(() => {
      expect(within(dialog).getByRole("alert").textContent).toBe("/home/coder/notes.txt");
    });
  });
});

describe("several rows at once", () => {
  it("summarises the selection without asking the server about any of it", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.click(rowFor(slot, OTHER.path), { ctrlKey: true });

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Enter", altKey: true });

    const dialog = await slot.findByTestId("fm-properties-dialog");
    expect(fieldText(dialog, "selection")).toBe("2 items");
    expect(fieldText(dialog, "files")).toBe("2");
    expect(fieldText(dialog, "folders")).toBe("0");
    expect(fieldText(dialog, "size")).toBe("42 B");
    expect(callsTo(slot, "pathProperties")).toHaveLength(0);
  });

  it("says the total leaves folders out when one is selected", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, FOLDER.path));
    fireEvent.click(rowFor(slot, NOTES.path), { ctrlKey: true });

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Enter", altKey: true });

    const dialog = await slot.findByTestId("fm-properties-dialog");
    expect(fieldText(dialog, "folders")).toBe("1");
    expect(fieldText(dialog, "size")).toBe("12 B");
    expect(dialog.textContent).toContain("Folders and links are not measured");
  });
});

describe("calculating a folder's size", () => {
  it("keeps the walk behind a button and renders what it counted", async () => {
    const slot = await mountPanel();
    const dialog = await openViaRowMenu(slot, DOCS);

    const button = await within(dialog).findByTestId("fm-properties-calculate");
    expect(callsTo(slot, "directorySize")).toHaveLength(0);

    fireEvent.click(button);

    await waitFor(() => {
      expect(callsTo(slot, "directorySize")).toEqual([
        { method: "directorySize", input: { path: DOCS } },
      ]);
    });
    await waitFor(() => {
      expect(fieldText(dialog, "size")).toContain("5 MB");
    });
    expect(fieldText(dialog, "size")).toContain("42 files in 7 folders");
    expect(within(dialog).queryByTestId("fm-properties-partial")).toBeNull();
  });

  it("marks a capped walk as a lower bound and says which limit stopped it", async () => {
    const slot = await mountPanel(
      baseRpc({
        directorySize: () => makeSize({ partial: true, stoppedBy: "time" }),
      }),
    );
    const dialog = await openViaRowMenu(slot, DOCS);

    fireEvent.click(await within(dialog).findByTestId("fm-properties-calculate"));

    const note = await within(dialog).findByTestId("fm-properties-partial");
    expect(note.textContent).toContain("ran out of time");
    expect(fieldText(dialog, "size")).toContain("over 5 MB");
  });

  it("never offers the walk for a plain file", async () => {
    const slot = await mountPanel();
    const dialog = await openViaRowMenu(slot, NOTES.path);

    await waitFor(() => {
      expect(fieldText(dialog, "size")).toBe("12 B");
    });
    expect(within(dialog).queryByTestId("fm-properties-calculate")).toBeNull();
  });

  it("drops an answer that arrives after the dialog was closed", async () => {
    let release: ((value: DirectorySize) => void) | null = null;
    const pending = new Promise<DirectorySize>((resolve) => {
      release = resolve;
    });
    const slot = await mountPanel(baseRpc({ directorySize: () => pending }));
    const dialog = await openViaRowMenu(slot, DOCS);

    fireEvent.click(await within(dialog).findByTestId("fm-properties-calculate"));
    escape();
    await waitFor(() => {
      expect(slot.queryByTestId("fm-properties-dialog")).toBeNull();
    });

    release!(makeSize());
    await pending;

    // Re-opening asks again from scratch: the retired answer painted nothing.
    const reopened = await openViaRowMenu(slot, DOCS);
    expect(await within(reopened).findByTestId("fm-properties-calculate")).toBeDefined();
    expect(callsTo(slot, "directorySize")).toHaveLength(1);
  });
});
