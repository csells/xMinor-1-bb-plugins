// @vitest-environment jsdom
//
// PATHBAR-SPEC §1 / §9.3 — "come back where I left off", end to end through the
// real panel.
//
// The harness has no router: `useBbNavigate()` records the call instead of
// re-rendering the panel with a new `subPath`. Two helpers stand in for the
// host, and both are the honest simulation of what it does:
//
//   * `follow()` re-renders the same panel element with the `subPath` the panel
//     just navigated to — a route change, state preserved, exactly like the
//     host's own router;
//   * `cleanup()` + a fresh `renderSlot` is a *remount* (leaving the panel and
//     coming back), and adding `resetLastFolderStore()` to it is a *cold page
//     load* (a reload, or a bb restart): tier 1 — module scope — is gone and
//     the only thing left is the `localStorage` row.
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract, Preferences } from "../../contract";

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
const {
  forgetLastFolder,
  LAST_FOLDER_DEBOUNCE_MS,
  LAST_FOLDER_STORAGE_KEY,
  pickInitialFolder,
  readLastFolder,
  resetLastFolderStore,
  writeLastFolder,
} = await import("../../lib/last-folder");

const registration = app.navPanels[0]!;
const Panel = registration.component;
const ROOT = "/home/coder";
const DOCS = `${ROOT}/docs`;
const PICTURES = `${ROOT}/pictures`;
const SITE = `${ROOT}/projects/site`;
const GONE = `${ROOT}/gone`;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeEntry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: 12,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
  };
}

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

const PREFERENCES: Preferences = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name",
  sortDirection: "asc",
  viewMode: "list",
};

/** One file per folder, named after it, so the row proves which one is open. */
function defaultListing(path: string) {
  return listing(path, [makeEntry({ name: `${path.slice(path.lastIndexOf("/") + 1)}.txt`, path: `${path}/file.txt` })]);
}

interface RpcOptions {
  startFolder?: string;
  preferences?: Partial<Preferences>;
  /** Paths whose `listDir` throws `"<code>: <message>"`. */
  failures?: Record<string, string>;
  /**
   * Paths whose `listDir` never settles.
   *
   * Kept as a belt to the panel's braces: nothing is listed at all between the
   * bootstrap's `replace` navigation and the host applying it (see "lists
   * nothing at all until the host has applied the redirect"), so a root
   * listing should never be started in the first place. A test that names the
   * root here fails loudly if that ever stops being true, instead of quietly
   * recording a folder no user ever saw.
   */
  pending?: readonly string[];
  /** `listDir` answers for these paths verbatim (realpath'ed listings). */
  answers?: Record<string, ReturnType<typeof listing>>;
}

function rpcFor(options: RpcOptions = {}): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  const preferences: Preferences = { ...PREFERENCES, ...options.preferences };
  return {
    getState: () => ({
      root: ROOT,
      startFolder: options.startFolder ?? ROOT,
      preferences,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.4.0",
      primaryHostId: HOST_ID,
    }),
    listDir: (input) => {
      const failure = options.failures?.[input.path];
      if (failure !== undefined) throw new Error(failure);
      if (options.pending?.includes(input.path) === true) {
        return new Promise<ReturnType<typeof listing>>(() => undefined);
      }
      return options.answers?.[input.path] ?? defaultListing(input.path);
    },
    savePreferences: () => ({
      startFolder: options.startFolder ?? ROOT,
      preferences,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
  };
}

function mount(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>>,
  subPath = "",
): RenderedSlot {
  return renderSlot(
    { component: registration.component },
    { subPath },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  );
}

/** Mount and wait until a listing (or its error) is on screen. */
async function mountSettled(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>>,
  subPath = "",
): Promise<RenderedSlot> {
  const slot = mount(handlers, subPath);
  await waitFor(() => {
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "listDir").length).toBeGreaterThan(0);
  });
  await waitFor(() => {
    expect(
      slot.queryAllByTestId("fm-row").length > 0 || slot.queryByTestId("fm-error-banner") !== null,
    ).toBe(true);
  });
  return slot;
}

/** What the host does with a `toPluginPanel` call: re-render at the new route. */
function follow(slot: RenderedSlot, index: number): void {
  const call = slot.inspection.navigateCalls[index];
  expect(call?.method).toBe("toPluginPanel");
  const subPath =
    call?.method === "toPluginPanel" ? (call.options?.subPath ?? "") : "";
  slot.lifecycle.rerender(<Panel subPath={subPath} />);
}

function navigations(slot: RenderedSlot) {
  return slot.inspection.navigateCalls;
}

/** The directories `listDir` was actually asked for, in order. */
function listed(slot: RenderedSlot): string[] {
  return slot.inspection.rpcCalls
    .filter((call) => call.method === "listDir")
    .map((call) => (call.input as { path: string }).path);
}

function storedRow(): unknown {
  const raw = window.localStorage.getItem(LAST_FOLDER_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

/**
 * The §1.6 promise is "one navigation and one toast, never an error that
 * repairs itself half a second later", so the banner has to be watched for the
 * whole interaction rather than sampled at the end.
 */
function watchErrorBanner(): { seen: boolean; stop: () => void } {
  const state = { seen: false, stop: () => undefined as void };
  const check = (): void => {
    if (document.querySelector('[data-testid="fm-error-banner"]') !== null) state.seen = true;
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true });
  check();
  state.stop = () => {
    check();
    observer.disconnect();
  };
  return state;
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
/* The decision, without a renderer (§1.5)                             */
/* ------------------------------------------------------------------ */

describe("pickInitialFolder (§1.5)", () => {
  const base = {
    subPath: "",
    remembered: { path: DOCS, root: ROOT },
    workspaceFolder: null,
    startFolder: SITE,
    root: ROOT,
    restoreLastFolder: true,
    openThreadWorkspace: false,
  };

  it("puts a deep link first, whatever the memory says", () => {
    expect(pickInitialFolder({ ...base, subPath: "pictures" })).toEqual({
      path: PICTURES,
      source: "deep-link",
    });
  });

  it("prefers the memory over the configured start folder", () => {
    expect(pickInitialFolder(base)).toEqual({ path: DOCS, source: "memory" });
  });

  it("falls back to the start folder with the toggle off, or with nothing stored", () => {
    expect(pickInitialFolder({ ...base, restoreLastFolder: false })).toEqual({
      path: SITE,
      source: "start-folder",
    });
    expect(pickInitialFolder({ ...base, remembered: null })).toEqual({
      path: SITE,
      source: "start-folder",
    });
  });

  it("drops a row recorded under another root, or pointing outside this one", () => {
    expect(
      pickInitialFolder({ ...base, remembered: { path: DOCS, root: "/Users/ada" } }).source,
    ).toBe("start-folder");
    expect(
      pickInitialFolder({ ...base, remembered: { path: "/etc", root: ROOT } }).source,
    ).toBe("start-folder");
    expect(
      pickInitialFolder({ ...base, remembered: { path: `${ROOT}/../other`, root: ROOT } }).source,
    ).toBe("start-folder");
  });

  it("normalizes the folder it hands back", () => {
    expect(
      pickInitialFolder({ ...base, remembered: { path: `${ROOT}/docs/./notes/`, root: ROOT } }),
    ).toEqual({ path: `${DOCS}/notes`, source: "memory" });
  });

  it("puts the thread's folder above the memory and the start folder", () => {
    expect(pickInitialFolder({ ...base, workspaceFolder: PICTURES })).toEqual({
      path: PICTURES,
      source: "workspace",
    });
    expect(
      pickInitialFolder({ ...base, workspaceFolder: PICTURES, restoreLastFolder: false }),
    ).toEqual({ path: PICTURES, source: "workspace" });
  });

  it("still loses to a deep link, which is what the user just asked for", () => {
    expect(pickInitialFolder({ ...base, workspaceFolder: SITE, subPath: "pictures" })).toEqual({
      path: PICTURES,
      source: "deep-link",
    });
  });

  it("ignores a thread folder outside the root, which §6 forbids opening", () => {
    expect(pickInitialFolder({ ...base, workspaceFolder: "/etc" }).source).toBe("memory");
    expect(pickInitialFolder({ ...base, workspaceFolder: `${ROOT}/../other` }).source).toBe(
      "memory",
    );
  });

  it("normalizes the thread folder as well", () => {
    expect(pickInitialFolder({ ...base, workspaceFolder: `${ROOT}/docs/./notes/` })).toEqual({
      path: `${DOCS}/notes`,
      source: "workspace",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Through the panel (§1.4, §1.5)                                      */
/* ------------------------------------------------------------------ */

describe("location memory — recording (§1.4)", () => {
  it("stores the folder under the documented key, shape and root", async () => {
    const slot = await mountSettled(rpcFor(), "docs");
    await waitFor(() => {
      expect(readLastFolder()).toEqual({ path: DOCS, root: ROOT });
    });

    cleanup();
    expect(LAST_FOLDER_STORAGE_KEY).toBe("bb-plugin-file-manager:last-folder:v1");
    expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
    expect(navigations(slot)).toHaveLength(0);
  });

  it("records what listDir answered, not the route that was asked for", async () => {
    // A route through a symlink: the backend answers with the realpath.
    await mountSettled(
      rpcFor({ answers: { [`${ROOT}/link`]: listing(`${ROOT}/real`, [makeEntry({ name: "r.txt" })]) } }),
      "link",
    );
    await waitFor(() => {
      expect(readLastFolder()).toEqual({ path: `${ROOT}/real`, root: ROOT });
    });
  });

  it("never records a folder the backend refused", async () => {
    await mountSettled(rpcFor({ failures: { [`${ROOT}/bad`]: "not_found: no such folder" } }), "bad");
    await waitFor(() => {
      expect(document.querySelector('[data-testid="fm-error-banner"]')).not.toBeNull();
    });

    cleanup();
    expect(readLastFolder()).toBeNull();
    expect(storedRow()).toBeNull();
  });

  it("flushes a write that is still inside the debounce window on unmount", async () => {
    // Freeze the tier-2 debounce instead of racing it: with the 250 ms timer
    // unable to fire, the unmount flush is the only thing that can put the row
    // in storage, so this proves that path rather than the clock.
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      ms?: number,
      ...rest: unknown[]
    ) =>
      ms === LAST_FOLDER_DEBOUNCE_MS
        ? (0 as unknown as number)
        : realSetTimeout(handler, ms, ...rest)) as typeof window.setTimeout);

    await mountSettled(rpcFor(), "docs");
    await waitFor(() => {
      expect(readLastFolder()).toEqual({ path: DOCS, root: ROOT });
    });
    expect(window.localStorage.getItem(LAST_FOLDER_STORAGE_KEY)).toBeNull();

    cleanup();
    expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
  });

  it("writes nothing more when the folder on screen is listed again", async () => {
    // An `fs` signal, a reconnect and a finished job all re-deliver the same
    // listing. Recording it again would be one `localStorage` write per signal
    // in a folder a build is writing to.
    const slot = await mountSettled(rpcFor(), "docs");
    await waitFor(
      () => {
        expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
      },
      { timeout: 4_000 },
    );

    const writes = vi.spyOn(Storage.prototype, "setItem");
    for (let index = 0; index < 5; index += 1) {
      await slot.emitRealtime("fs", { paths: [DOCS] });
    }
    await new Promise((resolve) => setTimeout(resolve, LAST_FOLDER_DEBOUNCE_MS * 2));

    expect(
      writes.mock.calls.filter((call) => String(call[0]) === LAST_FOLDER_STORAGE_KEY),
    ).toHaveLength(0);
    expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
  });

  it("does not undo a Forget taken while the panel is still open", async () => {
    const slot = await mountSettled(rpcFor(), "docs");
    await waitFor(
      () => {
        expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
      },
      { timeout: 4_000 },
    );

    // What the settings section's button does, with the panel still mounted.
    forgetLastFolder();
    await slot.emitRealtime("fs", { paths: [DOCS] });
    await new Promise((resolve) => setTimeout(resolve, LAST_FOLDER_DEBOUNCE_MS * 2));

    expect(readLastFolder()).toBeNull();
    expect(storedRow()).toBeNull();
    cleanup();
    expect(storedRow()).toBeNull();
  });

  it("writes tier 2 on its own once the debounce elapses, without an unmount", async () => {
    await mountSettled(rpcFor(), "docs");
    await waitFor(
      () => {
        expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
      },
      { timeout: 4_000 },
    );
  });
});

describe("location memory — reopening (§1.5)", () => {
  it("opens the configured start folder on a first ever open", async () => {
    const slot = mount(rpcFor({ startFolder: SITE }));

    await waitFor(() => {
      expect(navigations(slot)).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "projects/site", replace: true } },
      ]);
    });
  });

  it("reopens the last folder after leaving the panel and coming back (tier 1)", async () => {
    await mountSettled(rpcFor({ startFolder: SITE }), "docs");
    await waitFor(() => {
      expect(readLastFolder()?.path).toBe(DOCS);
    });
    cleanup();

    const back = mount(rpcFor({ startFolder: SITE }));
    await waitFor(() => {
      expect(navigations(back)).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "docs", replace: true } },
      ]);
    });
  });

  it("reopens it after a reload or a bb restart (tier 2)", async () => {
    await mountSettled(rpcFor({ startFolder: SITE }), "docs");
    await waitFor(() => {
      expect(readLastFolder()?.path).toBe(DOCS);
    });
    cleanup();

    // A cold page load: module scope is gone, `localStorage` is all there is.
    const persisted = storedRow();
    resetLastFolderStore();
    expect(persisted).toEqual({ path: DOCS, root: ROOT });

    const restarted = mount(rpcFor({ startFolder: SITE }));
    await waitFor(() => {
      expect(navigations(restarted)).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "docs", replace: true } },
      ]);
    });
  });

  it("lets a deep link win, and navigates nowhere at all", async () => {
    writeLastFolder({ path: PICTURES, root: ROOT });

    const slot = await mountSettled(rpcFor({ startFolder: SITE }), "docs");
    expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(DOCS);
    const listed = slot.inspection.rpcCalls.filter((call) => call.method === "listDir");
    expect(listed[0]?.input).toEqual({ path: DOCS, showHidden: false });
    expect(navigations(slot)).toHaveLength(0);
  });

  it("with the toggle off, opens the start folder even though a folder is remembered", async () => {
    writeLastFolder({ path: DOCS, root: ROOT });

    const off = mount(
      rpcFor({ startFolder: SITE, preferences: { restoreLastFolder: false }, pending: [ROOT] }),
    );
    await waitFor(() => {
      expect(navigations(off)).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "projects/site", replace: true } },
      ]);
    });
  });

  it("records the folder even with the toggle off, so flipping it on works at once", async () => {
    await mountSettled(rpcFor({ preferences: { restoreLastFolder: false } }), "docs");
    await waitFor(() => {
      expect(readLastFolder()?.path).toBe(DOCS);
    });
    cleanup();
    // Recorded even though it was not used: turning the setting on must not
    // need a second visit to become useful.
    expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
    resetLastFolderStore();

    const on = mount(rpcFor({ startFolder: SITE, pending: [ROOT] }));
    await waitFor(() => {
      expect(navigations(on)).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "docs", replace: true } },
      ]);
    });
  });

  it("ignores a foreign, an out-of-root and a corrupt row without throwing", async () => {
    const rows: string[] = [
      JSON.stringify({ path: DOCS, root: "/Users/ada" }),
      JSON.stringify({ path: "/etc", root: ROOT }),
      JSON.stringify({ path: 42, root: ROOT }),
      "{not json",
    ];

    for (const row of rows) {
      window.localStorage.setItem(LAST_FOLDER_STORAGE_KEY, row);
      resetLastFolderStore();

      const slot = mount(rpcFor({ startFolder: SITE }));
      await waitFor(() => {
        expect(navigations(slot)).toEqual([
          {
            method: "toPluginPanel",
            path: "files",
            options: { subPath: "projects/site", replace: true },
          },
        ]);
      });
      cleanup();
      window.localStorage.clear();
      resetLastFolderStore();
    }
  });

  it("lists nothing at all until the host has applied the redirect", async () => {
    writeLastFolder({ path: DOCS, root: ROOT });

    const slot = mount(rpcFor({ startFolder: SITE }));
    await waitFor(() => {
      expect(navigations(slot)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The route still says "the root" here. Listing it would spend a full
    // readdir of the home directory on a folder nobody asked for, and would
    // record it as "where you were" for the next open.
    expect(listed(slot)).toEqual([]);

    follow(slot, 0);
    await waitFor(() => {
      expect(listed(slot)).toEqual([DOCS]);
    });
  });

  it("keeps the remembered folder when the panel is closed mid-restore", async () => {
    writeLastFolder({ path: DOCS, root: ROOT });

    const slot = mount(rpcFor({ startFolder: SITE }));
    await waitFor(() => {
      expect(navigations(slot)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    cleanup();

    expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
    expect(readLastFolder()).toEqual({ path: DOCS, root: ROOT });
  });

  it("does not redirect when the remembered folder is the root itself", async () => {
    writeLastFolder({ path: ROOT, root: ROOT });

    const slot = await mountSettled(rpcFor());
    expect(navigations(slot)).toHaveLength(0);
    expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(ROOT);
  });
});

/* ------------------------------------------------------------------ */
/* The remembered folder is gone (§1.6)                                */
/* ------------------------------------------------------------------ */

describe("location memory — the folder is gone (§1.6)", () => {
  it("falls back to the start folder, forgets the row and says so once", async () => {
    writeLastFolder({ path: GONE, root: ROOT });
    const banner = watchErrorBanner();

    const slot = mount(
      rpcFor({ startFolder: SITE, failures: { [GONE]: "not_found: no such file or directory" } }),
    );
    await waitFor(() => {
      expect(navigations(slot)).toHaveLength(1);
    });
    expect(navigations(slot)[0]).toEqual({
      method: "toPluginPanel",
      path: "files",
      options: { subPath: "gone", replace: true },
    });

    follow(slot, 0);
    await waitFor(() => {
      expect(navigations(slot)).toHaveLength(2);
    });
    expect(navigations(slot)[1]).toEqual({
      method: "toPluginPanel",
      path: "files",
      options: { subPath: "projects/site", replace: true },
    });
    expect(toasts.message).toEqual([
      "The folder you were last in is gone. Opened projects/site instead.",
    ]);
    expect(readLastFolder()).toBeNull();

    // …and the fallback folder actually opens, still without a banner.
    follow(slot, 1);
    await waitFor(() => {
      expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(SITE);
    });
    await waitFor(() => {
      expect(slot.queryAllByTestId("fm-row").length).toBeGreaterThan(0);
    });
    banner.stop();
    expect(banner.seen).toBe(false);
    expect(toasts.message).toHaveLength(1);
    expect(toasts.error).toHaveLength(0);
  });

  it("shows the ordinary banner when the folder it lost is the start folder too", async () => {
    // The common configuration: a start folder is set, so the very first open
    // remembers it and every later open restores the same path. There is
    // nowhere to fall back to — the banner and its Retry are the whole answer,
    // and a navigation to the route the panel is already on would silence the
    // banner for good.
    writeLastFolder({ path: SITE, root: ROOT });

    const slot = mount(
      rpcFor({ startFolder: SITE, failures: { [SITE]: "not_found: no such file or directory" } }),
    );
    await waitFor(() => {
      expect(navigations(slot)).toHaveLength(1);
    });
    follow(slot, 0);

    await waitFor(() => {
      expect(slot.queryByTestId("fm-error-banner")).not.toBeNull();
    });
    // No second, identical navigation and no toast naming the folder that just
    // failed to open as the folder that opened instead.
    expect(navigations(slot)).toHaveLength(1);
    expect(toasts.message).toHaveLength(0);
    // The row still goes: the next open must not try the dead folder again.
    expect(readLastFolder()).toBeNull();

    // And the banner is still there a moment later, with its Retry.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const banner = slot.getByTestId("fm-error-banner");
    expect(banner.textContent).toContain("Could not open this folder");
    expect(banner.textContent).toContain("Retry");
  });

  it("uses the permission wording when the folder is there but closed", async () => {
    writeLastFolder({ path: GONE, root: ROOT });

    const slot = mount(
      rpcFor({ startFolder: SITE, failures: { [GONE]: "permission_denied: EACCES" } }),
    );
    await waitFor(() => {
      expect(navigations(slot)).toHaveLength(1);
    });
    follow(slot, 0);

    await waitFor(() => {
      expect(toasts.message).toEqual([
        "The folder you were last in cannot be opened. Opened projects/site instead.",
      ]);
    });
    expect(navigations(slot)[1]?.method).toBe("toPluginPanel");
    expect(readLastFolder()).toBeNull();
  });

  it("treats io_error as a transient failure: banner, no fallback, memory kept", async () => {
    writeLastFolder({ path: DOCS, root: ROOT });

    const slot = mount(
      rpcFor({
        startFolder: SITE,
        failures: { [DOCS]: "io_error: input/output error" },
        pending: [ROOT],
      }),
    );
    await waitFor(() => {
      expect(navigations(slot)).toHaveLength(1);
    });
    follow(slot, 0);

    await waitFor(() => {
      expect(slot.queryByTestId("fm-error-banner")).not.toBeNull();
    });
    expect(navigations(slot)).toHaveLength(1);
    expect(toasts.message).toHaveLength(0);
    expect(readLastFolder()).toEqual({ path: DOCS, root: ROOT });
    expect(storedRow()).toEqual({ path: DOCS, root: ROOT });
  });

  it("falls back only for the folder it restored, not for a folder you walked into", async () => {
    writeLastFolder({ path: DOCS, root: ROOT });

    const slot = mount(
      rpcFor({ startFolder: SITE, failures: { [`${DOCS}/inner`]: "not_found: gone" } }),
    );
    await waitFor(() => {
      expect(navigations(slot)).toHaveLength(1);
    });
    follow(slot, 0);
    await waitFor(() => {
      expect(slot.queryAllByTestId("fm-row").length).toBeGreaterThan(0);
    });

    // The restore succeeded; a later failure is a plain error, not a reset.
    slot.lifecycle.rerender(<Panel subPath="docs/inner" />);
    await waitFor(() => {
      expect(slot.queryByTestId("fm-error-banner")).not.toBeNull();
    });
    expect(navigations(slot)).toHaveLength(1);
    expect(toasts.message).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The user-facing reset (§1.9)                                        */
/* ------------------------------------------------------------------ */

describe("forgetLastFolder (§1.9)", () => {
  it("removes the row from both tiers so the start folder opens again", async () => {
    writeLastFolder({ path: DOCS, root: ROOT });
    expect(storedRow()).toEqual({ path: DOCS, root: ROOT });

    forgetLastFolder();
    expect(readLastFolder()).toBeNull();
    // A tombstone would still be a row: the key itself has to go.
    expect(window.localStorage.getItem(LAST_FOLDER_STORAGE_KEY)).toBeNull();

    resetLastFolderStore();
    const slot = mount(rpcFor({ startFolder: SITE }));
    await waitFor(() => {
      expect(navigations(slot)).toEqual([
        { method: "toPluginPanel", path: "files", options: { subPath: "projects/site", replace: true } },
      ]);
    });
  });
});
