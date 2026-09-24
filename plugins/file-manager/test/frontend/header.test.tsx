// @vitest-environment jsdom
//
// `headerContent` is mounted by the host in a *different* React subtree from
// the panel body (§10), so the two talk through components/panel-bus.ts. These
// tests mount both slots into the same document and check that the bridge
// carries state one way and commands the other.
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
const HeaderActions = registration.headerContent!;
const ROOT = "/home/coder";

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

function entryFor(name: string, kind: FileEntry["kind"] = "file"): FileEntry {
  return {
    name,
    path: `${ROOT}/${name}`,
    kind,
    targetKind: null,
    sizeBytes: 5,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
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

function baseRpc(
  writable = true,
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
    listDir: () => ({
      path: ROOT,
      parentPath: null,
      isRoot: true,
      entries: [entryFor("notes.txt")],
      truncated: false,
      totalEntries: 1,
      hiddenCount: 0,
      writable,
      volume: null,
    }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
    createFolder: () => ({ entry: entryFor("fresh", "directory") }),
    ...overrides,
  };
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

async function mountBoth(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): Promise<{ panel: RenderedSlot; header: RenderedSlot }> {
  const panel = renderSlot(
    { component: registration.component },
    { subPath: "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  );
  await panel.findByText("notes.txt");
  const header = renderSlot(
    { component: HeaderActions },
    { subPath: "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  );
  await waitFor(() => {
    expect((header.getByTestId("fm-header-new-folder") as HTMLButtonElement).disabled).toBe(false);
  });
  return { panel, header };
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

describe("HeaderActions (§10 headerContent)", () => {
  it("renders disabled actions until the panel has published a snapshot", () => {
    const header = renderSlot({ component: HeaderActions }, { subPath: "" }, { rpc: {} });

    expect((header.getByTestId("fm-header-upload") as HTMLButtonElement).disabled).toBe(true);
    expect((header.getByTestId("fm-header-new-folder") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables its actions once the panel reports a writable directory", async () => {
    const { header } = await mountBoth();
    expect((header.getByTestId("fm-header-upload") as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the write actions disabled for a read-only directory", async () => {
    const panel = renderSlot(
      { component: registration.component },
      { subPath: "" },
      { rpc: baseRpc(false) as PluginRpcTestHandlers<FileManagerContract> },
    );
    await panel.findByText("notes.txt");
    const header = renderSlot({ component: HeaderActions }, { subPath: "" }, { rpc: {} });

    await waitFor(() => {
      expect((header.getByTestId("fm-header-new-folder") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("opens the panel's new-folder dialog from the title bar", async () => {
    const { panel, header } = await mountBoth();

    fireEvent.click(header.getByTestId("fm-header-new-folder"));
    const dialog = await panel.findByTestId("fm-new-folder-dialog");

    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "fresh" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(callsTo(panel, "createFolder")).toEqual([
        { method: "createFolder", input: { path: ROOT, name: "fresh" } },
      ]);
    });
  });

  it("clicks the panel's hidden file input from the Upload button", async () => {
    const { panel, header } = await mountBoth();
    const input = panel.getByTestId("fm-file-input");
    const clicked = vi.fn();
    input.addEventListener("click", clicked);

    fireEvent.click(header.getByTestId("fm-header-upload"));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("drives Refresh, Select all, hidden files and Copy folder path from the overflow menu", async () => {
    const { panel, header } = await mountBoth();

    // Radix opens a DropdownMenu on pointerdown, not on click.
    async function openOverflow(): Promise<HTMLElement> {
      fireEvent.pointerDown(header.getByTestId("fm-header-overflow"), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      });
      return header.findByRole("menu");
    }

    function item(menu: HTMLElement, label: string): HTMLElement {
      return within(menu)
        .getAllByRole("menuitem")
        .find((candidate) => (candidate.textContent ?? "").startsWith(label))!;
    }

    const before = callsTo(panel, "listDir").length;
    fireEvent.click(item(await openOverflow(), "Refresh"));
    await waitFor(() => {
      expect(callsTo(panel, "listDir").length).toBe(before + 1);
    });

    fireEvent.click(item(await openOverflow(), "Select all"));
    await waitFor(() => {
      expect(panel.getAllByTestId("fm-row")[0]?.getAttribute("data-selected")).toBe("true");
    });

    fireEvent.click(item(await openOverflow(), "Show hidden files"));
    await waitFor(() => {
      expect(callsTo(panel, "savePreferences")).toEqual([
        { method: "savePreferences", input: { showHiddenFiles: true } },
      ]);
    });

    fireEvent.click(item(await openOverflow(), "Copy folder path"));
    await waitFor(() => {
      expect(clipboardWrites).toEqual([ROOT]);
    });
  });

  it("saves the current directory as the start folder", async () => {
    const { panel, header } = await mountBoth();

    fireEvent.pointerDown(header.getByTestId("fm-header-overflow"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const menu = await header.findByRole("menu");
    fireEvent.click(
      within(menu)
        .getAllByRole("menuitem")
        .find((candidate) => (candidate.textContent ?? "").startsWith("Set as start folder"))!,
    );

    await waitFor(() => {
      expect(callsTo(panel, "savePreferences")).toEqual([
        { method: "savePreferences", input: { startFolder: ROOT } },
      ]);
    });
    expect(toasts.success).toContain("Start folder saved");
  });

  it("goes back to the disabled state when the panel unmounts", async () => {
    const { panel, header } = await mountBoth();

    panel.lifecycle.unmount();
    await waitFor(() => {
      expect((header.getByTestId("fm-header-new-folder") as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ */
/* v0.4.0 — the toolbar grew a path bar (PATHBAR-SPEC §3.1, §9.4)       */
/* ------------------------------------------------------------------ */

describe("Toolbar shape with the path bar (§3.1)", () => {
  it("keeps every control it had, with Edit path between the crumbs and the filter", async () => {
    const { panel } = await mountBoth();

    const toolbar = panel.getByTestId("fm-toolbar");
    const order = Array.from(toolbar.querySelectorAll("[data-testid]"))
      .map((node) => node.getAttribute("data-testid"))
      .filter((id): id is string =>
        [
          "fm-path-bar",
          "fm-breadcrumbs",
          "fm-path-edit",
          "fm-search",
          "fm-sort-menu",
          "fm-toggle-hidden",
          "fm-collapse-all",
          "fm-refresh",
        ].includes(id ?? ""),
      );

    expect(order).toEqual([
      "fm-path-bar",
      "fm-breadcrumbs",
      "fm-path-edit",
      "fm-search",
      "fm-sort-menu",
      "fm-toggle-hidden",
      "fm-collapse-all",
      "fm-refresh",
    ]);
  });

  it("tracks the mode on the button and swaps the crumbs for the input", async () => {
    const { panel } = await mountBoth();
    const button = panel.getByTestId("fm-path-edit") as HTMLButtonElement;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Edit path");
    // The shortcut is written down once, on the wrapper the vendored Button
    // cannot carry a title on.
    expect(button.parentElement?.getAttribute("title")).toBe("Edit path (Ctrl+L)");

    fireEvent.click(button);
    expect(panel.getByTestId("fm-path-edit").getAttribute("aria-pressed")).toBe("true");
    expect(panel.queryByTestId("fm-breadcrumbs")).toBeNull();
    expect(panel.getByTestId("fm-path-group").getAttribute("aria-label")).toBe("Folder path");

    // The same button closes it again, without leaving focus on <body>.
    fireEvent.click(panel.getByTestId("fm-path-edit"));
    expect(panel.getByTestId("fm-path-edit").getAttribute("aria-pressed")).toBe("false");
    expect(panel.getByTestId("fm-breadcrumbs")).toBeDefined();
    expect(document.activeElement).toBe(panel.getByTestId("fm-table"));
  });
});
