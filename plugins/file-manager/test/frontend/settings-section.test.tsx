// @vitest-environment jsdom
//
// The `app.slots.settingsSection` body (v0.3). bb's declarative settings form
// has no path descriptor, so `startFolder` is otherwise a bare text field; this
// section is the same setting with the panel's folder browser attached. What is
// worth pinning here is exactly the seam between the two:
//
//   - the slot is registered at all (the host renders nothing otherwise),
//   - what it shows is whatever `getState` reports, and *only* that — never the
//     host's cached copy of the raw setting, which lags behind by a refetch,
//   - picking a folder writes it through the *same* `savePreferences` method
//     the panel action and the CLI go through, with an absolute path,
//   - the backend's answer wins (it realpaths), and a rejection leaves the old
//     value on screen,
//   - a write by somebody else (the text field above, the panel, the CLI) is
//     picked up: the section re-reads when the host delivers a new value for
//     the raw setting, and when the page returns to the foreground,
//   - a start folder the backend could not use is said out loud, and *only*
//     then — a lagging host cache or a realpath'ed answer is not a fallback,
//   - nothing here throws when the rpc is unavailable — this is a settings
//     page, not the panel, and a dead section must not take the page with it.
import { createElement } from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginRpcTestHandlers,
  RenderedSlot,
  RpcCall,
} from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract, Preferences } from "../../contract";

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

// app.tsx binds `@get-bb/plugin-sdk/app` at import time, so it may only be
// imported through loadPluginApp's thunk (see installTestPluginRuntime docs).
const app = await loadPluginApp(() => import("../../app"));
const { forgetLastFolder, readLastFolder, resetLastFolderStore, writeLastFolder } = await import(
  "../../lib/last-folder"
);

const ROOT = "/home/coder";
const WORK = `${ROOT}/Work`;
const PROJECTS = `${WORK}/projects`;
// What the backend hands back after realpath'ing PROJECTS — deliberately a
// different path, so a test can tell "rendered what we sent" from "rendered
// what the backend stored".
const PROJECTS_REAL = `${ROOT}/real-projects`;

const PREFERENCES: Preferences = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name",
  sortDirection: "asc",
  viewMode: "list",
};

const CHUNK_BYTES = 16 * 1024 * 1024;

// Radix's dialog measures its content; jsdom has no ResizeObserver.
class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

function directory(name: string, path: string): FileEntry {
  return {
    name,
    path,
    kind: "directory",
    targetKind: null,
    sizeBytes: 0,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
  };
}

const CHILDREN: Record<string, FileEntry[]> = {
  [ROOT]: [directory("Work", WORK)],
  [WORK]: [directory("projects", PROJECTS)],
};

function listingFor(path: string) {
  const entries = CHILDREN[path] ?? [];
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

function stateWith(startFolder: string) {
  return {
    root: ROOT,
    startFolder,
    preferences: PREFERENCES,
    chunkSizeBytes: CHUNK_BYTES,
    maxListEntries: 5000,
    archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
    pluginVersion: "0.3.0",
    primaryHostId: HOST_ID,
  };
}

type Handlers = Partial<PluginRpcTestHandlers<FileManagerContract>>;

function baseRpc(overrides: Handlers = {}, startFolder = WORK): Handlers {
  return {
    getState: () => stateWith(startFolder),
    listDir: (input) => listingFor(input.path),
    // Mirrors src/settings.ts: the backend realpaths what it is given and
    // returns the stored form.
    savePreferences: (input) => ({
      startFolder:
        input.startFolder === PROJECTS ? PROJECTS_REAL : (input.startFolder ?? startFolder),
      preferences: PREFERENCES,
      chunkSizeBytes: CHUNK_BYTES,
    }),
    ...overrides,
  };
}

const section = app.settingsSections[0]!;

function renderSection(
  handlers: Handlers = baseRpc(),
  settings?: Record<string, string | boolean>,
): RenderedSlot {
  return renderSlot<Record<string, never>, FileManagerContract>(
    { component: section.component },
    {},
    {
      rpc: handlers as PluginRpcTestHandlers<FileManagerContract>,
      ...(settings === undefined ? {} : { settings }),
    },
  );
}

async function mountSection(
  handlers: Handlers = baseRpc(),
  settings?: Record<string, string | boolean>,
): Promise<RenderedSlot> {
  const slot = renderSection(handlers, settings);
  await slot.findByTestId("fm-settings-start-folder");
  return slot;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

function button(slot: RenderedSlot, testId: string): HTMLButtonElement {
  return slot.getByTestId(testId) as HTMLButtonElement;
}

/** A `savePreferences` handler that only answers when the test says so. */
function deferredSave(): {
  handler: Handlers["savePreferences"];
  release: (startFolder: string) => void;
} {
  let resolveWith: ((startFolder: string) => void) | undefined;
  return {
    handler: () =>
      new Promise((resolve) => {
        resolveWith = (startFolder: string) =>
          resolve({ startFolder, preferences: PREFERENCES, chunkSizeBytes: CHUNK_BYTES });
      }),
    release: (startFolder: string) => resolveWith!(startFolder),
  };
}

/** Opens the folder browser and waits for its first listing. */
async function openPicker(slot: RenderedSlot): Promise<HTMLElement> {
  fireEvent.click(button(slot, "fm-settings-browse"));
  const dialog = await slot.findByTestId("fm-folder-picker");
  await waitFor(() => {
    expect(callsTo(slot, "listDir").length).toBeGreaterThan(0);
  });
  return dialog;
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  // This section reads and clears the panel's location memory, which is module
  // scope plus a localStorage row — both leak between tests (PATHBAR-SPEC §9.5).
  window.localStorage.clear();
  resetLastFolderStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("settings section registration", () => {
  it("registers exactly one settings section with the host-rendered heading", () => {
    expect(app.settingsSections).toHaveLength(1);
    expect({
      id: section.id,
      title: section.title,
      description: section.description,
    }).toEqual({
      id: "start-folder",
      title: "Start folder",
      description: "Pick the folder the File Manager panel opens in.",
    });
    // Same rule as the nav panel id: letters, digits, `-`, `_`.
    expect(section.id).toMatch(/^[a-zA-Z0-9_-]+$/u);
    expect(section.component).toBeTypeOf("function");
  });
});

describe("SettingsSection — reading the current start folder", () => {
  it("bootstraps from getState and shows the stored absolute path", async () => {
    const slot = await mountSection();

    expect(callsTo(slot, "getState")).toEqual([{ method: "getState", input: null }]);
    const value = slot.getByTestId("fm-settings-start-folder");
    expect(value.textContent).toBe(WORK);
    // The full path is also reachable on hover for a truncated value.
    expect(value.getAttribute("title")).toBe(WORK);
    // Root-relative short label beside it.
    expect(slot.getByTestId("fm-settings-section").textContent).toContain("Work");
    expect(slot.getByRole("status").textContent).toBe("Saved");
  });

  it("labels the root itself and disables Reset when it is already the start folder", async () => {
    const slot = await mountSection(baseRpc({}, ROOT), { startFolder: ROOT });

    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
    expect(slot.getByTestId("fm-settings-section").textContent).toContain("Home");
    expect(button(slot, "fm-settings-reset").disabled).toBe(true);
    expect(button(slot, "fm-settings-browse").disabled).toBe(false);
  });

  it("keeps both actions disabled until the state has arrived", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = renderSection(
      baseRpc({ getState: async () => (await pending, stateWith(WORK)) }),
    );

    expect(button(slot, "fm-settings-browse").disabled).toBe(true);
    expect(button(slot, "fm-settings-reset").disabled).toBe(true);
    expect(slot.getByTestId("fm-settings-section").textContent).toContain("Loading…");

    release!();
    await slot.findByTestId("fm-settings-start-folder");
    expect(button(slot, "fm-settings-browse").disabled).toBe(false);
    expect(button(slot, "fm-settings-reset").disabled).toBe(false);
  });
});

describe("SettingsSection — picking a folder", () => {
  it("opens the folder browser at the current start folder", async () => {
    const slot = await mountSection();
    const dialog = await openPicker(slot);

    expect(callsTo(slot, "listDir")).toEqual([
      { method: "listDir", input: { path: WORK, showHidden: false } },
    ]);
    expect(within(dialog).getByText("projects")).toBeDefined();
    expect(callsTo(slot, "savePreferences")).toHaveLength(0);
  });

  it("follows the panel's hidden-files preference into the browser", async () => {
    const slot = await mountSection(
      baseRpc({
        getState: () => ({
          ...stateWith(WORK),
          preferences: { ...PREFERENCES, showHiddenFiles: true },
        }),
      }),
    );
    await openPicker(slot);

    expect(callsTo(slot, "listDir")).toEqual([
      { method: "listDir", input: { path: WORK, showHidden: true } },
    ]);
  });

  it("saves the chosen folder as an absolute path and renders what the backend stored", async () => {
    const slot = await mountSection();
    const dialog = await openPicker(slot);

    fireEvent.click(within(dialog).getAllByTestId("fm-picker-folder")[0]!);
    await waitFor(() => {
      expect(within(dialog).getByText(PROJECTS)).toBeDefined();
    });
    fireEvent.click(within(dialog).getByText("Use this folder"));

    await waitFor(() => {
      expect(callsTo(slot, "savePreferences")).toEqual([
        { method: "savePreferences", input: { startFolder: PROJECTS } },
      ]);
    });
    // The backend realpaths the input; the section must render its answer,
    // not the path it sent.
    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(PROJECTS_REAL);
    });
    expect(toasts.success).toEqual(["Start folder saved"]);
    await waitFor(() => {
      expect(slot.queryByTestId("fm-folder-picker")).toBeNull();
    });
  });

  it("reopens the browser at the folder that was saved last", async () => {
    // The browser starts where it is told at *opening* time, not from a value
    // it keeps live — a background refresh must not move it, and the second
    // opening must not go back to where the first one started.
    const slot = await mountSection();
    const dialog = await openPicker(slot);
    fireEvent.click(within(dialog).getAllByTestId("fm-picker-folder")[0]!);
    await waitFor(() => {
      expect(within(dialog).getByText(PROJECTS)).toBeDefined();
    });
    fireEvent.click(within(dialog).getByText("Use this folder"));
    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(PROJECTS_REAL);
    });

    fireEvent.click(button(slot, "fm-settings-browse"));
    await slot.findByTestId("fm-folder-picker");

    await waitFor(() => {
      expect(callsTo(slot, "listDir").at(-1)).toEqual({
        method: "listDir",
        input: { path: PROJECTS_REAL, showHidden: false },
      });
    });
  });

  it("writes nothing when the browser is cancelled", async () => {
    const slot = await mountSection();
    const dialog = await openPicker(slot);

    fireEvent.click(within(dialog).getByText("Cancel"));

    await waitFor(() => {
      expect(slot.queryByTestId("fm-folder-picker")).toBeNull();
    });
    expect(callsTo(slot, "savePreferences")).toHaveLength(0);
    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(WORK);
  });

  it("shows the backend's rejection inline and keeps the previous folder", async () => {
    const slot = await mountSection(
      baseRpc({
        savePreferences: () => {
          throw new Error("path_escape: /etc");
        },
      }),
    );
    const dialog = await openPicker(slot);
    fireEvent.click(within(dialog).getAllByTestId("fm-picker-folder")[0]!);
    await waitFor(() => {
      expect(within(dialog).getByText(PROJECTS)).toBeDefined();
    });
    fireEvent.click(within(dialog).getByText("Use this folder"));

    // lib/errors.ts maps the domain code to its one-sentence form.
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toBe("That path is outside the file manager root.");
    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(WORK);
    expect(toasts.success).toEqual([]);
    // The section is still usable: a second attempt is not blocked.
    expect(button(slot, "fm-settings-browse").disabled).toBe(false);
  });
});

describe("SettingsSection — resetting", () => {
  it("writes the root back through the same rpc method", async () => {
    const slot = await mountSection();
    expect(button(slot, "fm-settings-reset").textContent).toContain(ROOT);

    fireEvent.click(button(slot, "fm-settings-reset"));

    await waitFor(() => {
      expect(callsTo(slot, "savePreferences")).toEqual([
        { method: "savePreferences", input: { startFolder: ROOT } },
      ]);
    });
    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
    });
    expect(button(slot, "fm-settings-reset").disabled).toBe(true);
    expect(toasts.success).toEqual(["Start folder saved"]);
  });
});

describe("SettingsSection — one value, several writers", () => {
  // `startFolder` also has the host's own text field, the panel's "Set as start
  // folder" action and `bb plugin config` writing it. The server broadcasts
  // `plugins-changed` on every effective change and the app invalidates its
  // settings queries from it, so the *other* editors refresh themselves; what
  // this section owes them is to re-read its own `getState` snapshot instead of
  // showing a value somebody replaced minutes ago.
  it("renders the folder getState reports, never the host's cached setting", async () => {
    // §7.1: an unusable `startFolder` never throws — the backend logs it and
    // hands back the root. The value on screen is always the backend's.
    const slot = await mountSection(baseRpc({}, ROOT), { startFolder: `${ROOT}/gone` });

    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
    expect(slot.getByTestId("fm-settings-section").textContent).toContain("Home");
  });

  it("re-reads when the host delivers a value somebody else wrote", async () => {
    // The server broadcasts `plugins-changed` on every effective settings
    // write and the app invalidates its settings query from it, so a *new*
    // raw value is how another writer reaches this section. `useSettings()`
    // hands back the very object passed here, so mutating it and re-rendering
    // is exactly that delivery.
    const settings: Record<string, string | boolean> = { startFolder: WORK };
    let stored = WORK;
    const slot = await mountSection(baseRpc({ getState: () => stateWith(stored) }), settings);
    // The first delivery is the query resolving, not a write.
    expect(callsTo(slot, "getState")).toHaveLength(1);

    stored = PROJECTS; // e.g. the "Start folder (typed path)" field above
    settings.startFolder = PROJECTS;
    slot.lifecycle.rerender(createElement(section.component, {}));

    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(PROJECTS);
    });
    expect(callsTo(slot, "getState")).toHaveLength(2);
  });

  it("re-reads only once per new value, not on every re-render", async () => {
    const settings: Record<string, string | boolean> = { startFolder: WORK };
    const slot = await mountSection(baseRpc(), settings);

    slot.lifecycle.rerender(createElement(section.component, {}));
    slot.lifecycle.rerender(createElement(section.component, {}));

    expect(callsTo(slot, "getState")).toHaveLength(1);
  });

  it("re-reads the state when the page comes back to the foreground", async () => {
    let stored = WORK;
    const slot = await mountSection(baseRpc({ getState: () => stateWith(stored) }));
    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(WORK);

    stored = PROJECTS; // e.g. `bb plugin config file-manager set startFolder …`
    fireEvent.focus(window);

    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(PROJECTS);
    });
    expect(callsTo(slot, "getState")).toHaveLength(2);
  });

  it("re-reads when the tab becomes visible again, and not when it is hidden", async () => {
    const slot = await mountSection();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(callsTo(slot, "getState")).toHaveLength(1);

    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => {
      expect(callsTo(slot, "getState")).toHaveLength(2);
    });
  });

  it("does not re-read while a save is in flight", async () => {
    const save = deferredSave();
    const slot = await mountSection(baseRpc({ savePreferences: save.handler }));

    fireEvent.click(button(slot, "fm-settings-reset"));
    await waitFor(() => {
      expect(slot.getByRole("status").textContent).toBe("Saving…");
    });
    fireEvent.focus(window);
    // The save is about to say what the setting is; a getState issued now could
    // answer with the pre-save value.
    expect(callsTo(slot, "getState")).toHaveLength(1);

    save.release(ROOT);
    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
    });
  });

  it("drops a state read that a save overtook", async () => {
    let releaseState: (() => void) | undefined;
    let reads = 0;
    const slot = await mountSection(
      baseRpc({
        getState: () => {
          reads += 1;
          if (reads === 1) return stateWith(WORK);
          return new Promise((resolve) => {
            releaseState = () => resolve(stateWith(WORK));
          });
        },
      }),
    );

    fireEvent.focus(window); // second getState, now in flight
    await waitFor(() => {
      expect(callsTo(slot, "getState")).toHaveLength(2);
    });

    fireEvent.click(button(slot, "fm-settings-reset"));
    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
    });

    releaseState!(); // the older answer finally arrives
    await waitFor(() => {
      expect(callsTo(slot, "getState")).toHaveLength(2);
    });
    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
  });
});

describe("SettingsSection — when the saved folder is not the one in use", () => {
  // 0.3.0 shipped a hint that guessed from the host's cached setting and
  // accused saves that had just succeeded; removing it left the user with no
  // sign at all that their start folder had disappeared. The signal here is
  // the backend's own answer: `resolveStartFolder()` falls back to the root
  // and says nothing, so "the panel opens the root while the setting names
  // something else" is the one shape a fallback can take.
  it("names the folder the backend is not using", async () => {
    const slot = await mountSection(baseRpc({}, ROOT), { startFolder: `${ROOT}/gone` });

    const hint = await slot.findByTestId("fm-settings-fallback");
    expect(hint.textContent).toContain(`${ROOT}/gone`);
    expect(hint.textContent).toContain("is not in use");
    expect(hint.textContent).toContain(ROOT);
  });

  it("stays quiet when the backend resolved the folder, realpath and all", async () => {
    // The backend stores the realpath'ed form, so the setting and the answer
    // routinely differ while everything works.
    const slot = await mountSection(baseRpc({}, PROJECTS_REAL), { startFolder: PROJECTS });

    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(PROJECTS_REAL);
    expect(slot.queryByTestId("fm-settings-fallback")).toBeNull();
  });

  it("stays quiet when the setting is the root itself", async () => {
    const slot = await mountSection(baseRpc({}, ROOT), { startFolder: ROOT });

    expect(slot.queryByTestId("fm-settings-fallback")).toBeNull();
  });

  it("stays quiet before the host has delivered any setting", async () => {
    const slot = await mountSection(baseRpc({}, ROOT));

    expect(slot.queryByTestId("fm-settings-fallback")).toBeNull();
  });

  it("does not accuse a Reset the host's cache has not caught up with yet", async () => {
    // The regression 0.3.0 shipped: Reset writes the root, the section renders
    // the backend's answer immediately, and the host's cached setting still
    // holds the old folder for a refetch. Comparing them there says the save
    // that just succeeded failed.
    const settings: Record<string, string | boolean> = { startFolder: WORK };
    let stored = WORK;
    const slot = await mountSection(
      baseRpc({
        getState: () => stateWith(stored),
        savePreferences: (input) => {
          stored = input.startFolder ?? stored;
          return { startFolder: stored, preferences: PREFERENCES, chunkSizeBytes: CHUNK_BYTES };
        },
      }),
      settings,
    );

    fireEvent.click(button(slot, "fm-settings-reset"));
    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
    });

    expect(toasts.success).toEqual(["Start folder saved"]);
    expect(slot.queryByTestId("fm-settings-fallback")).toBeNull();

    // …and it stays quiet once the host catches up, because by then the
    // setting and the answer agree.
    settings.startFolder = ROOT;
    slot.lifecycle.rerender(createElement(section.component, {}));
    await waitFor(() => {
      expect(callsTo(slot, "getState")).toHaveLength(2);
    });
    expect(slot.queryByTestId("fm-settings-fallback")).toBeNull();
  });
});

describe("SettingsSection — the shape the host renders it in", () => {
  it("leaves the heading and the blurb to the host", async () => {
    // PluginSettingsSections.tsx draws `title` as an <h3> and `description` as
    // a paragraph above the component; repeating either here reads as two
    // settings with the same name.
    const slot = await mountSection();

    expect(slot.queryAllByRole("heading")).toHaveLength(0);
    expect(slot.getByTestId("fm-settings-section").textContent).not.toContain(
      section.description,
    );
  });

  it("keeps live-region semantics on the roles, not on a wrapper", async () => {
    // An assertive role="alert" nested in an aria-live="polite" container has
    // no defined behaviour; the roles alone are unambiguous.
    const slot = await mountSection();

    expect(slot.getByTestId("fm-settings-section").querySelector("[aria-live]")).toBeNull();
    expect(slot.getByRole("status").textContent).toBe("Saved");
  });

  it("keeps Browse usable while a save runs, so focus can return to it", async () => {
    // Radix restores focus to whatever opened the dialog when it closes, and
    // focus() on a disabled button silently drops it on <body>.
    const save = deferredSave();
    const slot = await mountSection(baseRpc({ savePreferences: save.handler }));

    fireEvent.click(button(slot, "fm-settings-reset"));
    await waitFor(() => {
      expect(slot.getByRole("status").textContent).toBe("Saving…");
    });
    expect(button(slot, "fm-settings-browse").disabled).toBe(false);
    expect(button(slot, "fm-settings-reset").disabled).toBe(true);

    save.release(ROOT);
    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
    });
  });
});

describe("SettingsSection — degraded hosts", () => {
  it("does not crash when the rpc has no handler at all", async () => {
    // An empty handler map is what an unavailable backend looks like from the
    // frontend: every `call` rejects, `getState` included.
    const slot = renderSection({});

    // The section still renders; only the value is unavailable.
    expect(slot.getByTestId("fm-settings-section")).toBeDefined();
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("getState");
    expect(slot.queryByTestId("fm-settings-start-folder")).toBeNull();
    expect(slot.getByTestId("fm-settings-section").textContent).toContain("Unavailable");
    // Nothing can be written while the state is unknown.
    expect(button(slot, "fm-settings-browse").disabled).toBe(true);
    expect(button(slot, "fm-settings-reset").disabled).toBe(true);
  });

  it("keeps the controls alive when a background re-read fails", async () => {
    // A refresh fires on its own schedule (a broadcast, a window focus). Its
    // failure says nothing about the snapshot already in hand, and disabling
    // the folder browser over it answers a failed read by taking away the
    // user's only way to write.
    let reads = 0;
    const slot = await mountSection(
      baseRpc({
        getState: () => {
          reads += 1;
          if (reads === 1) return stateWith(WORK);
          throw new Error("io_error: /tmp");
        },
      }),
    );

    fireEvent.focus(window);
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toBe("The filesystem reported an error.");

    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(WORK);
    expect(button(slot, "fm-settings-browse").disabled).toBe(false);
    expect(button(slot, "fm-settings-reset").disabled).toBe(false);
  });

  it("does not let Try again overtake a save in flight", async () => {
    // Try again used to call the loader directly, around the guard the
    // scheduled refreshes go through: a getState issued during a save answers
    // with the pre-save value and lands after it.
    const save = deferredSave();
    let reads = 0;
    const slot = await mountSection(
      baseRpc({
        savePreferences: save.handler,
        getState: () => {
          reads += 1;
          if (reads === 1) return stateWith(WORK);
          throw new Error("io_error: /tmp");
        },
      }),
    );

    fireEvent.focus(window); // the background re-read fails → Try again appears
    await slot.findByTestId("fm-settings-retry");
    expect(callsTo(slot, "getState")).toHaveLength(2);

    fireEvent.click(button(slot, "fm-settings-reset"));
    await waitFor(() => {
      expect(callsTo(slot, "savePreferences")).toHaveLength(1);
    });

    fireEvent.click(button(slot, "fm-settings-retry"));
    expect(callsTo(slot, "getState")).toHaveLength(2);

    save.release(ROOT);
    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(ROOT);
    });
    // The save proved the backend answers, so the stale read failure goes with
    // it instead of sitting on top of a value that was just written.
    expect(slot.queryByTestId("fm-settings-retry")).toBeNull();
    expect(slot.getByRole("status").textContent).toBe("Saved");
  });

  it("recovers through Try again once getState works", async () => {
    let attempts = 0;
    const slot = renderSection(
      baseRpc({
        getState: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("io_error: /home/coder");
          return stateWith(WORK);
        },
      }),
    );

    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toBe("The filesystem reported an error.");

    fireEvent.click(button(slot, "fm-settings-retry"));

    expect(await slot.findByTestId("fm-settings-start-folder")).toBeDefined();
    expect(slot.getByTestId("fm-settings-start-folder").textContent).toBe(WORK);
    expect(callsTo(slot, "getState")).toHaveLength(2);
    expect(slot.queryByTestId("fm-settings-retry")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* v0.4.0 — the start folder is no longer the only answer (§2.2, §1.9)  */
/* ------------------------------------------------------------------ */

describe("SettingsSection — which folder actually opens (§2.2)", () => {
  function stateWithRestore(restoreLastFolder: boolean, startFolder = WORK) {
    return {
      ...stateWith(startFolder),
      preferences: { ...PREFERENCES, restoreLastFolder },
    };
  }

  it("says the start folder is the fallback while reopening is on", async () => {
    const slot = await mountSection(baseRpc({ getState: () => stateWithRestore(true) }));

    expect(slot.getByTestId("fm-settings-open-rule").textContent).toBe(
      "Reopening the last folder is on, so this is where the panel opens the first time " +
        `and whenever the last folder is gone. Everything stays inside ${ROOT}.`,
    );
  });

  it("says the start folder is the only answer while reopening is off", async () => {
    const slot = await mountSection(baseRpc({ getState: () => stateWithRestore(false) }));

    expect(slot.getByTestId("fm-settings-open-rule").textContent).toBe(
      "Reopening the last folder is off, so the panel always opens here. " +
        `Everything stays inside ${ROOT}.`,
    );
  });

  it("re-reads when the host delivers a flipped checkbox, not on a bare re-render", async () => {
    // Same delivery mechanism as the start-folder case above: `useSettings()`
    // hands back this very object, so mutating it and re-rendering is what the
    // host's own checkbox does to this section.
    const settings: Record<string, string | boolean> = {
      startFolder: WORK,
      restoreLastFolder: true,
      openThreadWorkspace: false,
    };
    let restore = true;
    const slot = await mountSection(
      baseRpc({ getState: () => stateWithRestore(restore) }),
      settings,
    );
    expect(callsTo(slot, "getState")).toHaveLength(1);
    expect(slot.getByTestId("fm-settings-open-rule").textContent).toContain("is on");

    // A re-render with nothing changed is not a delivery.
    slot.lifecycle.rerender(createElement(section.component, {}));
    expect(callsTo(slot, "getState")).toHaveLength(1);

    restore = false;
    settings.restoreLastFolder = false;
    slot.lifecycle.rerender(createElement(section.component, {}));

    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-open-rule").textContent).toContain(
        "always opens here",
      );
    });
    expect(callsTo(slot, "getState")).toHaveLength(2);
  });

  it("names the thread-folder toggle while it is on", async () => {
    const slot = await mountSection(
      baseRpc({
        getState: () => ({
          ...stateWith(WORK),
          preferences: { ...PREFERENCES, openThreadWorkspace: true },
        }),
      }),
    );

    expect(slot.getByTestId("fm-settings-open-rule").textContent).toBe(
      "Reopening the last folder is on, so this is where the panel opens the first time " +
        "and whenever the last folder is gone. Opening the thread's project folder is on, " +
        "so a File Manager tab inside a thread starts in that thread's folder instead. " +
        `Everything stays inside ${ROOT}.`,
    );
  });

  it("re-reads when the host delivers a flipped thread-folder checkbox", async () => {
    const settings: Record<string, string | boolean> = {
      startFolder: WORK,
      restoreLastFolder: true,
      openThreadWorkspace: false,
    };
    let threadFolder = false;
    const slot = await mountSection(
      baseRpc({
        getState: () => ({
          ...stateWith(WORK),
          preferences: { ...PREFERENCES, openThreadWorkspace: threadFolder },
        }),
      }),
      settings,
    );
    expect(slot.getByTestId("fm-settings-open-rule").textContent).not.toContain(
      "project folder",
    );

    threadFolder = true;
    settings.openThreadWorkspace = true;
    slot.lifecycle.rerender(createElement(section.component, {}));

    await waitFor(() => {
      expect(slot.getByTestId("fm-settings-open-rule").textContent).toContain(
        "starts in that thread's folder instead",
      );
    });
    expect(callsTo(slot, "getState")).toHaveLength(2);
  });
});

describe("SettingsSection — forgetting the remembered folder (§1.9)", () => {
  it("clears the memory with no rpc and no settings write, then disables itself", async () => {
    writeLastFolder({ path: `${ROOT}/docs`, root: ROOT });

    const slot = await mountSection();
    const forget = button(slot, "fm-settings-forget");
    expect(forget.disabled).toBe(false);
    const before = slot.inspection.rpcCalls.length;

    fireEvent.click(forget);

    expect(readLastFolder()).toBeNull();
    expect(window.localStorage.getItem("bb-plugin-file-manager:last-folder:v1")).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(before);
    expect(callsTo(slot, "savePreferences")).toHaveLength(0);
    expect(toasts.success).toEqual([`Forgotten. The panel will open in Work next time.`]);
    await waitFor(() => {
      expect(button(slot, "fm-settings-forget").disabled).toBe(true);
    });
  });

  it("is disabled when there is nothing to forget", async () => {
    forgetLastFolder();
    const slot = await mountSection();

    expect(button(slot, "fm-settings-forget").disabled).toBe(true);
    fireEvent.click(button(slot, "fm-settings-forget"));
    expect(toasts.success).toHaveLength(0);
  });

  it("names the root when the start folder is the root itself", async () => {
    writeLastFolder({ path: `${ROOT}/docs`, root: ROOT });
    const slot = await mountSection(baseRpc({}, ROOT), undefined);

    fireEvent.click(button(slot, "fm-settings-forget"));

    expect(toasts.success).toEqual(["Forgotten. The panel will open in Home next time."]);
  });
});
