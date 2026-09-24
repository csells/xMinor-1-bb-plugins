// @vitest-environment jsdom
//
// §8.4 — the internal (row → folder) drag protocol and the external-drop
// affordances. The private `application/x-bb-file-manager` flavour plus the
// `text/plain` fallback, drop-target resolution, and the two rejections that
// keep a drop from doing something destructive.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
const ROOT = "/home/coder";
const DOCS = `${ROOT}/docs`;
const DRAG_MIME = "application/x-bb-file-manager";

function makeEntry(partial: Partial<FileEntry> & { name: string; path?: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: 4,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    archiveFormat: null,
  };
}

const A = makeEntry({ name: "a.txt" });
const B = makeEntry({ name: "b.txt" });
const FOLDER = makeEntry({ name: "docs", kind: "directory", path: DOCS });
const ESCAPING = makeEntry({
  name: "elsewhere",
  kind: "symlink",
  targetKind: "directory",
  isSymlink: true,
  escapesRoot: true,
});
const INNER = makeEntry({ name: "inner.txt", path: `${DOCS}/inner.txt` });

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
  const entries = path === ROOT ? [FOLDER, A, B, ESCAPING] : [INNER];
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

function baseRpc(): Partial<PluginRpcTestHandlers<FileManagerContract>> {
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
    moveEntries: (input) => ({
      succeeded: (input as { paths: string[] }).paths,
      failed: [],
    }),
  };
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

function externalTransfer(): DataTransfer {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    types: ["Files"],
    files: [],
    items: [],
    getData: () => "",
    setData: () => undefined,
  } as unknown as DataTransfer;
}

async function mountPanel(subPath = ""): Promise<RenderedSlot> {
  const slot = renderSlot(
    { component: registration.component },
    { subPath },
    { rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract> },
  );
  await waitFor(() => {
    expect(slot.queryAllByTestId("fm-row").length).toBeGreaterThan(0);
  });
  return slot;
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement {
  return slot.getAllByTestId("fm-row").find((row) => row.getAttribute("data-fm-path") === path)!;
}

function crumbFor(slot: RenderedSlot, path: string): HTMLElement {
  return slot
    .getByTestId("fm-breadcrumbs")
    .querySelector(`[data-fm-crumb="${path}"]`) as HTMLElement;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
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

describe("internal drag & drop (§8.4)", () => {
  it("puts the selected paths on the drag in both flavours", async () => {
    const slot = await mountPanel();
    const transfer = internalTransfer();

    fireEvent.click(rowFor(slot, A.path));
    fireEvent.click(rowFor(slot, B.path), { ctrlKey: true });
    fireEvent.dragStart(rowFor(slot, A.path), { dataTransfer: transfer });

    expect(transfer.effectAllowed).toBe("move");
    expect(JSON.parse(transfer.getData(DRAG_MIME))).toEqual([A.path, B.path]);
    expect(transfer.getData("text/plain")).toBe(`${A.path}\n${B.path}`);
  });

  it("selects an unselected row before dragging it", async () => {
    const slot = await mountPanel();
    const transfer = internalTransfer();

    fireEvent.click(rowFor(slot, B.path));
    fireEvent.dragStart(rowFor(slot, A.path), { dataTransfer: transfer });

    expect(JSON.parse(transfer.getData(DRAG_MIME))).toEqual([A.path]);
    await waitFor(() => {
      expect(rowFor(slot, A.path).getAttribute("data-selected")).toBe("true");
    });
  });

  it("highlights the hovered folder and moves the payload into it on drop", async () => {
    const slot = await mountPanel();
    const transfer = internalTransfer();

    fireEvent.click(rowFor(slot, A.path));
    fireEvent.dragStart(rowFor(slot, A.path), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(slot, DOCS), { dataTransfer: transfer });

    await waitFor(() => {
      expect(rowFor(slot, DOCS).getAttribute("data-drop-target")).toBe("true");
    });
    expect(transfer.dropEffect).toBe("move");

    fireEvent.drop(rowFor(slot, DOCS), { dataTransfer: transfer });
    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toEqual([
        {
          method: "moveEntries",
          input: { paths: [A.path], destinationDir: DOCS, conflict: "fail" },
        },
      ]);
    });
  });

  it("reads the text/plain fallback when the private flavour is missing", async () => {
    const slot = await mountPanel();
    const transfer = internalTransfer();
    transfer.setData("text/plain", `${A.path}\n${B.path}`);

    fireEvent.dragOver(rowFor(slot, DOCS), { dataTransfer: transfer });
    fireEvent.drop(rowFor(slot, DOCS), { dataTransfer: transfer });

    await waitFor(() => {
      expect(callsTo(slot, "moveEntries")).toEqual([
        {
          method: "moveEntries",
          input: { paths: [A.path, B.path], destinationDir: DOCS, conflict: "fail" },
        },
      ]);
    });
  });

  it("moves to an ancestor when the drop lands on a breadcrumb", async () => {
    const slot = await mountPanel("docs");
    const transfer = internalTransfer();

    fireEvent.click(rowFor(slot, INNER.path));
    fireEvent.dragStart(rowFor(slot, INNER.path), { dataTransfer: transfer });
    fireEvent.dragOver(crumbFor(slot, ROOT), { dataTransfer: transfer });

    await waitFor(() => {
      expect(crumbFor(slot, ROOT).className).toContain("ring-primary/50");
    });

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

  it("refuses to drop a row onto itself", async () => {
    const slot = await mountPanel();
    const transfer = internalTransfer();

    fireEvent.click(rowFor(slot, FOLDER.path));
    fireEvent.dragStart(rowFor(slot, FOLDER.path), { dataTransfer: transfer });
    fireEvent.dragOver(rowFor(slot, FOLDER.path), { dataTransfer: transfer });
    expect(rowFor(slot, FOLDER.path).getAttribute("data-drop-target")).toBeNull();

    fireEvent.drop(rowFor(slot, FOLDER.path), { dataTransfer: transfer });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(slot, "moveEntries")).toHaveLength(0);
  });

  it("never treats a link that leaves the root as a drag source or a drop target", async () => {
    const slot = await mountPanel();
    const transfer = internalTransfer();

    const started = fireEvent.dragStart(rowFor(slot, ESCAPING.path), { dataTransfer: transfer });
    expect(started).toBe(false);
    expect(transfer.getData(DRAG_MIME)).toBe("");

    const payload = internalTransfer();
    payload.setData(DRAG_MIME, JSON.stringify([A.path]));
    fireEvent.dragOver(rowFor(slot, ESCAPING.path), { dataTransfer: payload });
    expect(rowFor(slot, ESCAPING.path).getAttribute("data-drop-target")).toBeNull();

    fireEvent.drop(rowFor(slot, ESCAPING.path), { dataTransfer: payload });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(slot, "moveEntries")).toHaveLength(0);
  });
});

describe("external drag & drop (§8.4)", () => {
  it("claims the drop, shows the overlay and asks for a copy cursor", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");
    const transfer = externalTransfer();

    fireEvent.dragEnter(panel, { dataTransfer: transfer });
    expect(await slot.findByTestId("fm-drop-overlay")).toBeDefined();

    const claimed = fireEvent.dragOver(panel, { dataTransfer: transfer });
    // preventDefault is mandatory: without it the browser navigates away.
    expect(claimed).toBe(false);
    expect(transfer.dropEffect).toBe("copy");
  });

  it("drops the overlay again when the pointer leaves", async () => {
    const slot = await mountPanel();
    const panel = slot.getByTestId("fm-panel");
    const transfer = externalTransfer();

    fireEvent.dragEnter(panel, { dataTransfer: transfer });
    await slot.findByTestId("fm-drop-overlay");

    fireEvent.dragLeave(panel, { dataTransfer: transfer });
    await waitFor(() => {
      expect(slot.queryByTestId("fm-drop-overlay")).toBeNull();
    });
  });
});
