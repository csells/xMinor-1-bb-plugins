// @vitest-environment jsdom
//
// §8.2's mouse table and the selection half of §8.3, plus the one rule that
// makes bulk delete safe: N selected rows produce exactly one confirmation and
// exactly one `deleteEntries` call carrying all N paths.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

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
const ROOT = "/home/coder";

function makeEntry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: partial.sizeBytes ?? 1,
    modifiedAtMs: partial.modifiedAtMs ?? Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

const ENTRIES = ["a.txt", "b.txt", "c.txt", "d.txt"].map((name) => makeEntry({ name }));

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

function baseRpc(
  overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {},
  preferences = PREFERENCES,
): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.1.0",
      primaryHostId: HOST_ID,
    }),
    listDir: () => ({
      path: ROOT,
      parentPath: null,
      isRoot: true,
      entries: ENTRIES,
      truncated: false,
      totalEntries: ENTRIES.length,
      hiddenCount: 0,
      writable: true,
      volume: null,
    }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences,
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
  await slot.findByText("a.txt");
  return slot;
}

function rowFor(slot: RenderedSlot, name: string): HTMLElement {
  return slot
    .getAllByTestId("fm-row")
    .find((row) => row.getAttribute("data-fm-path") === `${ROOT}/${name}`)!;
}

function selectedNames(slot: RenderedSlot): string[] {
  return slot
    .getAllByTestId("fm-row")
    .filter((row) => row.getAttribute("data-selected") === "true")
    .map((row) => (row.getAttribute("data-fm-path") ?? "").slice(ROOT.length + 1));
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

describe("selection (§8.2)", () => {
  it("selects only the clicked row", async () => {
    const slot = await mountPanel();

    fireEvent.click(rowFor(slot, "b.txt"));
    expect(selectedNames(slot)).toEqual(["b.txt"]);

    fireEvent.click(rowFor(slot, "d.txt"));
    expect(selectedNames(slot)).toEqual(["d.txt"]);
    expect(rowFor(slot, "d.txt").getAttribute("aria-selected")).toBe("true");
  });

  it("toggles one row with Ctrl+click and with Cmd+click, keeping the rest", async () => {
    const slot = await mountPanel();

    fireEvent.click(rowFor(slot, "a.txt"));
    fireEvent.click(rowFor(slot, "c.txt"), { ctrlKey: true });
    expect(selectedNames(slot)).toEqual(["a.txt", "c.txt"]);

    fireEvent.click(rowFor(slot, "d.txt"), { metaKey: true });
    expect(selectedNames(slot)).toEqual(["a.txt", "c.txt", "d.txt"]);

    fireEvent.click(rowFor(slot, "c.txt"), { ctrlKey: true });
    expect(selectedNames(slot)).toEqual(["a.txt", "d.txt"]);
  });

  it("selects the inclusive range from the anchor with Shift+click, in both directions", async () => {
    const slot = await mountPanel();

    fireEvent.click(rowFor(slot, "b.txt"));
    fireEvent.click(rowFor(slot, "d.txt"), { shiftKey: true });
    expect(selectedNames(slot)).toEqual(["b.txt", "c.txt", "d.txt"]);

    // The anchor stayed on b.txt, so shift-clicking upward re-anchors there.
    fireEvent.click(rowFor(slot, "a.txt"), { shiftKey: true });
    expect(selectedNames(slot)).toEqual(["a.txt", "b.txt"]);
  });

  it("toggles from the checkbox cell without clearing the other rows", async () => {
    const slot = await mountPanel();

    fireEvent.click(rowFor(slot, "a.txt"));
    fireEvent.click(rowFor(slot, "c.txt").querySelectorAll("td")[0]!);
    expect(selectedNames(slot)).toEqual(["a.txt", "c.txt"]);

    fireEvent.click(rowFor(slot, "a.txt").querySelectorAll("td")[0]!);
    expect(selectedNames(slot)).toEqual(["c.txt"]);
  });

  it("clears the selection when the click lands on empty table space", async () => {
    const slot = await mountPanel();

    fireEvent.click(rowFor(slot, "a.txt"));
    expect(selectedNames(slot)).toHaveLength(1);

    fireEvent.click(slot.getByTestId("fm-scroll"));
    expect(selectedNames(slot)).toEqual([]);
  });

  it("selects and clears everything from the header checkbox", async () => {
    const slot = await mountPanel();
    const selectAll = slot.getByTestId("fm-select-all") as HTMLInputElement;

    fireEvent.click(selectAll);
    expect(selectedNames(slot)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
    await waitFor(() => {
      expect((slot.getByTestId("fm-select-all") as HTMLInputElement).checked).toBe(true);
    });

    fireEvent.click(slot.getByTestId("fm-select-all"));
    expect(selectedNames(slot)).toEqual([]);
  });

  it("marks the header checkbox indeterminate for a partial selection", async () => {
    const slot = await mountPanel();

    fireEvent.click(rowFor(slot, "a.txt"));
    await waitFor(() => {
      expect((slot.getByTestId("fm-select-all") as HTMLInputElement).indeterminate).toBe(true);
    });
  });

  it("selects every visible row with Ctrl+A and clears it with Escape", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");

    fireEvent.keyDown(panel, { key: "a", ctrlKey: true });
    expect(selectedNames(slot)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(selectedNames(slot)).toEqual([]);
  });

  it("restricts Ctrl+A to the rows the filter left visible", async () => {
    const slot = await mountPanel();

    fireEvent.change(slot.getByTestId("fm-search"), { target: { value: "b" } });
    await waitFor(() => {
      expect(slot.getAllByTestId("fm-row")).toHaveLength(1);
    });

    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "a", ctrlKey: true });
    expect(selectedNames(slot)).toEqual(["b.txt"]);
  });
});

describe("bulk delete", () => {
  it("confirms once for N items and issues a single deleteEntries call", async () => {
    const deletes: unknown[] = [];
    const slot = await mountPanel(
      baseRpc({
        deleteEntries: (input) => {
          deletes.push(input);
          return { succeeded: (input as { paths: string[] }).paths, failed: [] };
        },
      }),
    );

    fireEvent.click(rowFor(slot, "a.txt"));
    fireEvent.click(rowFor(slot, "c.txt"), { ctrlKey: true });
    fireEvent.click(rowFor(slot, "d.txt"), { ctrlKey: true });
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });

    const dialog = await slot.findByTestId("fm-delete-dialog");
    expect(slot.getAllByTestId("fm-delete-dialog")).toHaveLength(1);
    expect(dialog.textContent).toContain("Delete 3 items?");
    expect(deletes).toHaveLength(0);

    fireEvent.click(slot.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deletes).toEqual([
        { paths: [`${ROOT}/a.txt`, `${ROOT}/c.txt`, `${ROOT}/d.txt`], recursive: true },
      ]);
    });
    await waitFor(() => {
      expect(slot.queryByTestId("fm-delete-dialog")).toBeNull();
    });
  });

  it("cancelling the confirmation deletes nothing", async () => {
    const deletes: unknown[] = [];
    const slot = await mountPanel(
      baseRpc({
        deleteEntries: (input) => {
          deletes.push(input);
          return { succeeded: [], failed: [] };
        },
      }),
    );

    fireEvent.click(rowFor(slot, "a.txt"));
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });
    await slot.findByTestId("fm-delete-dialog");

    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(slot.queryByTestId("fm-delete-dialog")).toBeNull();
    });
    expect(deletes).toEqual([]);
  });

  it("skips the dialog entirely when confirmOnDelete is off", async () => {
    const deletes: unknown[] = [];
    const preferences = { ...PREFERENCES, confirmOnDelete: false };
    const slot = await mountPanel(
      baseRpc(
        {
          deleteEntries: (input) => {
            deletes.push(input);
            return { succeeded: (input as { paths: string[] }).paths, failed: [] };
          },
        },
        preferences,
      ),
    );

    fireEvent.click(rowFor(slot, "b.txt"));
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });

    await waitFor(() => {
      expect(deletes).toEqual([{ paths: [`${ROOT}/b.txt`], recursive: true }]);
    });
    expect(slot.queryByTestId("fm-delete-dialog")).toBeNull();
  });

  it("surfaces per-path failures from the batch result as a toast", async () => {
    const slot = await mountPanel(
      baseRpc({
        deleteEntries: () => ({
          succeeded: [],
          failed: [{ path: `${ROOT}/a.txt`, code: "not_empty" as const, message: "not empty" }],
        }),
      }),
    );

    fireEvent.click(rowFor(slot, "a.txt"));
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: "Delete" });
    await slot.findByTestId("fm-delete-dialog");
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(toasts.error).toHaveLength(1);
    });
    expect(toasts.error[0]).toMatch(/a\.txt/u);
  });
});
