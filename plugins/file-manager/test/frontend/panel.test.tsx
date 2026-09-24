// @vitest-environment jsdom
//
// FileManagerPanel against a stubbed `listDir` (§8.1, §8.2, §11.1). Covers the
// listing itself (size / modified columns), the empty and error branches, the
// hidden toggle, client-side sort and filter, the `fs` realtime refetch, the
// reconnect refetch and folder navigation through rows and breadcrumbs.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract } from "../../contract";

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
const ROOT = "/home/coder";
const MARCH_2024 = Date.UTC(2024, 2, 12, 10, 30);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeEntry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  const path = partial.path ?? `${ROOT}/${partial.name}`;
  return {
    name: partial.name,
    path,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: partial.sizeBytes ?? 0,
    modifiedAtMs: partial.modifiedAtMs ?? MARCH_2024,
    isHidden: partial.isHidden ?? partial.name.startsWith("."),
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

function listing(path: string, entries: readonly FileEntry[], overrides: Record<string, unknown> = {}) {
  return {
    path,
    parentPath: path === ROOT ? null : path.slice(0, path.lastIndexOf("/")),
    isRoot: path === ROOT,
    entries: [...entries],
    truncated: false,
    totalEntries: entries.length,
    hiddenCount: 0,
    writable: true,
    volume: { totalBytes: 1024 * 1024 * 1024, freeBytes: 512 * 1024 * 1024 },
    ...overrides,
  };
}

const STATE = {
  root: ROOT,
  startFolder: ROOT,
  preferences: {
    showHiddenFiles: false,
    confirmOnDelete: true,
    restoreLastFolder: true,
    openThreadWorkspace: false,
    sortField: "name" as const,
    sortDirection: "asc" as const,
    viewMode: "list" as const,
  },
  chunkSizeBytes: 8 * 1024 * 1024,
  maxListEntries: 5000,
  archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
  pluginVersion: "0.1.0",
  primaryHostId: HOST_ID,
};

const README = makeEntry({ name: "readme.md", sizeBytes: 1536 });
const BIG = makeEntry({ name: "big.bin", sizeBytes: 5 * 1024 * 1024 });
const DOCS = makeEntry({ name: "docs", kind: "directory" });

type Handlers = Partial<PluginRpcTestHandlers<FileManagerContract>>;

function rpcFor(entriesByPath: Record<string, ReturnType<typeof listing>>, extra: Handlers = {}): Handlers {
  return {
    getState: () => STATE,
    listDir: (input) => {
      const found = entriesByPath[input.path];
      if (found === undefined) throw new Error(`not_found: ${input.path}`);
      return found;
    },
    readTextFile: (input) => ({
      path: input.path,
      text: "# readme\n",
      sizeBytes: 9,
      readBytes: 9,
      truncated: false,
    }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: STATE.preferences,
      chunkSizeBytes: STATE.chunkSizeBytes,
    }),
    ...extra,
  };
}

function mount(handlers: Handlers, props: { subPath?: string } = {}, options: Record<string, unknown> = {}) {
  return renderSlot(
    { component: registration.component },
    { subPath: props.subPath ?? "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract>, ...options },
  ) as RenderedSlot;
}

function listDirCalls(slot: RenderedSlot) {
  return slot.inspection.rpcCalls.filter((call) => call.method === "listDir");
}

function rowNames(slot: RenderedSlot): string[] {
  return slot
    .getAllByTestId("fm-row")
    .map((row) => row.getAttribute("data-fm-path") ?? "")
    .map((path) => path.slice(path.lastIndexOf("/") + 1));
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  toasts.message.length = 0;
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

describe("FileManagerPanel listing", () => {
  it("bootstraps with getState and renders the rows listDir returned", async () => {
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [DOCS, README, BIG]) }));

    expect(await slot.findByText("readme.md")).toBeDefined();
    expect(rowNames(slot)).toEqual(["docs", "big.bin", "readme.md"]);

    const bootstrap = slot.inspection.rpcCalls[0];
    expect(bootstrap?.method).toBe("getState");
    expect(bootstrap?.input).toBeNull();
    expect(listDirCalls(slot)).toHaveLength(1);
    expect(listDirCalls(slot)[0]?.input).toEqual({ path: ROOT, showHidden: false });
  });

  it("shows the size and the modified time for a file, and an em dash for a folder", async () => {
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [DOCS, README]) }));
    await slot.findByText("readme.md");

    const fileRow = slot
      .getAllByTestId("fm-row")
      .find((row) => row.getAttribute("data-fm-path") === README.path)!;
    const cells = fileRow.querySelectorAll("td");
    expect(cells[2]?.textContent).toBe("1.5 KB");
    expect(cells[2]?.getAttribute("title")).toBe("1,536 bytes");
    expect(cells[3]?.textContent).toMatch(/2024/u);
    expect(cells[3]?.getAttribute("title")).toMatch(/2024/u);

    const dirRow = slot
      .getAllByTestId("fm-row")
      .find((row) => row.getAttribute("data-fm-path") === DOCS.path)!;
    expect(dirRow.querySelectorAll("td")[2]?.textContent).toBe("—");
  });

  it("renders the empty state instead of rows for an empty directory", async () => {
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, []) }));

    const empty = await slot.findByTestId("fm-empty-state");
    expect(empty.getAttribute("data-empty-kind")).toBe("empty");
    expect(slot.queryAllByTestId("fm-row")).toHaveLength(0);
  });

  it("names the backend's own root when a path leaves it, never a fixed one", async () => {
    // The root is the home directory of whoever runs bb (src/root.ts), so
    // every sentence about it has to come from `getState`; 0.3.0 shipped two
    // that said "/home/coder" to everybody.
    const slot = mount({
      ...rpcFor({}),
      listDir: () => {
        throw new Error("path_escape: /etc");
      },
    });

    const empty = await slot.findByTestId("fm-empty-state");
    expect(empty.getAttribute("data-empty-kind")).toBe("escapes-root");
    expect(empty.textContent).toContain(`This link points outside ${ROOT},`);
  });

  it("names the root in the row tooltip of a link that leaves it", async () => {
    const escaping = makeEntry({
      name: "outside",
      kind: "symlink",
      targetKind: "directory",
      isSymlink: true,
      escapesRoot: true,
    });
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [escaping]) }));

    await slot.findByText("outside");
    const row = slot
      .getAllByTestId("fm-row")
      .find((candidate) => candidate.getAttribute("data-fm-path") === escaping.path)!;
    expect(row.getAttribute("title")).toBe(`outside → outside ${ROOT}`);
  });

  it("renders an ErrorBanner with the domain code when listDir fails, and retries on demand", async () => {
    let fail = true;
    const slot = mount({
      getState: () => STATE,
      listDir: () => {
        if (fail) throw new Error("permission_denied: /home/coder/secret");
        return listing(ROOT, [README]);
      },
      savePreferences: () => ({
        startFolder: ROOT,
        preferences: STATE.preferences,
        chunkSizeBytes: STATE.chunkSizeBytes,
      }),
    });

    const banner = await slot.findByTestId("fm-error-banner");
    expect(banner.getAttribute("data-error-code")).toBe("permission_denied");
    expect(banner.textContent).toContain("Could not open this folder");

    fail = false;
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    expect(await slot.findByText("readme.md")).toBeDefined();
    expect(listDirCalls(slot).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the truncation banner when the backend capped the listing", async () => {
    const slot = mount(
      rpcFor({
        [ROOT]: listing(ROOT, [README], { truncated: true, totalEntries: 12000 }),
      }),
    );
    await slot.findByText("readme.md");
    expect(slot.container.textContent).toContain("Showing the first 5000 of 12000 items");
  });

  it("skips the start-folder redirect when the panel is already deep-linked", async () => {
    const slot = mount(
      {
        ...rpcFor({ [`${ROOT}/docs`]: listing(`${ROOT}/docs`, [README]) }),
        getState: () => ({ ...STATE, startFolder: `${ROOT}/pictures` }),
      },
      { subPath: "docs" },
    );
    await slot.findByText("readme.md");
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("redirects to the configured start folder on a cold open of the root", async () => {
    const slot = mount({
      ...rpcFor({ [ROOT]: listing(ROOT, [README]) }),
      getState: () => ({ ...STATE, startFolder: `${ROOT}/projects/site` }),
    });

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toEqual([
        {
          method: "toPluginPanel",
          path: "files",
          options: { subPath: "projects/site", replace: true },
        },
      ]);
    });
  });
});

describe("FileManagerPanel toolbar", () => {
  it("re-issues listDir with showHidden:true and persists the preference", async () => {
    const slot = mount(
      rpcFor({ [ROOT]: listing(ROOT, [README, makeEntry({ name: ".bashrc", sizeBytes: 10 })]) }),
    );
    await slot.findByText("readme.md");

    fireEvent.click(slot.getByTestId("fm-toggle-hidden"));

    await waitFor(() => {
      expect(listDirCalls(slot)).toHaveLength(2);
    });
    expect(listDirCalls(slot)[1]?.input).toEqual({ path: ROOT, showHidden: true });
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "savePreferences"),
      ).toEqual([{ method: "savePreferences", input: { showHiddenFiles: true } }]);
    });
  });

  it("sorts by size client-side, without another listDir", async () => {
    const small = makeEntry({ name: "a-small.txt", sizeBytes: 10 });
    const large = makeEntry({ name: "b-large.txt", sizeBytes: 9000 });
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [small, large, DOCS]) }));
    await slot.findByText("a-small.txt");
    expect(rowNames(slot)).toEqual(["docs", "a-small.txt", "b-large.txt"]);

    fireEvent.click(slot.getByTestId("fm-sort-size"));
    await waitFor(() => {
      expect(rowNames(slot)).toEqual(["docs", "a-small.txt", "b-large.txt"]);
    });

    fireEvent.click(slot.getByTestId("fm-sort-size"));
    await waitFor(() => {
      expect(rowNames(slot)).toEqual(["docs", "b-large.txt", "a-small.txt"]);
    });
    expect(listDirCalls(slot)).toHaveLength(1);
  });

  it("filters the visible rows client-side as the user types", async () => {
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [README, BIG, DOCS]) }));
    await slot.findByText("readme.md");

    fireEvent.change(slot.getByTestId("fm-search"), { target: { value: "BIG" } });
    await waitFor(() => {
      expect(rowNames(slot)).toEqual(["big.bin"]);
    });
    expect(listDirCalls(slot)).toHaveLength(1);

    fireEvent.change(slot.getByTestId("fm-search"), { target: { value: "zzz" } });
    const empty = await slot.findByTestId("fm-empty-state");
    expect(empty.getAttribute("data-empty-kind")).toBe("no-results");
  });
});

describe("FileManagerPanel realtime", () => {
  it("refetches exactly once when an fs signal names the current directory", async () => {
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [README]) }));
    await slot.findByText("readme.md");
    expect(listDirCalls(slot)).toHaveLength(1);

    await slot.behavior.emitRealtime("fs", { paths: [ROOT], reason: "create" });
    await waitFor(() => {
      expect(listDirCalls(slot)).toHaveLength(2);
    });

    await slot.behavior.emitRealtime("fs", { paths: [`${ROOT}/elsewhere`], reason: "create" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listDirCalls(slot)).toHaveLength(2);
  });

  it("refetches when the realtime connection comes back (§7.3: signals were lost)", async () => {
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [README]) }), {}, {
      realtimeConnectionState: "connecting",
    });
    await slot.findByText("readme.md");
    expect(listDirCalls(slot)).toHaveLength(1);

    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => {
      expect(listDirCalls(slot)).toHaveLength(2);
    });
  });

  it("ignores a malformed fs payload instead of throwing inside the slot", async () => {
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [README]) }));
    await slot.findByText("readme.md");

    await slot.behavior.emitRealtime("fs", { paths: "not-an-array" });
    await slot.behavior.emitRealtime("fs", null);
    expect(listDirCalls(slot)).toHaveLength(1);
    expect(slot.getByText("readme.md")).toBeDefined();
  });
});

describe("FileManagerPanel navigation (§8.2)", () => {
  it("navigates into a folder on double click", async () => {
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [DOCS, README]) }));
    await slot.findByText("docs");

    const row = slot
      .getAllByTestId("fm-row")
      .find((candidate) => candidate.getAttribute("data-fm-path") === DOCS.path)!;
    fireEvent.doubleClick(row);

    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
    ]);
  });

  it("walks back up through the breadcrumbs and the .. row", async () => {
    const deep = `${ROOT}/docs/notes`;
    const slot = mount(
      rpcFor({ [deep]: listing(deep, [README]) }),
      { subPath: "docs/notes" },
    );
    await slot.findByText("readme.md");

    const crumbs = slot.getByTestId("fm-breadcrumbs");
    // Array.from, not a spread: tsconfig's `lib` is ["ES2022", "DOM"] with no
    // DOM.Iterable, so a NodeList is not iterable at the type level (§3).
    expect(
      Array.from(crumbs.querySelectorAll("button")).map((button) => button.textContent),
    ).toEqual([
      "Home",
      "docs",
      "notes",
    ]);

    fireEvent.click(crumbs.querySelectorAll("button")[1]!);
    fireEvent.click(crumbs.querySelectorAll("button")[0]!);
    fireEvent.doubleClick(slot.getByTestId("fm-parent-row"));

    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
      { method: "toPluginPanel", path: "files", options: { subPath: "" } },
      { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
    ]);
  });

  it("renders the listing of the directory named by subPath", async () => {
    const deep = `${ROOT}/docs`;
    const slot = mount(
      rpcFor({ [deep]: listing(deep, [makeEntry({ name: "inside.txt", path: `${deep}/inside.txt` })]) }),
      { subPath: "docs" },
    );
    await slot.findByText("inside.txt");
    expect(listDirCalls(slot)[0]?.input).toEqual({ path: deep, showHidden: false });
    expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(deep);
  });

  it("decodes a percent-encoded subPath segment before listing it", async () => {
    const deep = `${ROOT}/my docs/a+b`;
    const slot = mount(
      rpcFor({ [deep]: listing(deep, [README]) }),
      { subPath: "my%20docs/a%2Bb" },
    );
    await slot.findByText("readme.md");
    expect(listDirCalls(slot)[0]?.input).toEqual({ path: deep, showHidden: false });
  });

  it("opens a file in bb's preview panel on double click (§8.2)", async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });

    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [README]) }), {}, {
      openFilePreview: () => true,
    });
    await slot.findByText("readme.md");

    fireEvent.doubleClick(
      slot.getAllByTestId("fm-row").find((row) => row.getAttribute("data-fm-path") === README.path)!,
    );

    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "experimental_openFilePreview",
        options: {
          target: { kind: "host", hostId: HOST_ID, path: README.path },
          location: null,
        },
      },
    ]);
    // The preview took it, so nothing is downloaded.
    expect(clicked).toHaveLength(0);
  });

  it("opens the built-in viewer when the host declines the preview (§8.12)", async () => {
    // The surface the sidebar's own File Manager page always is: bb wires no
    // preview panel into it, so the host answers false for every file.
    // Downloading was 0.7's answer and it was the wrong one — the user asked
    // to look at the file, not to keep a copy of it.
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });

    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [README]) }), {}, {
      openFilePreview: () => false,
    });
    await slot.findByText("readme.md");

    fireEvent.doubleClick(
      slot.getAllByTestId("fm-row").find((row) => row.getAttribute("data-fm-path") === README.path)!,
    );

    await slot.findByTestId("fm-viewer");
    expect(clicked).toHaveLength(0);
  });

  it("shows the viewer when the server could not name its host", async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });

    const slot = mount(
      {
        ...rpcFor({ [ROOT]: listing(ROOT, [README]) }),
        getState: () => ({ ...STATE, primaryHostId: null }),
      },
      {},
      { openFilePreview: () => true },
    );
    await slot.findByText("readme.md");

    fireEvent.doubleClick(
      slot.getAllByTestId("fm-row").find((row) => row.getAttribute("data-fm-path") === README.path)!,
    );

    // Without a host id there is no target to hand bb, so it is never asked.
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    await slot.findByTestId("fm-viewer");
    expect(clicked).toHaveLength(0);
  });

  it("refuses a link that leaves the root, without previewing or downloading", async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });

    const escaping = makeEntry({
      name: "outside",
      kind: "symlink",
      targetKind: "directory",
      isSymlink: true,
      escapesRoot: true,
    });
    const slot = mount(rpcFor({ [ROOT]: listing(ROOT, [README, escaping]) }), {}, {
      openFilePreview: () => true,
    });
    await slot.findByText("readme.md");

    fireEvent.doubleClick(
      slot
        .getAllByTestId("fm-row")
        .find((row) => row.getAttribute("data-fm-path") === escaping.path)!,
    );

    expect(clicked).toHaveLength(0);
    expect(toasts.error).toContain("Link points outside /home/coder");
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });
});
