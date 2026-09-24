// @vitest-environment jsdom
//
// §8.9 — the gallery: the switch and where it is remembered, the thumbnails and
// every way they can fail, and the promise that matters most — that selection,
// the context menu, double-click and drag & drop behave there exactly as they
// do in the list, because they are the same handlers.
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import { PREVIEW_TTL_MS, type FileEntry, type FileManagerContract } from "../../contract";

const HOST_ID = "host_test";
const BASE_URL = "https://bb.test/preview/tok3n";

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
const tabAction = app.threadPanelActions[0]!;
const ROOT = "/home/coder";
const PHOTOS = `${ROOT}/photos`;

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeEntry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: partial.sizeBytes ?? 2048,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: partial.name.startsWith("."),
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

const SHOT = makeEntry({ name: "shot.png" });
const AWKWARD = makeEntry({ name: "a b#c.png" });
const NOTES = makeEntry({ name: "notes.txt" });
const PHOTOS_DIR = makeEntry({ name: "photos", kind: "directory", path: PHOTOS });

function listing(path: string, entries: readonly FileEntry[]) {
  return {
    path,
    parentPath: path === ROOT ? null : path.slice(0, path.lastIndexOf("/")),
    isRoot: path === ROOT,
    entries: [...entries],
    truncated: false,
    totalEntries: entries.length,
    hiddenCount: 0,
    writable: true,
    volume: null,
  };
}

function preferences(viewMode: "list" | "gallery") {
  return {
    showHiddenFiles: false,
    confirmOnDelete: true,
    restoreLastFolder: true,
    openThreadWorkspace: false,
    sortField: "name" as const,
    sortDirection: "asc" as const,
    viewMode,
  };
}

type Handlers = Partial<PluginRpcTestHandlers<FileManagerContract>>;

function baseRpc(
  options: { viewMode?: "list" | "gallery" } = {},
  extra: Handlers = {},
): Handlers {
  const viewMode = options.viewMode ?? "gallery";
  const tree: Record<string, ReturnType<typeof listing>> = {
    [ROOT]: listing(ROOT, [PHOTOS_DIR, AWKWARD, NOTES, SHOT]),
    [PHOTOS]: listing(PHOTOS, [makeEntry({ name: "inner.png", path: `${PHOTOS}/inner.png` })]),
  };
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: preferences(viewMode),
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
    createPreviewUrl: (input) => ({
      baseUrl: BASE_URL,
      path: input.path,
      expiresAtMs: Date.now() + PREVIEW_TTL_MS,
    }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: preferences(viewMode),
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
    ...extra,
  };
}

function mount(handlers: Handlers, options: Record<string, unknown> = {}): RenderedSlot {
  return renderSlot(
    { component: registration.component },
    { subPath: "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract>, ...options },
  ) as RenderedSlot;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

function tiles(slot: RenderedSlot): HTMLElement[] {
  return slot.queryAllByTestId("fm-tile");
}

function tileFor(slot: RenderedSlot, path: string): HTMLElement {
  return tiles(slot).find((tile) => tile.getAttribute("data-fm-path") === path)!;
}

function tileNames(slot: RenderedSlot): string[] {
  return tiles(slot).map((tile) => {
    const path = tile.getAttribute("data-fm-path") ?? "";
    return path.slice(path.lastIndexOf("/") + 1);
  });
}

async function mountGallery(handlers: Handlers = baseRpc()): Promise<RenderedSlot> {
  const slot = mount(handlers);
  await slot.findByTestId("fm-gallery");
  await waitFor(() => {
    expect(tiles(slot).length).toBeGreaterThan(0);
  });
  return slot;
}

/**
 * The same body on the panel-tab surface. Used wherever a test has to *land*
 * in another folder: the nav panel keeps its folder in the route, and the slot
 * harness records the navigation instead of re-rendering at the new path.
 */
async function mountTabGallery(handlers: Handlers = baseRpc()): Promise<RenderedSlot> {
  const slot = renderSlot(
    { component: tabAction.component },
    { threadId: "thr_1", params: null },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  ) as RenderedSlot;
  await slot.findByTestId("fm-gallery");
  await waitFor(() => {
    expect(tiles(slot).length).toBeGreaterThan(0);
  });
  return slot;
}

function dataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    types: [] as unknown as DataTransfer["types"],
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    effectAllowed: "none",
    dropEffect: "none",
    setData: (format: string, value: string) => void store.set(format, value),
    getData: (format: string) => store.get(format) ?? "",
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

describe("switching views", () => {
  it("opens in the list by default and leaves the preview transport alone", async () => {
    const slot = mount(baseRpc({ viewMode: "list" }));
    await slot.findByText("notes.txt");

    expect(slot.getByTestId("fm-table")).toBeDefined();
    expect(slot.queryByTestId("fm-gallery")).toBeNull();
    // No tiles, so nothing to mint a URL for.
    expect(callsTo(slot, "createPreviewUrl")).toHaveLength(0);
  });

  it("opens straight in the gallery when that is the stored preference", async () => {
    const slot = await mountGallery();

    expect(slot.queryByTestId("fm-table")).toBeNull();
    expect(tileNames(slot)).toEqual(["photos", "a b#c.png", "notes.txt", "shot.png"]);
  });

  it("switches views from the toolbar and remembers the choice", async () => {
    const slot = mount(baseRpc({ viewMode: "list" }));
    await slot.findByText("notes.txt");

    fireEvent.click(slot.getByTestId("fm-view-toggle"));

    await slot.findByTestId("fm-gallery");
    expect(slot.queryByTestId("fm-table")).toBeNull();
    expect(callsTo(slot, "savePreferences").at(-1)?.input).toEqual({ viewMode: "gallery" });

    // …and back, which is the same button with the other label.
    expect(slot.getByTestId("fm-view-toggle").getAttribute("aria-label")).toBe(
      "Show the list view",
    );
    fireEvent.click(slot.getByTestId("fm-view-toggle"));
    await slot.findByTestId("fm-table");
    expect(callsTo(slot, "savePreferences").at(-1)?.input).toEqual({ viewMode: "list" });
  });

  it("puts the switch in the overflow menu of a panel tab, where space is short", async () => {
    const slot = renderSlot(
      { component: tabAction.component },
      { threadId: "thr_1", params: null },
      { rpc: baseRpc({ viewMode: "list" }) as PluginRpcTestHandlers<FileManagerContract> },
    ) as RenderedSlot;
    await slot.findByText("notes.txt");

    // The compact toolbar has no room for its own toggle.
    expect(slot.queryByTestId("fm-view-toggle")).toBeNull();

    // Radix opens a DropdownMenu on pointerdown, not on click.
    fireEvent.pointerDown(slot.getByTestId("fm-panel-overflow"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const menu = await slot.findByRole("menu");
    fireEvent.click(within(menu).getByTestId("fm-panel-view-gallery"));

    await slot.findByTestId("fm-gallery");
    expect(callsTo(slot, "savePreferences").at(-1)?.input).toEqual({ viewMode: "gallery" });
  });
});

describe("thumbnails", () => {
  it("asks for one base URL per folder and hangs every image off it", async () => {
    const slot = await mountGallery();

    expect(callsTo(slot, "createPreviewUrl")).toHaveLength(1);
    expect(callsTo(slot, "createPreviewUrl")[0]?.input).toEqual({ path: ROOT });

    const image = within(tileFor(slot, SHOT.path)).getByTestId("fm-tile-image");
    expect(image.getAttribute("src")).toBe(`${BASE_URL}/shot.png`);
    // A folder of hundreds of photos must not fetch them all on open.
    expect(image.getAttribute("loading")).toBe("lazy");
  });

  it("percent-encodes a name that would otherwise end the URL early", async () => {
    const slot = await mountGallery();
    const image = within(tileFor(slot, AWKWARD.path)).getByTestId("fm-tile-image");
    expect(image.getAttribute("src")).toBe(`${BASE_URL}/a%20b%23c.png`);
  });

  it("shows a type icon for everything that is not an image", async () => {
    const slot = await mountGallery();

    for (const path of [NOTES.path, PHOTOS_DIR.path]) {
      expect(within(tileFor(slot, path)).getByTestId("fm-tile-icon")).toBeDefined();
      expect(within(tileFor(slot, path)).queryByTestId("fm-tile-image")).toBeNull();
    }
  });

  it("falls back to the icon when the image itself will not load", async () => {
    const slot = await mountGallery();
    const tile = tileFor(slot, SHOT.path);

    fireEvent.error(within(tile).getByTestId("fm-tile-image"));

    await waitFor(() => {
      expect(within(tileFor(slot, SHOT.path)).getByTestId("fm-tile-icon")).toBeDefined();
    });
    expect(within(tileFor(slot, SHOT.path)).queryByTestId("fm-tile-image")).toBeNull();
  });

  it("degrades to icons — silently — on a server with no preview transport", async () => {
    const slot = await mountGallery(
      baseRpc({}, {
        createPreviewUrl: () => {
          throw new Error("unsupported: previews are not available on this server");
        },
      }),
    );

    await waitFor(() => {
      expect(callsTo(slot, "createPreviewUrl")).toHaveLength(1);
    });
    expect(within(tileFor(slot, SHOT.path)).getByTestId("fm-tile-icon")).toBeDefined();
    // Thumbnails are decoration: a toast per folder would punish an old server
    // for something the user never asked for.
    expect(toasts.error).toHaveLength(0);
    expect(toasts.message).toHaveLength(0);
  });

  it("re-asks for the new folder after navigating, and never reuses the old URL", async () => {
    const slot = await mountTabGallery();

    fireEvent.doubleClick(tileFor(slot, PHOTOS_DIR.path));

    await waitFor(() => {
      expect(tileNames(slot)).toEqual(["inner.png"]);
    });
    await waitFor(() => {
      expect(callsTo(slot, "createPreviewUrl").map((call) => call.input)).toEqual([
        { path: ROOT },
        { path: PHOTOS },
      ]);
    });
  });
});

describe("the gestures are the list's own", () => {
  it("selects on click and extends with Ctrl", async () => {
    const slot = await mountGallery();

    fireEvent.click(tileFor(slot, SHOT.path));
    await waitFor(() => {
      expect(tileFor(slot, SHOT.path).getAttribute("data-selected")).toBe("true");
    });

    fireEvent.click(tileFor(slot, NOTES.path), { ctrlKey: true });
    await waitFor(() => {
      expect(tileFor(slot, NOTES.path).getAttribute("data-selected")).toBe("true");
    });
    expect(tileFor(slot, SHOT.path).getAttribute("data-selected")).toBe("true");
  });

  it("opens the row context menu on a tile", async () => {
    const slot = await mountGallery();

    fireEvent.contextMenu(tileFor(slot, SHOT.path));

    const menu = await slot.findByRole("menu");
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.startsWith("Rename"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Download"))).toBe(true);
  });

  it("double-clicks a file into bb's preview panel", async () => {
    const slot = await mountGallery();

    fireEvent.doubleClick(tileFor(slot, SHOT.path));

    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "experimental_openFilePreview",
        options: { target: { kind: "host", hostId: HOST_ID, path: SHOT.path }, location: null },
      },
    ]);
  });

  it("double-clicks a folder into view", async () => {
    const slot = await mountTabGallery();

    fireEvent.doubleClick(tileFor(slot, PHOTOS_DIR.path));

    await waitFor(() => {
      expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(PHOTOS);
    });
    expect(tileNames(slot)).toEqual(["inner.png"]);
  });

  it("moves a file by dropping it on a folder tile", async () => {
    const moved: unknown[] = [];
    const slot = await mountGallery(
      baseRpc({}, {
        moveEntries: (input) => {
          moved.push(input);
          return { succeeded: [...input.paths], failed: [] };
        },
      }),
    );

    const transfer = dataTransfer();
    fireEvent.dragStart(tileFor(slot, SHOT.path), { dataTransfer: transfer });
    fireEvent.dragOver(tileFor(slot, PHOTOS_DIR.path), { dataTransfer: transfer });
    expect(tileFor(slot, PHOTOS_DIR.path).getAttribute("data-drop-target")).toBe("true");
    fireEvent.drop(slot.getByTestId("fm-panel"), { dataTransfer: transfer });

    await waitFor(() => {
      expect(moved).toEqual([
        { paths: [SHOT.path], destinationDir: PHOTOS, conflict: "fail" },
      ]);
    });
  });

  it("hides what the filter hides, and only the current folder is ever shown", async () => {
    const slot = await mountGallery();

    fireEvent.change(slot.getByTestId("fm-search"), { target: { value: "png" } });

    await waitFor(() => {
      expect(tileNames(slot)).toEqual(["a b#c.png", "shot.png"]);
    });
    // No tree in a grid: a folder tile carries no chevron to expand into.
    expect(slot.queryAllByTestId("fm-chevron")).toHaveLength(0);
  });

  it("walks up through the `..` tile", async () => {
    const slot = await mountTabGallery();
    // The root has no parent, so the tile only exists once we are below it.
    expect(slot.queryByTestId("fm-gallery-parent")).toBeNull();
    fireEvent.doubleClick(tileFor(slot, PHOTOS_DIR.path));
    await waitFor(() => {
      expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(PHOTOS);
    });

    fireEvent.click(slot.getByTestId("fm-gallery-parent"));

    await waitFor(() => {
      expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(ROOT);
    });
  });
});

describe("the keyboard in a gallery", () => {
  it("walks the tiles with left and right, where the tree keys have no meaning", async () => {
    const slot = await mountGallery();
    const panel = slot.getByTestId("fm-panel");

    fireEvent.click(tileFor(slot, PHOTOS_DIR.path));
    await waitFor(() => {
      expect(tileFor(slot, PHOTOS_DIR.path).getAttribute("data-selected")).toBe("true");
    });

    expect(fireEvent.keyDown(panel, { key: "ArrowRight" })).toBe(false);
    await waitFor(() => {
      expect(slot.getByTestId("fm-gallery").getAttribute("aria-activedescendant")).toBe(
        `fm-row:${AWKWARD.path}`,
      );
    });

    expect(fireEvent.keyDown(panel, { key: "ArrowLeft" })).toBe(false);
    await waitFor(() => {
      expect(slot.getByTestId("fm-gallery").getAttribute("aria-activedescendant")).toBe(
        `fm-row:${PHOTOS_DIR.path}`,
      );
    });
  });

  it("quick-looks the focused tile with Space, exactly as it does in the list", async () => {
    const slot = await mountGallery();

    fireEvent.click(tileFor(slot, SHOT.path));
    await waitFor(() => {
      expect(tileFor(slot, SHOT.path).getAttribute("data-selected")).toBe("true");
    });

    expect(fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: " " })).toBe(false);
    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "experimental_openFilePreview",
        options: { target: { kind: "host", hostId: HOST_ID, path: SHOT.path }, location: null },
      },
    ]);
  });
});
