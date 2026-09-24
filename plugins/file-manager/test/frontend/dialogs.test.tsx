// @vitest-environment jsdom
//
// The five dialogs of §8, as the panel mounts them. Three rules apply to all
// of them: focus has to land inside the dialog, Escape has to close it without
// side effects, and the primary action has to be reachable by submitting the
// form (what Enter does in a browser — jsdom implements no implicit form
// submission, so the tests dispatch the same `submit` event the key produces).
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract, Job } from "../../contract";

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
// Imported through the thunk-installed runtime like the app itself: it binds
// `@get-bb/plugin-sdk/app` at import time.
const { FolderPickerDialog } = await import("../../components/dialogs/FolderPickerDialog");
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
    targetKind: null,
    sizeBytes: partial.sizeBytes ?? 7,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

const NOTES = makeEntry({ name: "notes.txt" });
const FOLDER = makeEntry({ name: "docs", kind: "directory", path: DOCS });
const ARCHIVE = makeEntry({ name: "bundle.tar.gz", archiveFormat: "tar.gz" });

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

const JOB: Job = {
  jobId: "job-1",
  kind: "extract",
  state: "running",
  label: "Extracting",
  startedAtMs: 1,
  finishedAtMs: null,
  processedBytes: 0,
  totalBytes: 0,
  resultPath: null,
  errorCode: null,
  errorMessage: null,
};

function listingFor(path: string) {
  const entries = path === ROOT ? [FOLDER, ARCHIVE, NOTES] : [];
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
    createFolder: () => ({ entry: makeEntry({ name: "fresh", kind: "directory" }) }),
    renameEntry: () => ({ entry: makeEntry({ name: "renamed.txt" }) }),
    deleteEntries: () => ({ succeeded: [NOTES.path], failed: [] }),
    moveEntries: () => ({ succeeded: [NOTES.path], failed: [] }),
    extractArchive: () => ({ job: JOB }),
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

/** A browser submits the form when Enter is pressed in a text input; jsdom does not. */
function pressEnter(dialog: HTMLElement): void {
  const form = dialog.querySelector("form");
  if (form === null) throw new Error("the dialog has no form to submit");
  fireEvent.submit(form);
}

function escape(): void {
  fireEvent.keyDown(document, { key: "Escape" });
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

describe("NewFolderDialog", () => {
  async function openNewFolder(slot: RenderedSlot): Promise<HTMLElement> {
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "N", ctrlKey: true, shiftKey: true });
    return slot.findByTestId("fm-new-folder-dialog");
  }

  it("lands focus on the name field and names the destination", async () => {
    const slot = await mountPanel();
    const dialog = await openNewFolder(slot);

    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Folder name"));
    expect(dialog.textContent).toContain(ROOT);
  });

  it("creates the folder when the form is submitted", async () => {
    const slot = await mountPanel();
    const dialog = await openNewFolder(slot);

    fireEvent.change(within(dialog).getByLabelText("Folder name"), {
      target: { value: "  fresh  " },
    });
    pressEnter(dialog);

    await waitFor(() => {
      expect(callsTo(slot, "createFolder")).toEqual([
        { method: "createFolder", input: { path: ROOT, name: "fresh" } },
      ]);
    });
    await waitFor(() => {
      expect(slot.queryByTestId("fm-new-folder-dialog")).toBeNull();
    });
  });

  it("closes on Escape without touching the backend", async () => {
    const slot = await mountPanel();
    await openNewFolder(slot);

    escape();
    await waitFor(() => {
      expect(slot.queryByTestId("fm-new-folder-dialog")).toBeNull();
    });
    expect(callsTo(slot, "createFolder")).toHaveLength(0);
  });

  it("blocks a name that already exists or that the backend would reject", async () => {
    const slot = await mountPanel();
    const dialog = await openNewFolder(slot);
    const input = within(dialog).getByLabelText("Folder name");

    fireEvent.change(input, { target: { value: "docs" } });
    pressEnter(dialog);
    expect(await within(dialog).findByRole("alert")).toBeDefined();
    expect(callsTo(slot, "createFolder")).toHaveLength(0);

    fireEvent.change(input, { target: { value: "a/b" } });
    pressEnter(dialog);
    await waitFor(() => {
      expect(within(dialog).getByRole("alert").textContent).toContain("slash");
    });
    expect(callsTo(slot, "createFolder")).toHaveLength(0);
    expect(slot.queryByTestId("fm-new-folder-dialog")).not.toBeNull();
  });

  it("keeps the dialog open and shows the backend's message when the call fails", async () => {
    const slot = await mountPanel(
      baseRpc({
        createFolder: () => {
          throw new Error("permission_denied: /home/coder is read-only");
        },
      }),
    );
    const dialog = await openNewFolder(slot);

    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "fresh" } });
    pressEnter(dialog);

    // lib/errors.ts strips the `"<code>: "` prefix, so the inline message is
    // the human half of what the handler threw.
    await waitFor(() => {
      expect(within(dialog).getByRole("alert").textContent).toBe("/home/coder is read-only");
    });
    expect(slot.queryByTestId("fm-new-folder-dialog")).not.toBeNull();
  });
});

describe("RenameDialog", () => {
  async function openRename(slot: RenderedSlot): Promise<HTMLElement> {
    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "F2" });
    return slot.findByTestId("fm-rename-dialog");
  }

  it("focuses the field and pre-selects the stem, leaving the extension alone", async () => {
    const slot = await mountPanel();
    const dialog = await openRename(slot);
    const input = within(dialog).getByLabelText("New name") as HTMLInputElement;

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    expect(input.value).toBe("notes.txt");
    await waitFor(() => {
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, "notes".length]);
    });
  });

  it("renames when the form is submitted", async () => {
    const slot = await mountPanel();
    const dialog = await openRename(slot);

    fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: "renamed.txt" } });
    pressEnter(dialog);

    await waitFor(() => {
      expect(callsTo(slot, "renameEntry")).toEqual([
        { method: "renameEntry", input: { path: NOTES.path, newName: "renamed.txt" } },
      ]);
    });
  });

  it("treats an unchanged name as a cancel", async () => {
    const slot = await mountPanel();
    const dialog = await openRename(slot);

    pressEnter(dialog);
    await waitFor(() => {
      expect(slot.queryByTestId("fm-rename-dialog")).toBeNull();
    });
    expect(callsTo(slot, "renameEntry")).toHaveLength(0);
  });

  it("closes on Escape without renaming", async () => {
    const slot = await mountPanel();
    const dialog = await openRename(slot);
    fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: "other.txt" } });

    escape();
    await waitFor(() => {
      expect(slot.queryByTestId("fm-rename-dialog")).toBeNull();
    });
    expect(callsTo(slot, "renameEntry")).toHaveLength(0);
  });
});

describe("ConfirmDeleteDialog", () => {
  async function openDelete(slot: RenderedSlot): Promise<HTMLElement> {
    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });
    return slot.findByTestId("fm-delete-dialog");
  }

  it("puts focus inside the dialog and names the entry", async () => {
    const slot = await mountPanel();
    const dialog = await openDelete(slot);

    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    expect(dialog.textContent).toContain("Delete “notes.txt”?");
    expect(dialog.textContent).toContain("This cannot be undone");
  });

  it("closes on Escape and deletes nothing", async () => {
    const slot = await mountPanel();
    await openDelete(slot);

    escape();
    await waitFor(() => {
      expect(slot.queryByTestId("fm-delete-dialog")).toBeNull();
    });
    expect(callsTo(slot, "deleteEntries")).toHaveLength(0);
  });

  it("warns that folders are deleted recursively", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, DOCS));
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });

    const dialog = await slot.findByTestId("fm-delete-dialog");
    expect(dialog.textContent).toContain("will be deleted with all");
  });
});

describe("ExtractDialog", () => {
  async function openExtract(slot: RenderedSlot): Promise<HTMLElement> {
    fireEvent.doubleClick(rowFor(slot, ARCHIVE.path));
    return slot.findByTestId("fm-extract-dialog");
  }

  it("opens on a double click on an archive, focuses inside and defaults to a sub-folder", async () => {
    const slot = await mountPanel();
    const dialog = await openExtract(slot);

    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    expect(dialog.textContent).toContain("bundle.tar.gz");
    // splitFileName keeps the two-part suffix together.
    expect(dialog.textContent).toContain("bundle/");
  });

  it("closes on Escape without starting a job", async () => {
    const slot = await mountPanel();
    await openExtract(slot);

    escape();
    await waitFor(() => {
      expect(slot.queryByTestId("fm-extract-dialog")).toBeNull();
    });
    expect(callsTo(slot, "extractArchive")).toHaveLength(0);
  });

  it("refuses to extract a format this host has no extractor for", async () => {
    const slot = await mountPanel(
      baseRpc({
        getState: () => ({
          root: ROOT,
          startFolder: ROOT,
          preferences: PREFERENCES,
          chunkSizeBytes: 8 * 1024 * 1024,
          maxListEntries: 5000,
          archiveSupport: { zip: true, tar: false, sevenZip: false, rar: false },
          pluginVersion: "0.1.0",
          primaryHostId: HOST_ID,
        }),
      }),
    );
    const dialog = await openExtract(slot);

    expect(dialog.textContent).toContain("No extractor for tar.gz is installed");
    expect(within(dialog).getByRole("button", { name: "Extract" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("FolderPickerDialog", () => {
  it("browses with listDir and closes on Escape without moving anything", async () => {
    const slot = await mountPanel();
    fireEvent.contextMenu(rowFor(slot, NOTES.path), { button: 2 });
    const menu = await slot.findByTestId("fm-row-menu");
    fireEvent.click(
      within(menu)
        .getAllByRole("menuitem")
        .find((item) => (item.textContent ?? "").startsWith("Move to"))!,
    );

    const picker = await slot.findByTestId("fm-folder-picker");
    await waitFor(() => {
      expect(picker.contains(document.activeElement)).toBe(true);
    });
    expect(await within(picker).findByTestId("fm-picker-folder")).toBeDefined();

    escape();
    await waitFor(() => {
      expect(slot.queryByTestId("fm-folder-picker")).toBeNull();
    });
    expect(callsTo(slot, "moveEntries")).toHaveLength(0);
  });

  it("chooses once per opening, however fast the confirm button is clicked", async () => {
    // Closing plays an exit animation, so the real browser keeps the button in
    // the DOM after the first click; a second one would move (or save) twice.
    // Mounted with `open` pinned true — that is what the closing dialog still
    // looks like to the click handler.
    const chosen: string[] = [];
    const slot = renderSlot<Record<string, never>, FileManagerContract>(
      {
        component: () => (
          <FolderPickerDialog
            open
            title="Start folder"
            root={ROOT}
            confirmLabel="Use this folder"
            onOpenChange={() => undefined}
            onChoose={(path) => void chosen.push(path)}
          />
        ),
      },
      {},
      { rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract> },
    );

    const picker = await slot.findByTestId("fm-folder-picker");
    const confirm = within(picker).getByText("Use this folder");
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(chosen).toEqual([ROOT]);
  });
});
