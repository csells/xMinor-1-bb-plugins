// @vitest-environment jsdom
//
// §8.8 — "Add to chat", from both ends.
//
// What is actually being asserted in every case is the same thing: an
// @-mention pill bound to THIS plugin's `file` provider, carrying the absolute
// path as its item id. The pill is the contract — the backend re-reads that
// path at send time — so a test that only checked "a dialog closed" would
// prove nothing.
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ComposerView,
  PluginComposerApi,
  PluginComposerScope,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcTestHandlers, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract } from "../../contract";
import { MENTION_PROVIDER_ID } from "../../contract";

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
const { ComposerFilePicker } = await import("../../components/ComposerFilePicker");
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore } = await import("../../lib/last-folder");

const registration = app.navPanels[0]!;
const customization = app.composerCustomizations[0]!;
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

const NOTES = makeEntry({ name: "notes.txt" });
const OTHER = makeEntry({ name: "other.txt" });
const FOLDER = makeEntry({ name: "docs", kind: "directory", path: DOCS });
const INSIDE = makeEntry({ name: "inside.md", path: `${DOCS}/inside.md` });
const REPORT = makeEntry({ name: "report.csv" });

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
};

function listingFor(path: string) {
  const entries = path === ROOT ? [FOLDER, NOTES, OTHER, REPORT] : [INSIDE];
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
): PluginRpcTestHandlers<FileManagerContract> {
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
  } as PluginRpcTestHandlers<FileManagerContract>;
}

/* ---------------------------- panel helpers ---------------------------- */

async function mountPanel(): Promise<RenderedSlot> {
  const slot = renderSlot(
    { component: registration.component },
    { subPath: "" },
    { rpc: baseRpc() },
  );
  await slot.findByText("notes.txt");
  return slot;
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement {
  return slot.getAllByTestId("fm-row").find((row) => row.getAttribute("data-fm-path") === path)!;
}

async function openRowMenu(slot: RenderedSlot, path: string): Promise<HTMLElement> {
  fireEvent.contextMenu(rowFor(slot, path), { button: 2 });
  return slot.findByTestId("fm-row-menu");
}

function itemIn(menu: HTMLElement, label: string): HTMLElement {
  return within(menu)
    .getAllByRole("menuitem")
    .find((candidate) => (candidate.textContent ?? "").startsWith(label))!;
}

/* --------------------------- composer helpers -------------------------- */

const THREAD_SCOPE: PluginComposerScope = { kind: "thread", threadId: "thread_1" };
const OTHER_SCOPE: PluginComposerScope = { kind: "thread", threadId: "thread_2" };

/**
 * The host hands `run` a live composer and view. Only `view.scope` is read (the
 * row's whole job is to name the composer it fired in), so the rest is a stub
 * rather than a second mounted composer.
 */
function runPlusMenu(scope: PluginComposerScope): void {
  const view = {
    scope,
    layout: "expanded",
    draft: { text: "", isEmpty: true, attachmentCount: 0 },
    run: { isRunning: false, isSubmitting: false },
  } as ComposerView;
  act(() => {
    void customization.plusMenu?.[0]?.run({
      composer: {} as PluginComposerApi,
      view,
    });
  });
}

/** The bare banner, mounted the way the host mounts it: inside one composer. */
function mountPicker(scope: PluginComposerScope = THREAD_SCOPE): RenderedSlot {
  return renderSlot(
    { component: ComposerFilePicker },
    {},
    { rpc: baseRpc(), composer: { scope } },
  );
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

describe("composer customization registration (§8.8)", () => {
  it("registers one customization for every composer kind", () => {
    expect(app.composerCustomizations).toHaveLength(1);
    expect(customization.id).toBe("add-file");
    // No `scopes`: every composer that can talk to an agent can want a file.
    expect(customization.scopes).toBeUndefined();
  });

  it("contributes the + menu row and nothing in the action row", () => {
    expect(customization.plusMenu).toHaveLength(1);
    const item = customization.plusMenu?.[0];
    expect({ id: item?.id, label: item?.label, icon: item?.icon }).toEqual({
      id: "file-manager-pick",
      label: "From File Manager…",
      icon: "FolderOpen",
    });
    expect(item?.description).toBeTypeOf("string");
    // Actions are dropped by the host in the compact layout, which is exactly
    // where a plugin's own file browser is most useful — hence a banner.
    expect(customization.actions).toBeUndefined();
  });

  it("mounts its dialog from a chrome-less banner", () => {
    expect(customization.banners).toHaveLength(1);
    expect(customization.banners?.[0]?.chrome).toBe("bare");
    expect(customization.banners?.[0]?.component).toBeTypeOf("function");
  });
});

describe("row menu → Add to chat (§8.8)", () => {
  it("inserts one @-mention for the selected file", async () => {
    const slot = await mountPanel();
    const menu = await openRowMenu(slot, NOTES.path);

    fireEvent.click(itemIn(menu, "Add to chat"));

    expect(slot.inspection.composer.mentions).toEqual([
      { provider: MENTION_PROVIDER_ID, id: NOTES.path, label: NOTES.name },
    ]);
    expect(toasts.success).toEqual(["notes.txt added to the chat"]);
  });

  it("inserts one mention per file when several rows are selected", async () => {
    const slot = await mountPanel();
    fireEvent.click(rowFor(slot, NOTES.path));
    fireEvent.click(rowFor(slot, OTHER.path), { ctrlKey: true });

    const menu = await openRowMenu(slot, OTHER.path);
    fireEvent.click(itemIn(menu, "Add to chat"));

    expect(slot.inspection.composer.mentions.map((mention) => mention.id)).toEqual([
      NOTES.path,
      OTHER.path,
    ]);
    expect(toasts.success).toEqual(["2 files added to the chat"]);
  });

  it("offers the row but disables it for a folder", async () => {
    const slot = await mountPanel();
    const menu = await openRowMenu(slot, FOLDER.path);

    const item = itemIn(menu, "Add to chat");
    expect(item).toBeDefined();
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("+ menu → From File Manager… (§8.8)", () => {
  it("opens the browser in the composer the row fired in", async () => {
    const slot = mountPicker(THREAD_SCOPE);
    // Nothing at all until asked: the banner is a mount point, not a widget.
    expect(slot.container.textContent).toBe("");

    runPlusMenu(THREAD_SCOPE);

    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("notes.txt");
    expect(within(dialog).getByText("notes.txt")).toBeDefined();
  });

  it("ignores a request that belongs to another composer", async () => {
    const slot = mountPicker(THREAD_SCOPE);

    runPlusMenu(OTHER_SCOPE);

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toEqual([]);
    });
    expect(slot.queryByTestId("fm-file-picker")).toBeNull();
  });

  it("inserts the mention for the file the user confirms", async () => {
    const slot = mountPicker();
    runPlusMenu(THREAD_SCOPE);
    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("notes.txt");

    // Confirming is refused until a file is picked — a folder is a step, not
    // an answer.
    const confirm = within(dialog).getByRole("button", { name: "Add to chat" });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.click(within(dialog).getByText("notes.txt"));
    fireEvent.click(confirm);

    expect(slot.inspection.composer.mentions).toEqual([
      { provider: MENTION_PROVIDER_ID, id: NOTES.path, label: NOTES.name },
    ]);
    expect(toasts.success).toEqual(["notes.txt added to the chat"]);
    await waitFor(() => {
      expect(slot.queryByTestId("fm-file-picker")).toBeNull();
    });
  });

  it("browses into a folder before picking", async () => {
    const slot = mountPicker();
    runPlusMenu(THREAD_SCOPE);
    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("notes.txt");

    fireEvent.click(within(dialog).getByTestId("fm-picker-folder"));

    await within(dialog).findByText("inside.md");
    // A double-click is the shortcut every file browser has.
    fireEvent.doubleClick(within(dialog).getByText("inside.md"));

    expect(slot.inspection.composer.mentions).toEqual([
      { provider: MENTION_PROVIDER_ID, id: INSIDE.path, label: INSIDE.name },
    ]);
  });

  it("picks several files with the checkboxes, in the order they were ticked", async () => {
    const slot = mountPicker();
    runPlusMenu(THREAD_SCOPE);
    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("report.csv");

    const checks = within(dialog).getAllByTestId("fm-picker-check");
    fireEvent.click(checks[2]!); // report.csv
    fireEvent.click(checks[0]!); // notes.txt

    const confirm = within(dialog).getByTestId("fm-picker-confirm");
    expect(confirm.textContent).toContain("(2)");
    expect(within(dialog).getByTestId("fm-picker-summary").textContent).toContain(
      "2 files selected",
    );

    fireEvent.click(confirm);
    expect(slot.inspection.composer.mentions).toEqual([
      { provider: MENTION_PROVIDER_ID, id: REPORT.path, label: REPORT.name },
      { provider: MENTION_PROVIDER_ID, id: NOTES.path, label: NOTES.name },
    ]);
    expect(toasts.success).toEqual(["2 files added to the chat"]);
  });

  it("takes the whole run on a Shift click", async () => {
    const slot = mountPicker();
    runPlusMenu(THREAD_SCOPE);
    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("report.csv");

    const rows = within(dialog).getAllByTestId("fm-picker-file");
    fireEvent.click(within(rows[0]!).getByText("notes.txt"));
    fireEvent.click(within(rows[2]!).getByText("report.csv"), { shiftKey: true });

    // Extending never clears: the anchor row stays in, and the rows between
    // come with it.
    expect(rows.filter((row) => row.getAttribute("data-selected") === "true")).toHaveLength(3);
    fireEvent.click(within(dialog).getByTestId("fm-picker-confirm"));
    expect(slot.inspection.composer.mentions.map((mention) => mention.id)).toEqual([
      NOTES.path,
      OTHER.path,
      REPORT.path,
    ]);
  });

  it("selects and clears every file in the folder from one control", async () => {
    const slot = mountPicker();
    runPlusMenu(THREAD_SCOPE);
    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("report.csv");

    const selectAll = within(dialog).getByTestId("fm-picker-select-all");
    fireEvent.click(selectAll);
    expect(within(dialog).getByTestId("fm-picker-confirm").textContent).toContain("(3)");

    fireEvent.click(selectAll);
    expect(
      within(dialog).getByTestId("fm-picker-confirm").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps files picked in a folder the browser has left", async () => {
    const slot = mountPicker();
    runPlusMenu(THREAD_SCOPE);
    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("report.csv");

    fireEvent.click(within(dialog).getAllByTestId("fm-picker-check")[0]!);
    fireEvent.click(within(dialog).getByTestId("fm-picker-folder"));
    await within(dialog).findByText("inside.md");
    fireEvent.click(within(dialog).getAllByTestId("fm-picker-check")[0]!);

    fireEvent.click(within(dialog).getByTestId("fm-picker-confirm"));
    expect(slot.inspection.composer.mentions.map((mention) => mention.id)).toEqual([
      NOTES.path,
      INSIDE.path,
    ]);
  });

  it("sends the whole selection on a double click, this row included", async () => {
    const slot = mountPicker();
    runPlusMenu(THREAD_SCOPE);
    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("report.csv");

    fireEvent.click(within(dialog).getAllByTestId("fm-picker-check")[0]!);
    fireEvent.doubleClick(within(dialog).getByText("report.csv"));

    expect(slot.inspection.composer.mentions.map((mention) => mention.id)).toEqual([
      NOTES.path,
      REPORT.path,
    ]);
  });

  it("inserts nothing twice when the confirm button is clicked twice", async () => {
    const slot = mountPicker();
    runPlusMenu(THREAD_SCOPE);
    const dialog = await slot.findByTestId("fm-file-picker");
    await within(dialog).findByText("notes.txt");

    fireEvent.click(within(dialog).getByText("notes.txt"));
    const confirm = within(dialog).getByRole("button", { name: "Add to chat" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(slot.inspection.composer.mentions).toHaveLength(1);
  });
});
