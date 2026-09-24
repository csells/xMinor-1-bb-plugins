// lib/start-folder.ts — the logic the panel action and the settings section
// share. It is deliberately component-free, so it is tested here directly: the
// wire call (one savePreferences, the backend's answer returned verbatim), the
// wording of the two toasts, the short root-relative label, and the rule that
// decides when a host-delivered setting value is somebody else's write.
import { describe, expect, it } from "vitest";

import { wrapRpc, type FileManagerRpcClient } from "../../lib/fm-rpc";
import { setClientRoot } from "../../lib/fm-paths";
import {
  isExternalSettingChange,
  saveStartFolder,
  startFolderLabel,
  startFolderNotInUse,
  START_FOLDER_SAVED_TEXT,
  START_FOLDER_SAVE_FAILED_TEXT,
} from "../../lib/start-folder";

const ROOT = "/home/coder";

interface RecordedCall {
  method: string;
  input: unknown;
}

function stubRpc(
  result: unknown,
  calls: RecordedCall[] = [],
): { rpc: ReturnType<typeof wrapRpc>; calls: RecordedCall[] } {
  const client = {
    call: (method: string, input: unknown) => {
      calls.push({ method, input });
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    },
  } as unknown as FileManagerRpcClient;
  return { rpc: wrapRpc(client), calls };
}

describe("saveStartFolder", () => {
  it("writes through savePreferences and returns what the backend stored", async () => {
    // The backend realpaths the input (src/settings.ts#validateStartFolder), so
    // the answer can differ from the argument — callers must render the answer.
    const { rpc, calls } = stubRpc({
      startFolder: `${ROOT}/real`,
      preferences: {
        showHiddenFiles: false,
        confirmOnDelete: true,
        restoreLastFolder: true,
        openThreadWorkspace: false,
        sortField: "name",
        sortDirection: "asc",
        viewMode: "list",
      },
      chunkSizeBytes: 16 * 1024 * 1024,
    });

    await expect(saveStartFolder(rpc, `${ROOT}/link`)).resolves.toBe(`${ROOT}/real`);
    expect(calls).toEqual([
      { method: "savePreferences", input: { startFolder: `${ROOT}/link` } },
    ]);
  });

  it("rejects with the domain code recovered, so callers can word the failure", async () => {
    const { rpc } = stubRpc(new Error("path_escape: /etc"));

    await expect(saveStartFolder(rpc, "/etc")).rejects.toMatchObject({
      code: "path_escape",
      message: "/etc",
    });
  });

  it("keeps one wording for both surfaces", () => {
    expect(START_FOLDER_SAVED_TEXT).toBe("Start folder saved");
    expect(START_FOLDER_SAVE_FAILED_TEXT).toBe("Could not save the start folder.");
  });
});

describe("startFolderLabel", () => {
  it("names the root and shortens everything below it", () => {
    expect(startFolderLabel(ROOT, ROOT)).toBe("Home");
    expect(startFolderLabel(`${ROOT}/Work`, ROOT)).toBe("Work");
    expect(startFolderLabel(`${ROOT}/Work/projects`, ROOT)).toBe("Work/projects");
    expect(startFolderLabel(`${ROOT}/`, ROOT)).toBe("Home");
  });

  it("falls back to the root label for a path that is not under the root", () => {
    // toRelative() has no answer outside the root, and a nonsense label is
    // worse than the neutral one.
    expect(startFolderLabel("/etc", ROOT)).toBe("Home");
  });

  it("defaults to the client root published by the panel", () => {
    setClientRoot(ROOT);
    try {
      expect(startFolderLabel(`${ROOT}/Work`)).toBe("Work");
    } finally {
      setClientRoot("/");
    }
  });
});

describe("isExternalSettingChange", () => {
  it("is true only when a value the host already delivered was replaced", () => {
    expect(isExternalSettingChange(`${ROOT}/Work`, ROOT)).toBe(true);
    expect(isExternalSettingChange(ROOT, ROOT)).toBe(false);
  });

  it("is false for the first delivery — the query resolving is not a write", () => {
    expect(isExternalSettingChange(undefined, ROOT)).toBe(false);
    expect(isExternalSettingChange(null, ROOT)).toBe(false);
    // The host types settings values as `string | boolean`; only strings can be
    // a start folder, and anything else is not a change worth re-reading for.
    expect(isExternalSettingChange(true, ROOT)).toBe(false);
  });
});

describe("startFolderNotInUse", () => {
  it("reports the configured folder when the backend fell back to the root", () => {
    // src/settings.ts#resolveStartFolder never throws over a broken start
    // folder: it logs and answers with the root. That is the whole signal.
    expect(startFolderNotInUse(`${ROOT}/gone`, ROOT, ROOT)).toBe(`${ROOT}/gone`);
    expect(startFolderNotInUse("/etc", ROOT, ROOT)).toBe("/etc");
  });

  it("normalizes the setting the way the backend does before comparing", () => {
    // src/root.ts#normalize: "", "~", "~/x" and a bare relative path all mean
    // something under the root, so none of them is a disagreement by itself.
    expect(startFolderNotInUse("~", ROOT, ROOT)).toBeNull();
    expect(startFolderNotInUse("", ROOT, ROOT)).toBeNull();
    expect(startFolderNotInUse(`${ROOT}/`, ROOT, ROOT)).toBeNull();
    expect(startFolderNotInUse("~/gone", ROOT, ROOT)).toBe(`${ROOT}/gone`);
    expect(startFolderNotInUse("gone", ROOT, ROOT)).toBe(`${ROOT}/gone`);
  });

  it("says nothing when the backend resolved a real folder", () => {
    // The host's cached setting lags behind by a refetch and the backend
    // realpaths what it stores, so the two disagree constantly while
    // everything works. A resolved folder that is not the root proves it.
    expect(startFolderNotInUse(`${ROOT}/link`, `${ROOT}/real`, ROOT)).toBeNull();
    expect(startFolderNotInUse(`${ROOT}/Work`, `${ROOT}/Work`, ROOT)).toBeNull();
  });

  it("says nothing before the host has delivered a setting", () => {
    expect(startFolderNotInUse(undefined, ROOT, ROOT)).toBeNull();
    expect(startFolderNotInUse(null, ROOT, ROOT)).toBeNull();
    expect(startFolderNotInUse(true, ROOT, ROOT)).toBeNull();
    expect(startFolderNotInUse("   ", ROOT, ROOT)).toBeNull();
  });
});
