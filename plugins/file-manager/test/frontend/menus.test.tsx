// @vitest-environment jsdom
//
// The two context menus of §8.2 and what each item actually sends over the
// wire. Every assertion here is "this menu item produced exactly this RPC with
// exactly these arguments" — the menu is the only place most of the contract's
// mutations can be reached from.
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract, Job } from "../../contract";
import { CompactViewportOverrideProvider } from "../../components/ui/hooks/use-compact-viewport";
import { CoarsePointerOverrideProvider } from "../../components/ui/hooks/use-coarse-pointer";

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
const ROOT = "/home/coder";
const DOCS = `${ROOT}/docs`;

// Radix menus position themselves through floating-ui, which observes the
// anchor; jsdom has no ResizeObserver in every runtime we support.
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

const NOTES = makeEntry({ name: "notes.txt" });
const OTHER = makeEntry({ name: "other.txt" });
const FOLDER = makeEntry({ name: "docs", kind: "directory", path: DOCS });
const ARCHIVE = makeEntry({ name: "bundle.zip", archiveFormat: "zip", sizeBytes: 4096 });

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

const RUNNING_JOB: Job = {
  jobId: "job-1",
  kind: "extract",
  state: "running",
  label: 'Extracting "bundle.zip"',
  startedAtMs: 1,
  finishedAtMs: null,
  processedBytes: 0,
  totalBytes: 4096,
  resultPath: null,
  errorCode: null,
  errorMessage: null,
};

function listingFor(path: string) {
  const entries = path === ROOT ? [FOLDER, ARCHIVE, NOTES, OTHER] : [];
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

async function mountPanelForInteraction(
  interaction: { compact: boolean; coarsePointer: boolean },
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): Promise<RenderedSlot> {
  const Panel = registration.component;
  function InteractionPanel(props: ComponentProps<typeof Panel>) {
    return (
      <CompactViewportOverrideProvider isCompactViewport={interaction.compact}>
        <CoarsePointerOverrideProvider isCoarsePointer={interaction.coarsePointer}>
          <Panel {...props} />
        </CoarsePointerOverrideProvider>
      </CompactViewportOverrideProvider>
    );
  }
  const slot = renderSlot(
    { component: InteractionPanel },
    { subPath: "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  );
  await slot.findByText("notes.txt");
  return slot;
}

async function mountCompactPanel(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): Promise<RenderedSlot> {
  return mountPanelForInteraction({ compact: true, coarsePointer: true }, handlers);
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement {
  return slot
    .getAllByTestId("fm-row")
    .find((row) => row.getAttribute("data-fm-path") === path)!;
}

async function openRowMenu(slot: RenderedSlot, path: string): Promise<HTMLElement> {
  fireEvent.contextMenu(rowFor(slot, path), { button: 2 });
  return slot.findByTestId("fm-row-menu");
}

async function openBackgroundMenu(slot: RenderedSlot): Promise<HTMLElement> {
  fireEvent.contextMenu(slot.getByTestId("fm-scroll"), { button: 2 });
  return slot.findByTestId("fm-background-menu");
}

/** The item a `pointerup` would land on when the menu flips under the cursor. */
function itemIn(menu: HTMLElement, label: string | RegExp): HTMLElement {
  return within(menu)
    .getAllByRole("menuitem")
    .concat(within(menu).queryAllByRole("menuitemcheckbox"))
    .find((candidate) =>
      typeof label === "string"
        ? (candidate.textContent ?? "").startsWith(label)
        : label.test(candidate.textContent ?? ""),
    )!;
}

function clickItem(menu: HTMLElement, label: string | RegExp): void {
  const item = within(menu)
    .getAllByRole("menuitem")
    .concat(within(menu).queryAllByRole("menuitemcheckbox"))
    .find((candidate) =>
      typeof label === "string"
        ? (candidate.textContent ?? "").startsWith(label)
        : label.test(candidate.textContent ?? ""),
    );
  if (item === undefined) {
    throw new Error(
      `no menu item matching ${String(label)}; saw ${within(menu)
        .getAllByRole("menuitem")
        .map((node) => node.textContent ?? "")
        .join(" | ")}`,
    );
  }
  fireEvent.click(item);
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

const clipboardWrites: string[] = [];

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  clipboardWrites.length = 0;
  resetUploadManager();
  resetPanelSnapshot();
  // The location memory decides where the panel opens, so it leaks
  // between mounts unless every suite that mounts one clears it
  // (PATHBAR-SPEC §9.5).
  window.localStorage.clear();
  resetLastFolderStore();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("keyboard access to the menus (§8.3)", () => {
  it("opens the row menu on Shift+F10 for the focused row", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, NOTES.path));

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "F10", shiftKey: true });

    const menu = await slot.findByTestId("fm-row-menu");
    expect(menu.textContent).toContain("notes.txt");
  });

  it("opens the background menu on the Menu key with nothing focused", async () => {
    const slot = await mountPanel();

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "ContextMenu" });

    await slot.findByTestId("fm-background-menu");
  });
});

describe("compact viewport selection actions", () => {
  it("replaces native dragging with a touch-friendly selected-item menu", async () => {
    const slot = await mountCompactPanel();
    const row = rowFor(slot, NOTES.path);

    fireEvent.click(within(row).getByRole("checkbox"));

    expect(row.draggable).toBe(false);
    expect(slot.getByTestId("fm-selection-bar").textContent).toContain("1 selected");

    fireEvent.click(slot.getByRole("button", { name: "Actions for 1 selected item" }));
    const menu = await slot.findByTestId("fm-selection-menu");
    expect(menu.textContent).toContain("Download");
    expect(menu.textContent).toContain("Add to chat");
    expect(menu.textContent).toContain("Rename");
    expect(menu.textContent).toContain("Delete");

    clickItem(menu, "Copy path");
    await waitFor(() => expect(clipboardWrites).toEqual([NOTES.path]));

    fireEvent.click(slot.getByRole("button", { name: "Clear selection" }));
    expect(row.getAttribute("data-selected")).toBeNull();
    expect(slot.queryByTestId("fm-selection-bar")).toBeNull();
  });

  it("keeps native dragging and the context-menu UI on desktop", async () => {
    const slot = await mountPanel();
    const row = rowFor(slot, NOTES.path);

    fireEvent.click(within(row).getByRole("checkbox"));

    expect(row.draggable).toBe(true);
    expect(slot.queryByTestId("fm-selection-bar")).toBeNull();
  });

  it("uses touch actions on a wide coarse-pointer device", async () => {
    const slot = await mountPanelForInteraction({ compact: false, coarsePointer: true });
    const row = rowFor(slot, NOTES.path);

    fireEvent.click(within(row).getByRole("checkbox"));

    expect(row.draggable).toBe(false);
    expect(slot.getByTestId("fm-selection-bar").textContent).toContain("1 selected");
  });

  it("disables native gallery-tile dragging on a wide coarse-pointer device", async () => {
    const slot = await mountPanelForInteraction(
      { compact: false, coarsePointer: true },
      baseRpc({
        getState: () => ({
          root: ROOT,
          startFolder: ROOT,
          preferences: { ...PREFERENCES, viewMode: "gallery" },
          chunkSizeBytes: 8 * 1024 * 1024,
          maxListEntries: 5000,
          archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
          pluginVersion: "0.1.0",
          primaryHostId: HOST_ID,
        }),
      }),
    );
    const tile = (await slot.findAllByTestId("fm-tile")).find(
      (candidate) => candidate.getAttribute("data-fm-path") === NOTES.path,
    )!;

    expect(tile.draggable).toBe(false);
    fireEvent.click(within(tile).getByRole("checkbox"));
    expect(slot.getByTestId("fm-selection-bar").textContent).toContain("1 selected");
  });

  it("keeps desktop and touch action availability in parity", async () => {
    const desktopSlot = await mountPanel();
    const desktopMenu = await openRowMenu(desktopSlot, NOTES.path);
    const desktopActions = within(desktopMenu)
      .getAllByRole("menuitem")
      .map((item) => ({
        id:
          item
            .querySelector("[data-fm-selected-action]")
            ?.getAttribute("data-fm-selected-action") ?? null,
        disabled: item.getAttribute("aria-disabled") === "true",
      }));

    cleanup();
    window.localStorage.clear();
    resetLastFolderStore();

    const touchSlot = await mountCompactPanel();
    const row = rowFor(touchSlot, NOTES.path);
    fireEvent.click(within(row).getByRole("checkbox"));
    fireEvent.click(touchSlot.getByRole("button", { name: "Actions for 1 selected item" }));
    const touchMenu = await touchSlot.findByTestId("fm-selection-menu");
    const touchActions = within(touchMenu)
      .getAllByRole("menuitem")
      .map((item) => ({
        id:
          item
            .querySelector("[data-fm-selected-action]")
            ?.getAttribute("data-fm-selected-action") ?? null,
        disabled: item.getAttribute("aria-disabled") === "true",
      }));

    expect(touchActions).toEqual(desktopActions);
    expect(touchActions.every((action) => action.id !== null)).toBe(true);
  });
});

describe("row context menu (§8.2)", () => {
  it("selects the row it was opened on when it was not already selected", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, OTHER.path));

    const menu = await openRowMenu(slot, NOTES.path);
    expect(rowFor(slot, NOTES.path).getAttribute("data-selected")).toBe("true");
    expect(rowFor(slot, OTHER.path).getAttribute("data-selected")).toBeNull();
    expect(menu.textContent).toContain("notes.txt");
  });

  it("offers the §8.2 actions for a file", async () => {
    const slot = await mountPanel();
    const menu = await openRowMenu(slot, NOTES.path);
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");

    expect(labels.some((label) => label.startsWith("Download"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Rename"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Cut"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Copy") && !label.includes("path"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Delete"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Extract"))).toBe(false);
  });

  it("Download starts the byte-transfer route for the selected file", async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });

    const slot = await mountPanel();
    clickItem(await openRowMenu(slot, NOTES.path), "Download");

    await waitFor(() => {
      expect(clicked).toHaveLength(1);
    });
    expect(clicked[0]).toContain(
      `/api/v1/plugins/file-manager/http/download?path=${encodeURIComponent(NOTES.path)}`,
    );
  });

  it("Rename opens the dialog and calls renameEntry with the new name", async () => {
    const slot = await mountPanel(baseRpc({ renameEntry: () => ({ entry: makeEntry({ name: "renamed.txt" }) }) }));
    clickItem(await openRowMenu(slot, NOTES.path), "Rename");

    const dialog = await slot.findByTestId("fm-rename-dialog");
    const input = within(dialog).getByLabelText("New name");
    expect((input as HTMLInputElement).value).toBe("notes.txt");

    fireEvent.change(input, { target: { value: "renamed.txt" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(callsTo(slot, "renameEntry")).toEqual([
        { method: "renameEntry", input: { path: NOTES.path, newName: "renamed.txt" } },
      ]);
    });
  });

  it("Move to… moves the selection into the folder chosen in the picker", async () => {
    const slot = await mountPanel(
      baseRpc({ moveEntries: () => ({ succeeded: [NOTES.path], failed: [] }) }),
    );
    clickItem(await openRowMenu(slot, NOTES.path), "Move to");

    const picker = await slot.findByTestId("fm-folder-picker");
    const folder = await within(picker).findByTestId("fm-picker-folder");
    fireEvent.click(folder);
    fireEvent.click(within(picker).getByRole("button", { name: "Choose this folder" }));

    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toEqual([
        {
          method: "moveEntries",
          input: { paths: [NOTES.path], destinationDir: DOCS, conflict: "fail" },
        },
      ]);
    });
  });

  it("Copy to… copies with the rename conflict policy", async () => {
    const slot = await mountPanel(
      baseRpc({ copyEntries: () => ({ succeeded: [NOTES.path], failed: [] }) }),
    );
    clickItem(await openRowMenu(slot, NOTES.path), "Copy to");

    const picker = await slot.findByTestId("fm-folder-picker");
    fireEvent.click(await within(picker).findByTestId("fm-picker-folder"));
    fireEvent.click(within(picker).getByRole("button", { name: "Choose this folder" }));

    await waitFor(() => {
      expect(callsTo(slot, "copyEntries")).toEqual([
        {
          method: "copyEntries",
          input: { paths: [NOTES.path], destinationDir: DOCS, conflict: "rename" },
        },
      ]);
    });
  });

  it("Delete confirms first, then calls deleteEntries for the selection", async () => {
    const slot = await mountPanel(
      baseRpc({ deleteEntries: () => ({ succeeded: [NOTES.path], failed: [] }) }),
    );
    clickItem(await openRowMenu(slot, NOTES.path), "Delete");

    const dialog = await slot.findByTestId("fm-delete-dialog");
    expect(callsTo(slot, "deleteEntries")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(callsTo(slot, "deleteEntries")).toEqual([
        { method: "deleteEntries", input: { paths: [NOTES.path], recursive: true } },
      ]);
    });
  });

  it("Extract… starts a background job for an archive and shows it in the tray", async () => {
    const slot = await mountPanel(baseRpc({ extractArchive: () => ({ job: RUNNING_JOB }) }));
    clickItem(await openRowMenu(slot, ARCHIVE.path), "Extract");

    const dialog = await slot.findByTestId("fm-extract-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Extract" }));

    await waitFor(() => {
      expect(callsTo(slot, "extractArchive")).toEqual([
        {
          method: "extractArchive",
          input: {
            archivePath: ARCHIVE.path,
            destinationDir: ROOT,
            createSubfolder: true,
            conflict: "rename",
          },
        },
      ]);
    });
    expect(await slot.findByTestId("fm-job-item")).toBeDefined();
    expect(slot.getByTestId("fm-activity-tray").textContent).toContain('Extracting "bundle.zip"');
  });

  it("hides Extract… when no extractor for that format exists on this host", async () => {
    const slot = await mountPanel(
      baseRpc({
        getState: () => ({
          root: ROOT,
          startFolder: ROOT,
          preferences: PREFERENCES,
          chunkSizeBytes: 8 * 1024 * 1024,
          maxListEntries: 5000,
          archiveSupport: { zip: false, tar: false, sevenZip: false, rar: false },
          pluginVersion: "0.1.0",
          primaryHostId: HOST_ID,
        }),
      }),
    );
    const menu = await openRowMenu(slot, ARCHIVE.path);
    const extract = within(menu)
      .getAllByRole("menuitem")
      .find((item) => (item.textContent ?? "").startsWith("Extract"))!;
    expect(extract.getAttribute("data-disabled")).not.toBeNull();
  });

  it("Copy path writes the absolute path of every selected row to the clipboard", async () => {
    const slot = await mountPanel();

    clickItem(await openRowMenu(slot, NOTES.path), "Copy path");
    await waitFor(() => {
      expect(clipboardWrites).toEqual([NOTES.path]);
    });
    expect(toasts.success).toContain("Path copied");

    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.click(rowFor(slot, OTHER.path), { ctrlKey: true });
    clickItem(await openRowMenu(slot, OTHER.path), "Copy path");
    await waitFor(() => {
      expect(clipboardWrites).toHaveLength(2);
    });
    expect(clipboardWrites[1]).toBe(`${NOTES.path}\n${OTHER.path}`);
    expect(toasts.success).toContain("2 paths copied");
  });

  it("keeps the whole selection when the menu opens on an already selected row", async () => {
    const slot = await mountPanel(
      baseRpc({ deleteEntries: () => ({ succeeded: [], failed: [] }) }),
    );
    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.click(rowFor(slot, OTHER.path), { ctrlKey: true });

    const menu = await openRowMenu(slot, OTHER.path);
    expect(menu.textContent).toContain("2 items");
    clickItem(menu, "Delete");

    const dialog = await slot.findByTestId("fm-delete-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(callsTo(slot, "deleteEntries")).toEqual([
        {
          method: "deleteEntries",
          input: { paths: [NOTES.path, OTHER.path], recursive: true },
        },
      ]);
    });
  });

  it("offers Open and Set as start folder for a directory row", async () => {
    const slot = await mountPanel(baseRpc({ savePreferences: () => ({
      startFolder: DOCS,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }) }));

    clickItem(await openRowMenu(slot, DOCS), "Open");
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
    ]);

    clickItem(await openRowMenu(slot, DOCS), "Set as start folder");
    await waitFor(() => {
      expect(callsTo(slot, "savePreferences")).toEqual([
        { method: "savePreferences", input: { startFolder: DOCS } },
      ]);
    });
  });

  it("offers Open for a file row too, and shows it (§8.12)", async () => {
    // Until 0.8 the row menu had an Open only for folders, which left the
    // panel's most ordinary action reachable by double-click and by nothing
    // else — invisible on the surface where double-click had nowhere to open
    // the file into.
    const slot = await mountPanel(
      baseRpc({
        readTextFile: (input) => ({
          path: input.path,
          text: "notes\n",
          sizeBytes: 6,
          readBytes: 6,
          truncated: false,
        }),
      }),
    );

    clickItem(await openRowMenu(slot, NOTES.path), "Open");

    const viewer = await slot.findByTestId("fm-viewer");
    expect(within(viewer).getByTestId("bb-source-code").getAttribute("data-path")).toBe("notes.txt");
  });

  it("offers no Open for several rows at once — there is no single destination", async () => {
    const slot = await mountPanel();

    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.click(rowFor(slot, OTHER.path), { ctrlKey: true });
    const many = await openRowMenu(slot, OTHER.path);
    expect(within(many).queryAllByRole("menuitem").map((item) => item.textContent)).not.toContain(
      "Open",
    );
  });
});

describe("background context menu (§8.2)", () => {
  it("New folder creates the folder in the current directory", async () => {
    const slot = await mountPanel(
      baseRpc({ createFolder: () => ({ entry: makeEntry({ name: "fresh", kind: "directory" }) }) }),
    );
    clickItem(await openBackgroundMenu(slot), "New folder");

    const dialog = await slot.findByTestId("fm-new-folder-dialog");
    fireEvent.change(within(dialog).getByLabelText("Folder name"), {
      target: { value: "fresh" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(callsTo(slot, "createFolder")).toEqual([
        { method: "createFolder", input: { path: ROOT, name: "fresh" } },
      ]);
    });
  });

  it("Select all, Refresh, Show hidden files and Copy folder path act on the directory", async () => {
    const slot = await mountPanel();

    clickItem(await openBackgroundMenu(slot), "Select all");
    await waitFor(() => {
      expect(
        slot.getAllByTestId("fm-row").filter((row) => row.getAttribute("data-selected") === "true"),
      ).toHaveLength(4);
    });

    const before = callsTo(slot, "listDir").length;
    clickItem(await openBackgroundMenu(slot), "Refresh");
    await waitFor(() => {
      expect(callsTo(slot, "listDir").length).toBe(before + 1);
    });

    clickItem(await openBackgroundMenu(slot), "Show hidden files");
    await waitFor(() => {
      expect(callsTo(slot, "savePreferences")).toEqual([
        { method: "savePreferences", input: { showHiddenFiles: true } },
      ]);
    });

    clickItem(await openBackgroundMenu(slot), "Copy folder path");
    await waitFor(() => {
      expect(clipboardWrites).toEqual([ROOT]);
    });
  });

  it("disables Paste until something has been cut or copied", async () => {
    const slot = await mountPanel();
    const menu = await openBackgroundMenu(slot);
    const paste = within(menu)
      .getAllByRole("menuitem")
      .find((item) => (item.textContent ?? "").startsWith("Paste"))!;
    expect(paste.getAttribute("data-disabled")).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("releasing the right button does not pick an item", () => {
  // Radix selects a MenuItem on `pointerup` even when the `pointerdown` came
  // from somewhere else, and near the right edge of the window the popper
  // flips the menu onto the cursor — which is where a side panel always is.
  // The result was a menu that flashed and ran something by itself.
  it("swallows a pointerup the row menu never saw a pointerdown for", async () => {
    const slot = await mountPanel();
    const menu = await openRowMenu(slot, ARCHIVE.path);
    const extract = itemIn(menu, "Extract");

    fireEvent.pointerUp(extract, { button: 2, pointerType: "mouse" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.queryByTestId("fm-extract-dialog")).toBeNull();
    expect(slot.queryByTestId("fm-row-menu")).not.toBeNull();
  });

  it("still runs an item that was pressed inside the menu", async () => {
    const slot = await mountPanel();
    const menu = await openRowMenu(slot, ARCHIVE.path);
    const extract = itemIn(menu, "Extract");

    fireEvent.pointerDown(extract, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(extract, { button: 0, pointerType: "mouse" });
    fireEvent.click(extract);

    expect(await slot.findByTestId("fm-extract-dialog")).toBeDefined();
  });

  it("swallows the same stray pointerup in the background menu", async () => {
    const slot = await mountPanel();
    const menu = await openBackgroundMenu(slot);
    const newFolder = itemIn(menu, "New folder");

    fireEvent.pointerUp(newFolder, { button: 2, pointerType: "mouse" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.queryByTestId("fm-new-folder-dialog")).toBeNull();
    expect(slot.queryByTestId("fm-background-menu")).not.toBeNull();
  });
});
