// @vitest-environment jsdom
//
// §10.3 — the panel tab's one-click jump into the thread's own checkout.
//
// The rules this holds: only a surface bb named a thread for offers it; a
// usable answer becomes a toolbar button that navigates through the ordinary
// folder navigation; a "no" answer becomes a disabled overflow row that says
// which "no" it is, and never a button; and a lookup that failed stays
// clickable, because "bb did not answer" is not "there is nowhere to go".
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract } from "../../contract";

const toasts = vi.hoisted(() => ({
  error: [] as string[],
  message: [] as string[],
}));

vi.mock("sonner", () => ({
  toast: {
    error: (text: string) => void toasts.error.push(text),
    success: () => undefined,
    message: (text: string) => void toasts.message.push(text),
    warning: () => undefined,
    info: () => undefined,
  },
}));

const app = await loadPluginApp(() => import("../../app"));
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore, writeLastFolder } = await import("../../lib/last-folder");

const threadAction = app.threadPanelActions[0]!;
const newThreadAction = app.newThreadPanelActions[0]!;
const ROOT = "/home/coder";
const WORKTREE = `${ROOT}/work/bb-plugins`;

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

function entryFor(name: string, kind: FileEntry["kind"] = "file", parent = ROOT): FileEntry {
  return {
    name,
    path: `${parent}/${name}`,
    kind,
    targetKind: null,
    sizeBytes: 12,
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

function baseRpc(
  overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {},
): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  const tree: Record<string, ReturnType<typeof listing>> = {
    [ROOT]: listing(ROOT, [entryFor("notes.txt")]),
    [WORKTREE]: listing(WORKTREE, [entryFor("README.md", "file", WORKTREE)]),
  };
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.6.3",
      primaryHostId: "host_test",
    }),
    listDir: (input) => {
      const found = tree[input.path];
      if (found === undefined) throw new Error(`not_found: ${input.path}`);
      return found;
    },
    threadWorkspace: () => ({ path: WORKTREE, insideRoot: true, reason: null }),
    ...overrides,
  };
}

function mountTab(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): RenderedSlot {
  return renderSlot(
    { component: threadAction.component },
    { threadId: "thr_1", params: null },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  ) as RenderedSlot;
}

function currentPath(slot: RenderedSlot): string | null {
  return slot.getByTestId("fm-panel").getAttribute("data-current-path");
}

async function openOverflow(slot: RenderedSlot): Promise<HTMLElement> {
  // Radix opens a DropdownMenu on pointerdown, not on click.
  fireEvent.pointerDown(slot.getByTestId("fm-panel-overflow"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  return slot.findByRole("menu");
}

beforeEach(() => {
  toasts.error.length = 0;
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

describe("thread folder (§10.3)", () => {
  it("asks for the thread it was opened beside, exactly once", async () => {
    const slot = mountTab();
    await slot.findByTestId("fm-panel-thread-folder");

    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "threadWorkspace"),
    ).toEqual([{ method: "threadWorkspace", input: { threadId: "thr_1" } }]);
  });

  it("walks into the thread's checkout through the ordinary navigation", async () => {
    const slot = mountTab();
    await slot.findByText("notes.txt");

    fireEvent.click(await slot.findByTestId("fm-panel-thread-folder"));

    await waitFor(() => {
      expect(currentPath(slot)).toBe(WORKTREE);
    });
    expect(await slot.findByText("README.md")).toBeDefined();
    // The panel tab owns no route: the jump must not move the whole app.
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("is absent on the New thread launcher, which has no thread yet", async () => {
    const slot = renderSlot(
      { component: newThreadAction.component },
      { projectId: null, params: null },
      { rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract> },
    ) as RenderedSlot;
    await slot.findByText("notes.txt");

    expect(slot.queryByTestId("fm-panel-thread-folder")).toBeNull();
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "threadWorkspace"),
    ).toEqual([]);
  });

  it("is absent from the nav panel, which is not tied to a thread", async () => {
    const navPanel = app.navPanels[0]!;
    const slot = renderSlot(
      { component: navPanel.component },
      { subPath: "" },
      { rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract> },
    ) as RenderedSlot;
    await slot.findByText("notes.txt");

    expect(slot.queryByTestId("fm-panel-thread-folder")).toBeNull();
  });

  it.each([
    ["no_environment", "Thread folder: this thread has no workspace"],
    ["no_checkout", "Thread folder: the workspace has no folder yet"],
    ["outside_root", "Thread folder: outside your home folder"],
  ] as const)(
    "explains %s in the overflow instead of showing a dead button",
    async (reason, text) => {
      const slot = mountTab(
        baseRpc({
          threadWorkspace: () => ({
            path: reason === "outside_root" ? "/srv/repo" : null,
            insideRoot: false,
            reason,
          }),
        }),
      );
      await slot.findByText("notes.txt");

      await waitFor(() => {
        expect(slot.queryByTestId("fm-panel-thread-folder")).toBeNull();
      });
      const row = within(await openOverflow(slot)).getByTestId(
        "fm-panel-thread-folder-blocked",
      );
      expect(row.textContent).toContain(text);
      expect(row.getAttribute("aria-disabled")).toBe("true");
    },
  );

  it("keeps the button live when the lookup failed, and retries on click", async () => {
    // "bb did not answer" is not "there is nowhere to go", so a transient
    // failure must not remove the control until a retry says otherwise.
    let attempt = 0;
    const slot = mountTab(
      baseRpc({
        threadWorkspace: () => {
          attempt += 1;
          if (attempt === 1) throw new Error("io_error: bb is restarting");
          return { path: WORKTREE, insideRoot: true, reason: null };
        },
      }),
    );
    await slot.findByText("notes.txt");

    fireEvent.click(await slot.findByTestId("fm-panel-thread-folder"));

    await waitFor(() => {
      expect(currentPath(slot)).toBe(WORKTREE);
    });
    expect(attempt).toBe(2);
    expect(toasts.error).toEqual([]);
  });

  it("toasts rather than failing silently when the retry fails too", async () => {
    const slot = mountTab(
      baseRpc({
        threadWorkspace: () => {
          throw new Error("io_error: bb is restarting");
        },
      }),
    );
    await slot.findByText("notes.txt");

    fireEvent.click(await slot.findByTestId("fm-panel-thread-folder"));

    await waitFor(() => {
      expect(toasts.error).toHaveLength(1);
    });
    expect(toasts.error[0]).toContain("bb is restarting");
    expect(currentPath(slot)).toBe(ROOT);
  });

  it("toasts the reason when a retry turns the failure into a plain no", async () => {
    let attempt = 0;
    const slot = mountTab(
      baseRpc({
        threadWorkspace: () => {
          attempt += 1;
          if (attempt === 1) throw new Error("io_error: bb is restarting");
          return { path: null, insideRoot: false, reason: "no_environment" };
        },
      }),
    );
    await slot.findByText("notes.txt");

    fireEvent.click(await slot.findByTestId("fm-panel-thread-folder"));

    await waitFor(() => {
      expect(toasts.message).toEqual(["Thread folder: this thread has no workspace"]);
    });
    // …and from then on the control is the disabled overflow row.
    await waitFor(() => {
      expect(slot.queryByTestId("fm-panel-thread-folder")).toBeNull();
    });
  });
});

/* ------------------------------------------------------------------ */

describe("opening in the thread's folder (§1.5)", () => {
  const DOCS = `${ROOT}/documents`;

  /** `baseRpc`, with the preference on. */
  function withPreferenceOn(
    overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {},
  ): Partial<PluginRpcTestHandlers<FileManagerContract>> {
    const base = baseRpc(overrides);
    return {
      ...base,
      getState: () => ({
        ...(base.getState as () => ReturnType<NonNullable<typeof base.getState>>)(),
        preferences: { ...PREFERENCES, openThreadWorkspace: true },
      }),
      ...overrides,
    };
  }

  it("starts a thread's tab in that thread's checkout, with no click", async () => {
    const slot = mountTab(withPreferenceOn());

    await waitFor(() => {
      expect(currentPath(slot)).toBe(WORKTREE);
    });
    expect(await slot.findByText("README.md")).toBeDefined();
  });

  it("outranks the remembered folder, which is one value for every thread", async () => {
    writeLastFolder({ path: DOCS, root: ROOT });
    const slot = mountTab(withPreferenceOn());

    await waitFor(() => {
      expect(currentPath(slot)).toBe(WORKTREE);
    });
    // The remembered folder is never listed: the panel goes straight to the
    // checkout rather than opening DOCS and jumping a moment later.
    expect(
      slot.inspection.rpcCalls.filter(
        (call) => call.method === "listDir" && (call.input as { path: string }).path === DOCS,
      ),
    ).toEqual([]);
    expect(await slot.findByText("README.md")).toBeDefined();
  });

  it("falls back to the ordinary choice when the thread has no folder", async () => {
    const slot = mountTab(
      withPreferenceOn({
        threadWorkspace: () => ({ path: null, insideRoot: false, reason: "no_environment" }),
      }),
    );

    await slot.findByText("notes.txt");
    expect(currentPath(slot)).toBe(ROOT);
  });

  it("falls back when the lookup fails outright, rather than showing nothing", async () => {
    const slot = mountTab(
      withPreferenceOn({
        threadWorkspace: () => {
          throw new Error("io_error: bb is restarting");
        },
      }),
    );

    await slot.findByText("notes.txt");
    expect(currentPath(slot)).toBe(ROOT);
  });

  it("leaves the nav panel alone: it has no thread to be in", async () => {
    const navPanel = app.navPanels[0]!;
    const slot = renderSlot(
      { component: navPanel.component },
      { subPath: "" },
      { rpc: withPreferenceOn() as PluginRpcTestHandlers<FileManagerContract> },
    ) as RenderedSlot;

    await slot.findByText("notes.txt");
    expect(currentPath(slot)).toBe(ROOT);
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "threadWorkspace"),
    ).toEqual([]);
  });

  it("does not ask at all with the preference off", async () => {
    const slot = mountTab();
    await slot.findByText("notes.txt");

    expect(currentPath(slot)).toBe(ROOT);
    // The toolbar's own §10.3 lookup still runs; the bootstrap's does not, so
    // the count stays at the one call the button needs.
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "threadWorkspace"),
    ).toHaveLength(1);
  });
});
