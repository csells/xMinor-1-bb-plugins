// @vitest-environment jsdom
//
// §8.13 — looking inside an archive from the panel: quick look (`Space`)
// opens the built-in viewer on the archive's table of contents, where the
// no-preview fallback used to be. The tree, its
// summary line, its states, and the one rule that matters most: "Extract…"
// hands over to the panel's own ExtractDialog and job, never a second path.
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import type {
  ArchiveEntry,
  ArchiveListing,
  FileEntry,
  FileManagerContract,
  Job,
} from "../../contract";

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
const HOST_ID = "host_test";

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
    sizeBytes: partial.sizeBytes ?? 4096,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

const ZIP = makeEntry({ name: "bundle.zip", archiveFormat: "zip" });
const NOTES = makeEntry({ name: "notes.txt" });

function member(path: string, extra: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    path,
    kind: "file",
    sizeBytes: 100,
    modifiedAtMs: Date.UTC(2024, 2, 15, 12, 30),
    encrypted: false,
    linkTarget: null,
    ...extra,
  };
}

const MEMBERS: ArchiveEntry[] = [
  member("bundle/readme.md", { sizeBytes: 2048 }),
  member("bundle/docs/b.txt"),
  member("bundle/docs/a.txt", { encrypted: true }),
  member("bundle/Отчёт за 2024.txt"),
  member("bundle/link", { kind: "symlink", sizeBytes: 0, linkTarget: "docs/a.txt" }),
];

function listingOf(overrides: Partial<ArchiveListing> = {}): ArchiveListing {
  return {
    path: ZIP.path,
    format: "zip",
    archiveSizeBytes: 3 * 1024,
    entries: MEMBERS,
    totalEntries: MEMBERS.length,
    fileCount: 5,
    directoryCount: 2,
    uncompressedBytes: 2048 + 3 * 100,
    encryptedCount: 1,
    truncated: false,
    partial: false,
    stoppedBy: null,
    problem: null,
    extractable: true,
    ...overrides,
  };
}

const JOB: Job = {
  jobId: "job-1",
  kind: "extract",
  state: "running",
  label: 'Extracting "bundle.zip"',
  startedAtMs: 1,
  finishedAtMs: null,
  processedBytes: 0,
  totalBytes: 0,
  resultPath: null,
  errorCode: null,
  errorMessage: null,
};

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

type Handlers = Partial<PluginRpcTestHandlers<FileManagerContract>>;

function baseRpc(extra: Handlers = {}): Handlers {
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.9.0",
      primaryHostId: HOST_ID,
    }),
    listDir: (input) => ({
      path: input.path,
      parentPath: input.path === ROOT ? null : ROOT,
      isRoot: input.path === ROOT,
      entries: input.path === ROOT ? [ZIP, NOTES] : [],
      truncated: false,
      totalEntries: input.path === ROOT ? 2 : 0,
      hiddenCount: 0,
      writable: true,
      volume: null,
    }),
    listArchive: () => listingOf(),
    readTextFile: (input) => ({
      path: input.path,
      text: "text",
      sizeBytes: 4,
      readBytes: 4,
      truncated: false,
    }),
    extractArchive: () => ({ job: JOB }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
    ...extra,
  };
}

function mount(handlers: Handlers = baseRpc(), openFilePreview?: () => boolean): RenderedSlot {
  return renderSlot(
    { component: registration.component },
    { subPath: "" },
    {
      rpc: handlers as PluginRpcTestHandlers<FileManagerContract>,
      ...(openFilePreview === undefined ? {} : { openFilePreview }),
    },
  ) as RenderedSlot;
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement {
  const row = slot.getAllByTestId("fm-row").find((element) => element.getAttribute("data-fm-path") === path);
  if (row === undefined) throw new Error(`no row for ${path}`);
  return row;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

/** Quick look on a row: select it, then Space on the panel. */
async function quickLook(slot: RenderedSlot, entry: FileEntry): Promise<HTMLElement> {
  await slot.findByText(entry.name);
  fireEvent.click(rowFor(slot, entry.path));
  fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: " " });
  return slot.findByTestId("fm-viewer");
}

function treeRows(slot: RenderedSlot): string[] {
  return slot
    .queryAllByTestId("fm-archive-row")
    .map((row) => `${row.getAttribute("aria-level") ?? "?"}:${row.getAttribute("data-archive-path") ?? ""}`);
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  resetUploadManager();
  resetPanelSnapshot();
  resetLastFolderStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("an archive in the built-in viewer (§8.13)", () => {
  it("shows the table of contents instead of 'no preview', and never reads the bytes", async () => {
    const slot = mount();
    const viewer = await quickLook(slot, ZIP);

    await within(viewer).findByTestId("fm-archive-tree");
    expect(callsTo(slot, "listArchive").map((call) => call.input)).toEqual([{ path: ZIP.path }]);
    expect(callsTo(slot, "readTextFile")).toHaveLength(0);
    expect(callsTo(slot, "createPreviewUrl")).toHaveLength(0);
    expect(viewer.textContent).not.toContain("No preview");
  });

  it("draws a tree: folders first, by name, the lone top folder already open", async () => {
    const slot = mount();
    await quickLook(slot, ZIP);
    await slot.findByTestId("fm-archive-tree");

    expect(treeRows(slot)).toEqual([
      "1:bundle",
      "2:bundle/docs",
      "2:bundle/link",
      "2:bundle/readme.md",
      "2:bundle/Отчёт за 2024.txt",
    ]);
  });

  it("opens and closes a folder on click", async () => {
    const slot = mount();
    await quickLook(slot, ZIP);
    await slot.findByTestId("fm-archive-tree");
    const docs = slot
      .getAllByTestId("fm-archive-row")
      .find((row) => row.getAttribute("data-archive-path") === "bundle/docs")!;

    fireEvent.click(docs);
    expect(treeRows(slot)).toContain("3:bundle/docs/a.txt");
    expect(treeRows(slot).indexOf("3:bundle/docs/a.txt")).toBeLessThan(
      treeRows(slot).indexOf("3:bundle/docs/b.txt"),
    );
    expect(docs.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(docs);
    expect(treeRows(slot)).not.toContain("3:bundle/docs/a.txt");
  });

  it("walks the tree from the keyboard", async () => {
    const slot = mount();
    await quickLook(slot, ZIP);
    const tree = await slot.findByTestId("fm-archive-tree");

    fireEvent.focus(tree);
    fireEvent.keyDown(tree, { key: "ArrowDown" }); // bundle → docs
    fireEvent.keyDown(tree, { key: "ArrowRight" }); // open docs
    expect(treeRows(slot)).toContain("3:bundle/docs/a.txt");
    fireEvent.keyDown(tree, { key: "ArrowRight" }); // into docs: a.txt
    const active = tree.getAttribute("aria-activedescendant");
    expect(active).not.toBeNull();
    expect(document.getElementById(active ?? "")?.getAttribute("data-archive-path")).toBe(
      "bundle/docs/a.txt",
    );
    fireEvent.keyDown(tree, { key: "ArrowLeft" }); // back out to docs
    fireEvent.keyDown(tree, { key: "ArrowLeft" }); // close docs
    expect(treeRows(slot)).not.toContain("3:bundle/docs/a.txt");
  });

  it("sums the archive up and marks what is encrypted or a link", async () => {
    const slot = mount();
    await quickLook(slot, ZIP);
    await slot.findByTestId("fm-archive-tree");

    const summary = slot.getByTestId("fm-archive-summary").textContent ?? "";
    expect(summary).toContain("5 files");
    expect(summary).toContain("2 folders");
    expect(summary).toContain("2.3 KB uncompressed");
    expect(summary).toContain("3 KB archive");
    expect(slot.getByTestId("fm-archive-encrypted").textContent).toContain("1 encrypted");

    fireEvent.click(
      slot.getAllByTestId("fm-archive-row").find((row) => row.getAttribute("data-archive-path") === "bundle/docs")!,
    );
    const secret = slot
      .getAllByTestId("fm-archive-row")
      .find((row) => row.getAttribute("data-archive-path") === "bundle/docs/a.txt")!;
    expect(secret.querySelector('[data-icon="Lock"]')).not.toBeNull();
    expect(within(slot.getByTestId("fm-archive-tree")).getByTestId("fm-archive-link").textContent).toBe(
      "→ docs/a.txt",
    );
  });

  it("says how much of a huge archive it is showing", async () => {
    const slot = mount(baseRpc({ listArchive: () => listingOf({ truncated: true, totalEntries: 25_000 }) }));
    await quickLook(slot, ZIP);

    expect((await slot.findByTestId("fm-archive-note")).textContent).toBe(
      "Showing the first 5 of 25,000 entries.",
    );
  });

  it("warns when the archive is damaged, with the reader's own words", async () => {
    const slot = mount(
      baseRpc({
        listArchive: () =>
          listingOf({ partial: true, truncated: true, stoppedBy: "damaged", problem: "Unexpected end of archive" }),
      }),
    );
    await quickLook(slot, ZIP);

    const note = (await slot.findByTestId("fm-archive-note")).textContent ?? "";
    expect(note).toContain("damaged");
    expect(note).toContain("Unexpected end of archive");
  });

  it("warns when the scan ran out of time", async () => {
    const slot = mount(
      baseRpc({ listArchive: () => listingOf({ partial: true, truncated: true, stoppedBy: "time" }) }),
    );
    await quickLook(slot, ZIP);

    expect((await slot.findByTestId("fm-archive-note")).textContent).toContain("took too long");
  });

  it("says an empty archive is empty", async () => {
    const slot = mount(
      baseRpc({
        listArchive: () =>
          listingOf({ entries: [], totalEntries: 0, fileCount: 0, directoryCount: 0, encryptedCount: 0 }),
      }),
    );
    await quickLook(slot, ZIP);

    expect((await slot.findByTestId("fm-archive-empty")).textContent).toBe("This archive is empty.");
  });

  it("shows why it could not read the archive", async () => {
    const slot = mount(
      baseRpc({
        listArchive: () => {
          throw new Error(
            "archive_failed: bundle.zip: its list of files is encrypted — it cannot be shown without the password",
          );
        },
      }),
    );
    await quickLook(slot, ZIP);

    const error = await slot.findByTestId("fm-archive-error");
    expect(error.textContent).toContain("Could not read this archive");
    expect(error.textContent).toContain("its list of files is encrypted");
  });

  it("tells a missing tool apart from a broken file", async () => {
    const slot = mount(
      baseRpc({
        listArchive: () => {
          throw new Error("unsupported_archive: bundle.zip (7z is not installed on this host)");
        },
      }),
    );
    await quickLook(slot, ZIP);

    expect((await slot.findByTestId("fm-archive-error")).textContent).toContain(
      "Can't look inside this archive here",
    );
  });
});

/* ------------------------------------------------------------------ */

describe("Extract… from the viewer", () => {
  it("swaps the viewer for the panel's own Extract dialog and starts the ordinary job", async () => {
    const slot = mount();
    await quickLook(slot, ZIP);

    fireEvent.click(await slot.findByTestId("fm-archive-extract"));

    const dialog = await slot.findByTestId("fm-extract-dialog");
    expect(slot.queryByTestId("fm-viewer")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Extract" }));

    await waitFor(() => {
      expect(callsTo(slot, "extractArchive").map((call) => call.input)).toEqual([
        { archivePath: ZIP.path, destinationDir: ROOT, createSubfolder: true, conflict: "rename" },
      ]);
    });
    expect(await slot.findByTestId("fm-job-item")).toBeDefined();
  });

  it("offers no Extract… when this host cannot unpack the format", async () => {
    const slot = mount(baseRpc({ listArchive: () => listingOf({ extractable: false }) }));
    await quickLook(slot, ZIP);
    await slot.findByTestId("fm-archive-tree");

    expect(slot.queryByTestId("fm-archive-extract")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("where the contents are reached from", () => {
  it("a double click on an archive still opens the Extract dialog, as before", async () => {
    const slot = mount();
    await slot.findByText(ZIP.name);

    fireEvent.doubleClick(rowFor(slot, ZIP.path));

    expect(await slot.findByTestId("fm-extract-dialog")).toBeDefined();
    expect(callsTo(slot, "listArchive")).toHaveLength(0);
  });

  it("hands the archive to bb's preview panel where this surface has one", async () => {
    // bb then opens it with the first matching file opener — this plugin's
    // "Preview + location", which draws the same contents (§10.2).
    const slot = mount(baseRpc(), () => true);
    await slot.findByText(ZIP.name);

    fireEvent.click(rowFor(slot, ZIP.path));
    fireEvent.keyDown(slot.getByTestId("fm-panel"), { key: " " });

    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "experimental_openFilePreview",
        options: { target: { kind: "host", hostId: HOST_ID, path: ZIP.path }, location: null },
      },
    ]);
    expect(slot.queryByTestId("fm-viewer")).toBeNull();
  });
});
