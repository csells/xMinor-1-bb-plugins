// @vitest-environment jsdom
//
// The upload surface end to end: an OS drop on the panel (§8.4) drives the
// real `lib/upload-manager` singleton (§8.7) against a stubbed token endpoint
// and a stubbed XMLHttpRequest, and every state transition it publishes has to
// show up in the ActivityTray and in the sidebar accessory.
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import { TOKEN_URL, UPLOAD_CHUNK_URL, type FileEntry, type FileManagerContract } from "../../contract";

const HOST_ID = "host_test";

const toasts = vi.hoisted(() => ({ error: [] as string[], success: [] as string[], message: [] as string[] }));

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
const { getUploadManager, resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore } = await import("../../lib/last-folder");

const registration = app.navPanels[0]!;
const ROOT = "/home/coder";
const MIB = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* A drivable XMLHttpRequest                                           */
/* ------------------------------------------------------------------ */

interface ProgressLike {
  loaded: number;
  total: number;
}

class FakeXhr {
  static instances: FakeXhr[] = [];

  readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  readonly headers: Record<string, string> = {};
  url = "";
  method = "";
  status = 0;
  responseText = "";
  responseType = "";
  sentBytes = 0;
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value;
  }

  send(blob: Blob): void {
    this.sentBytes = blob.size;
    FakeXhr.instances.push(this);
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  /* ---- test drivers ---- */

  progress(loaded: number): void {
    const event: ProgressLike = { loaded, total: this.sentBytes };
    this.upload.onprogress?.(event as unknown as ProgressEvent);
  }

  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }

  get offset(): number {
    return Number(new URL(this.url, "http://localhost").searchParams.get("offset"));
  }

  get uploadId(): string {
    return new URL(this.url, "http://localhost").searchParams.get("uploadId") ?? "";
  }
}

async function nextXhr(index: number): Promise<FakeXhr> {
  await waitFor(() => {
    expect(FakeXhr.instances.length).toBeGreaterThan(index);
  });
  return FakeXhr.instances[index]!;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function entryFor(name: string, sizeBytes: number): FileEntry {
  return {
    name,
    path: `${ROOT}/${name}`,
    kind: "file",
    targetKind: null,
    sizeBytes,
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

let sessionCounter = 0;

function baseRpc(
  overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {},
): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 4 * MIB,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.1.0",
      primaryHostId: HOST_ID,
    }),
    listDir: () => ({
      path: ROOT,
      parentPath: null,
      isRoot: true,
      entries: [entryFor("existing.txt", 1)],
      truncated: false,
      totalEntries: 1,
      hiddenCount: 0,
      writable: true,
      volume: null,
    }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 4 * MIB,
    }),
    uploadCreate: () => {
      sessionCounter += 1;
      return {
        uploadId: `upload-${String(sessionCounter)}`,
        receivedBytes: 0,
        chunkSizeBytes: 4 * MIB,
        resumed: false,
      };
    },
    uploadStatus: (input) => ({
      uploadId: (input as { uploadId: string }).uploadId,
      receivedBytes: 0,
      sizeBytes: 0,
      dirPath: ROOT,
      fileName: "",
    }),
    uploadFinish: () => ({ entry: entryFor("uploaded.bin", 10) }),
    uploadAbort: () => ({ ok: true as const }),
    ...overrides,
  };
}

/** A DataTransfer faithful enough for §8.4's `webkitGetAsEntry` walk. */
function dropPayload(files: readonly File[], options: { entries?: boolean } = {}) {
  const withEntries = options.entries ?? true;
  const items = files.map((file) => ({
    kind: "file",
    type: file.type,
    getAsFile: () => file,
    ...(withEntries
      ? {
          webkitGetAsEntry: () => ({
            isFile: true,
            isDirectory: false,
            name: file.name,
            file: (resolve: (value: File) => void) => resolve(file),
          }),
        }
      : {}),
  }));
  return {
    types: ["Files"],
    files,
    items,
    getData: () => "",
    setData: () => undefined,
    dropEffect: "none",
    effectAllowed: "all",
  } as unknown as DataTransfer;
}

function fileOf(name: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: "application/octet-stream" });
}

async function mountPanel(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): Promise<RenderedSlot> {
  const slot = renderSlot(
    { component: registration.component },
    { subPath: "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  );
  await slot.findByText("existing.txt");
  return slot;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

function trayItems(slot: RenderedSlot): HTMLElement[] {
  return slot.queryAllByTestId("fm-upload-item");
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  toasts.message.length = 0;
  sessionCounter = 0;
  FakeXhr.instances = [];
  resetUploadManager();
  resetPanelSnapshot();
  // The location memory decides where the panel opens, so it leaks
  // between mounts unless every suite that mounts one clears it
  // (PATHBAR-SPEC §9.5).
  window.localStorage.clear();
  resetLastFolderStore();
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === TOKEN_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: "test-token" }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("dropping files (§8.4 → §8.7)", () => {
  it("opens one upload session per dropped file and posts the chunk with the plugin token", async () => {
    const slot = await mountPanel();

    fireEvent.drop(slot.getByTestId("fm-panel"), {
      dataTransfer: dropPayload([fileOf("one.txt", 10), fileOf("two.txt", 20)]),
    });

    await waitFor(() => {
      expect(callsTo(slot, "uploadCreate")).toHaveLength(2);
    });
    expect(callsTo(slot, "uploadCreate").map((call) => call.input)).toEqual([
      { dirPath: ROOT, fileName: "one.txt", sizeBytes: 10, lastModifiedMs: expect.any(Number), relativeDir: "" },
      { dirPath: ROOT, fileName: "two.txt", sizeBytes: 20, lastModifiedMs: expect.any(Number), relativeDir: "" },
    ]);

    const first = await nextXhr(0);
    expect(first.method).toBe("POST");
    expect(first.url.startsWith(UPLOAD_CHUNK_URL)).toBe(true);
    expect(first.offset).toBe(0);
    expect(first.headers["x-bb-plugin-token"]).toBe("test-token");
    expect(first.sentBytes).toBe(10);

    const second = await nextXhr(1);
    expect(new Set([first.uploadId, second.uploadId]).size).toBe(2);
    expect(second.offset).toBe(0);

    expect(trayItems(slot)).toHaveLength(2);
    expect(slot.getByTestId("fm-activity-tray").textContent).toContain("Uploading 2 files");
  });

  it("renders live percentages and walks queued → uploading → finishing → done", async () => {
    const slot = await mountPanel();

    fireEvent.drop(slot.getByTestId("fm-panel"), {
      dataTransfer: dropPayload([fileOf("one.txt", 10)]),
    });

    const item = await slot.findByTestId("fm-upload-item");
    await waitFor(() => {
      expect(item.getAttribute("data-upload-status")).toBe("uploading");
    });
    expect(item.textContent).toContain("0%");

    const xhr = await nextXhr(0);
    await act(async () => {
      xhr.progress(5);
    });
    await waitFor(() => {
      expect(slot.getByTestId("fm-upload-item").textContent).toContain("50%");
    });
    expect(
      slot.getByTestId("fm-progress-bar").getAttribute("style"),
    ).toContain("width: 50%");

    await act(async () => {
      xhr.respond(200, { ok: true, received: 10 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(slot.getByTestId("fm-upload-item").getAttribute("data-upload-status")).toBe("done");
    });
    expect(callsTo(slot, "uploadFinish")).toEqual([
      { method: "uploadFinish", input: { uploadId: "upload-1", conflict: "rename" } },
    ]);
    expect(slot.getByTestId("fm-activity-tray").textContent).toContain("Activity");
  });

  it("sends the chunks of one file in ascending offset order", async () => {
    const slot = await mountPanel();

    fireEvent.drop(slot.getByTestId("fm-panel"), {
      dataTransfer: dropPayload([fileOf("big.bin", 8 * MIB)]),
    });

    const first = await nextXhr(0);
    expect(first.offset).toBe(0);
    expect(first.sentBytes).toBe(4 * MIB);
    await act(async () => {
      first.respond(200, { ok: true, received: 4 * MIB });
      await Promise.resolve();
    });

    const second = await nextXhr(1);
    expect(second.offset).toBe(4 * MIB);
    expect(second.sentBytes).toBe(4 * MIB);
    await act(async () => {
      second.respond(200, { ok: true, received: 8 * MIB });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(slot.getByTestId("fm-upload-item").getAttribute("data-upload-status")).toBe("done");
    });
    expect(FakeXhr.instances).toHaveLength(2);
  });

  it("re-syncs to `expected` when the server answers 409 offset_mismatch", async () => {
    const slot = await mountPanel();

    fireEvent.drop(slot.getByTestId("fm-panel"), {
      dataTransfer: dropPayload([fileOf("one.txt", 10)]),
    });

    const first = await nextXhr(0);
    expect(first.offset).toBe(0);
    await act(async () => {
      first.respond(409, { ok: false, error: "offset_mismatch", expected: 4 });
      await Promise.resolve();
    });

    const second = await nextXhr(1);
    expect(second.offset).toBe(4);
    expect(second.sentBytes).toBe(6);
    await waitFor(() => {
      expect(slot.getByTestId("fm-upload-item").textContent).toContain("40%");
    });

    await act(async () => {
      second.respond(200, { ok: true, received: 10 });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(slot.getByTestId("fm-upload-item").getAttribute("data-upload-status")).toBe("done");
    });
  });

  it("shows a failed upload with its message and a Retry affordance", async () => {
    const slot = await mountPanel();

    fireEvent.drop(slot.getByTestId("fm-panel"), {
      dataTransfer: dropPayload([fileOf("one.txt", 10)]),
    });

    const xhr = await nextXhr(0);
    await act(async () => {
      // 413: the file changed under us — a terminal failure, no retry loop.
      xhr.respond(413, { ok: false, error: "size_mismatch" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(slot.getByTestId("fm-upload-item").getAttribute("data-upload-status")).toBe("error");
    });
    const item = slot.getByTestId("fm-upload-item");
    expect(item.textContent).toContain("Failed");
    expect(within(item).getByLabelText("Retry one.txt")).toBeDefined();
  });

  it("cancels an in-flight upload from the tray and aborts the session server-side", async () => {
    const slot = await mountPanel();

    fireEvent.drop(slot.getByTestId("fm-panel"), {
      dataTransfer: dropPayload([fileOf("one.txt", 10)]),
    });

    const xhr = await nextXhr(0);
    const item = await slot.findByTestId("fm-upload-item");
    await act(async () => {
      fireEvent.click(within(item).getByLabelText("Cancel one.txt"));
    });

    await waitFor(() => {
      expect(slot.getByTestId("fm-upload-item").getAttribute("data-upload-status")).toBe("canceled");
    });
    expect(xhr.aborted).toBe(true);
    await waitFor(() => {
      expect(callsTo(slot, "uploadAbort")).toEqual([
        { method: "uploadAbort", input: { uploadId: "upload-1" } },
      ]);
    });
  });

  it("falls back to a flat file list and warns when the browser has no webkitGetAsEntry", async () => {
    const slot = await mountPanel();

    fireEvent.drop(slot.getByTestId("fm-panel"), {
      dataTransfer: dropPayload([fileOf("one.txt", 10)], { entries: false }),
    });

    await waitFor(() => {
      expect(callsTo(slot, "uploadCreate")).toHaveLength(1);
    });
    expect(toasts.message).toContain(
      "Folder upload is not supported in this browser — drop individual files.",
    );
  });

  it("uploads into the current directory when files arrive through the hidden picker", async () => {
    const slot = await mountPanel();
    const input = slot.getByTestId("fm-file-input") as HTMLInputElement;
    const file = fileOf("picked.txt", 4);

    Object.defineProperty(input, "files", {
      configurable: true,
      value: {
        0: file,
        length: 1,
        item: (index: number) => (index === 0 ? file : null),
        [Symbol.iterator]: function* () {
          yield file;
        },
      },
    });
    fireEvent.change(input);

    await waitFor(() => {
      expect(callsTo(slot, "uploadCreate")).toEqual([
        {
          method: "uploadCreate",
          input: {
            dirPath: ROOT,
            fileName: "picked.txt",
            sizeBytes: 4,
            lastModifiedMs: expect.any(Number),
            relativeDir: "",
          },
        },
      ]);
    });
  });
});

describe("sidebar accessory (§10)", () => {
  it("counts the uploads still in flight and disappears when they settle", async () => {
    const Accessory = registration.experimental_sidebarAccessory!;
    const slot = renderSlot(
      { component: Accessory },
      { subPath: "" },
      { rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract> },
    );

    expect(slot.queryByTestId("fm-sidebar-accessory")).toBeNull();

    const manager = getUploadManager();
    await act(async () => {
      manager.enqueue([{ file: fileOf("one.txt", 10), dirPath: ROOT, relativeDir: "" }]);
    });
    expect((await slot.findByTestId("fm-sidebar-accessory")).textContent).toBe("1");

    const xhr = await nextXhr(0);
    await act(async () => {
      xhr.respond(200, { ok: true, received: 10 });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(slot.queryByTestId("fm-sidebar-accessory")).toBeNull();
    });
  });
});
