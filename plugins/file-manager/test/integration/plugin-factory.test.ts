// test/integration/plugin-factory.test.ts — the seam nothing else covers.
//
// Every other backend suite tests a module in isolation, which proves the
// modules work and proves nothing about `server.ts` actually handing them to
// the host. This file loads the real factory through the fake plugin host and
// asserts the wiring the panel depends on:
//
//   * every contract method is registered AND reachable (a missing handler
//     surfaces as `unknown_method`, which type-checking cannot catch because
//     `registerRpc` spreads `deps.transfer` into the handler map);
//   * both §5 routes are mounted, with `token` on the upload route and the
//     default `local` on the download route (§1.1: getting this wrong 415s
//     every upload in production while every unit test still passes);
//   * the §5.2 upload GC schedule exists and runs.
//
// `initRoot()` is module state (src/root.ts), so the factory's own
// `await initRoot()` pins the root at the home directory of whoever runs the
// suite; it re-points that at a temp tree immediately afterwards, exactly like
// the other backend suites.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DOWNLOAD_ROUTE,
  UPLOAD_CHUNK_ROUTE,
} from "../../src/http-routes";
import {
  MENTION_PROVIDER_ID,
  STAGING_DIR_NAME,
  PLUGIN_ID,
  UPLOAD_ID_PATTERN,
} from "../../contract";
import { DEFAULT_ROOT as ROOT_PATH, initRoot } from "../../src/root";
import plugin, { PLUGIN_VERSION, fileManagerContract } from "../../server";

/** Every method name the frozen contract declares. */
const CONTRACT_METHODS = Object.keys(fileManagerContract).sort();

let host: FakePluginHost;
let root = "";
/** True when this suite is what created `<home>/.bb-file-manager`. */
let createdRealStaging = false;

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function makeHost(): FakePluginHost {
  const created = createFakePluginHost({ pluginId: PLUGIN_ID });
  created.harness.sdk.stub("plugins.updateSettings", ((args: {
    pluginId: string;
    values: Record<string, string | boolean>;
  }) => {
    void created.harness.setSettings(args.values);
    return { pluginId: args.pluginId, values: args.values };
  }) as (...args: never[]) => unknown);
  return created;
}

beforeEach(async () => {
  createdRealStaging =
    createdRealStaging || !(await pathExists(path.join(ROOT_PATH, STAGING_DIR_NAME)));
  host = makeHost();
  // The real factory, with the real ROOT — this is the whole point of the file.
  await plugin(host.bb);
  // From here on the tree under test is a temp directory.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-factory-")));
  await initRoot(root);
});

afterEach(async () => {
  await host.harness.lifecycle.dispose();
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  // Leave the developer's home the way we found it: the factory creates its
  // staging directory at load, and an empty one is safe to take back.
  if (!createdRealStaging) return;
  const staging = path.join(ROOT_PATH, STAGING_DIR_NAME);
  await rmdir(path.join(staging, "uploads")).catch(() => undefined);
  await rmdir(staging).catch(() => undefined);
});

describe("registrations", () => {
  it("registers every contract method exactly once", () => {
    const registered = [...host.harness.inspection.registrations.rpcMethods].sort();
    expect(registered).toEqual(CONTRACT_METHODS);
    expect(registered).toHaveLength(28);
  });

  it("mounts both §5 routes with the auth modes §5 requires", () => {
    const routes = host.harness.inspection.registrations.httpRoutes.map((route) => ({
      method: route.method,
      path: route.path,
      auth: route.auth,
    }));
    expect(routes).toHaveLength(2);
    expect(routes).toContainEqual({ method: "POST", path: UPLOAD_CHUNK_ROUTE, auth: "token" });
    expect(routes).toContainEqual({ method: "GET", path: DOWNLOAD_ROUTE, auth: "local" });
  });

  it("declares the nine §7.1 settings", () => {
    expect(Object.keys(host.harness.inspection.registrations.settingsDescriptors)).toEqual([
      "startFolder",
      "restoreLastFolder",
      "openThreadWorkspace",
      "showHiddenFiles",
      "confirmOnDelete",
      "sortField",
      "sortDirection",
      "viewMode",
      "uploadChunkMiB",
    ]);
  });

  // §8.8 — the composer's pills are inert without this: the panel inserts
  // mentions naming `MENTION_PROVIDER_ID`, and only the factory registers the
  // provider that resolves them at send time.
  it("registers the §8.8 mention provider", () => {
    const providers = host.harness.inspection.registrations.mentionProviders;
    expect(providers.map((provider) => provider.id)).toEqual([MENTION_PROVIDER_ID]);
  });

  it("schedules the §5.2 upload GC and can run it", async () => {
    const schedules = host.harness.inspection.registrations.schedules.map((entry) => ({
      name: entry.name,
      cron: entry.cron,
    }));
    expect(schedules).toContainEqual({ name: "upload-gc", cron: "17 * * * *" });
    await expect(host.harness.behavior.runSchedule("upload-gc")).resolves.toBeUndefined();
  });
});

describe("reachability", () => {
  /**
   * A registered-but-unreachable method is the failure this whole file exists
   * to catch, and it has exactly one signature: `unknown_method`. Inputs below
   * are schema-valid and deliberately point at nothing, so a handler that runs
   * fails with its own code instead.
   */
  const probes: Record<string, unknown> = {
    getState: null,
    listDir: { path: "does-not-exist" },
    pathProperties: { path: "does-not-exist" },
    directorySize: { path: "does-not-exist" },
    statPath: { path: "does-not-exist" },
    createPreviewUrl: { path: "does-not-exist" },
    readTextFile: { path: "does-not-exist" },
    listArchive: { path: "does-not-exist.zip" },
    searchDir: { path: "does-not-exist", query: "x" },
    createFolder: { path: "does-not-exist", name: "x" },
    renameEntry: { path: "does-not-exist", newName: "x" },
    deleteEntries: { paths: ["does-not-exist"] },
    moveEntries: { paths: ["does-not-exist"], destinationDir: "does-not-exist" },
    copyEntries: { paths: ["does-not-exist"], destinationDir: "does-not-exist" },
    extractArchive: { archivePath: "does-not-exist" },
    jobStatus: { jobId: "nope" },
    jobCancel: { jobId: "nope" },
    uploadCreate: { dirPath: "does-not-exist", fileName: "x", sizeBytes: 1 },
    uploadStatus: { uploadId: "0".repeat(32) },
    uploadFinish: { uploadId: "0".repeat(32) },
    uploadAbort: { uploadId: "0".repeat(32) },
    savePreferences: {},
    resolveFileLocation: {
      path: "does-not-exist",
      source: { kind: "host", threadId: null, environmentId: null, projectId: null },
    },
    threadWorkspace: { threadId: "thr_does_not_exist" },
    listBookmarks: null,
    addBookmark: { path: "does-not-exist" },
    removeBookmark: { path: "does-not-exist" },
    renameBookmark: { path: "does-not-exist", name: "x" },
  };

  it("covers all 28 methods with a probe", () => {
    expect(Object.keys(probes).sort()).toEqual(CONTRACT_METHODS);
  });

  for (const method of CONTRACT_METHODS) {
    it(`dispatches ${method} to a handler`, async () => {
      const outcome = await host.harness.behavior
        .callRpc(method, probes[method])
        .then(() => null, (error: unknown) => error);
      if (outcome === null) return; // resolved — reachable by definition
      const code = (outcome as { code?: unknown }).code;
      const message = String((outcome as { message?: unknown }).message ?? outcome);
      expect(code).not.toBe("unknown_method");
      expect(message).not.toContain("unknown_method");
    });
  }
});

describe("end-to-end through the host", () => {
  it("serves getState from the live settings module", async () => {
    const state = (await host.harness.behavior.callRpc("getState", null)) as {
      root: string;
      startFolder: string;
      pluginVersion: string;
      chunkSizeBytes: number;
      archiveSupport: { zip: boolean; tar: boolean; sevenZip: boolean; rar: boolean };
    };
    expect(state.root).toBe(root);
    // The stored default (the home folder) is outside the temp root, so §7.1's
    // "fall back, never throw" rule must have kicked in.
    expect(state.startFolder).toBe(root);
    expect(state.pluginVersion).toBe(PLUGIN_VERSION);
    expect(state.chunkSizeBytes).toBe(16 * 1024 * 1024);
    expect(state.archiveSupport.tar).toBe(true);
  });

  it("reports the version the manifest declares, not one of its own", async () => {
    // `PLUGIN_VERSION` in server.ts and `version` in package.json are kept in
    // sync by hand: the manifest is what bb installs and what the release tag
    // is cut from, while PLUGIN_VERSION is what the panel and the load line in
    // the logs show. Asserting PLUGIN_VERSION against itself — as this suite
    // did — cannot catch a bump that only landed in one of the two.
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(PLUGIN_VERSION).toBe(manifest.version);

    const state = (await host.harness.behavior.callRpc("getState", null)) as {
      pluginVersion: string;
    };
    expect(state.pluginVersion).toBe(manifest.version);
  });

  it("creates, lists, renames and deletes through the wire", async () => {
    await host.harness.behavior.callRpc("createFolder", { path: root, name: "docs" });
    await writeFile(path.join(root, "docs", "a.txt"), "hello", "utf8");

    const listed = (await host.harness.behavior.callRpc("listDir", {
      path: path.join(root, "docs"),
    })) as { entries: { name: string }[]; writable: boolean };
    expect(listed.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
    expect(listed.writable).toBe(true);

    const renamed = (await host.harness.behavior.callRpc("renameEntry", {
      path: path.join(root, "docs", "a.txt"),
      newName: "b.txt",
    })) as { entry: { name: string } };
    expect(renamed.entry.name).toBe("b.txt");

    const deleted = (await host.harness.behavior.callRpc("deleteEntries", {
      paths: [path.join(root, "docs", "b.txt")],
    })) as { succeeded: string[]; failed: unknown[] };
    expect(deleted.succeeded).toHaveLength(1);
    expect(deleted.failed).toEqual([]);
  });

  it("runs the full upload path: rpc → chunk route → rpc", async () => {
    const payload = "the quick brown fox";
    const created = (await host.harness.behavior.callRpc("uploadCreate", {
      dirPath: root,
      fileName: "upload.txt",
      sizeBytes: Buffer.byteLength(payload),
    })) as { uploadId: string; receivedBytes: number; chunkSizeBytes: number };
    expect(UPLOAD_ID_PATTERN.test(created.uploadId)).toBe(true);
    expect(created.receivedBytes).toBe(0);

    const response = await host.harness.behavior.fetchHttp(
      "POST",
      `${UPLOAD_CHUNK_ROUTE}?uploadId=${created.uploadId}&offset=0`,
      { body: payload, headers: { "content-type": "application/octet-stream" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, received: payload.length });

    const status = (await host.harness.behavior.callRpc("uploadStatus", {
      uploadId: created.uploadId,
    })) as { receivedBytes: number };
    expect(status.receivedBytes).toBe(payload.length);

    const finished = (await host.harness.behavior.callRpc("uploadFinish", {
      uploadId: created.uploadId,
    })) as { entry: { path: string; sizeBytes: number } };
    expect(finished.entry.path).toBe(path.join(root, "upload.txt"));
    expect(finished.entry.sizeBytes).toBe(payload.length);
  });

  it("streams the committed file back out of the download route", async () => {
    const target = path.join(root, "download.bin");
    await writeFile(target, "0123456789", "utf8");

    const response = await host.harness.behavior.fetchHttp(
      "GET",
      `${DOWNLOAD_ROUTE}?path=${encodeURIComponent(target)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("0123456789");
  });

  it("extracts an archive through the job registry", async () => {
    const source = path.join(root, "src");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "inside.txt"), "payload", "utf8");
    execFileSync("tar", ["-c", "-f", path.join(root, "bundle.tar"), "-C", source, "inside.txt"]);

    const started = (await host.harness.behavior.callRpc("extractArchive", {
      archivePath: path.join(root, "bundle.tar"),
    })) as { job: { jobId: string; state: string } };
    expect(started.job.state).toBe("running");

    let state = started.job.state;
    for (let attempt = 0; attempt < 100 && state === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const polled = (await host.harness.behavior.callRpc("jobStatus", {
        jobId: started.job.jobId,
      })) as { job: { state: string } | null };
      state = polled.job?.state ?? "gone";
    }
    expect(state).toBe("done");
    expect(await readdir(path.join(root, "bundle"))).toEqual(["inside.txt"]);
  });

  it("lists an archive through the wire without extracting anything (§8.13)", async () => {
    const source = path.join(root, "src");
    await mkdir(path.join(source, "docs"), { recursive: true });
    await writeFile(path.join(source, "docs", "inside.txt"), "payload", "utf8");
    execFileSync("tar", ["-c", "-f", path.join(root, "bundle.tar"), "-C", source, "docs"]);
    const before = (await readdir(root)).sort();

    const listing = (await host.harness.behavior.callRpc("listArchive", {
      path: path.join(root, "bundle.tar"),
    })) as {
      format: string;
      entries: { path: string; kind: string }[];
      fileCount: number;
      directoryCount: number;
      extractable: boolean;
    };

    expect(listing.format).toBe("tar");
    expect(listing.entries).toEqual([
      expect.objectContaining({ path: "docs", kind: "directory" }),
      expect.objectContaining({ path: "docs/inside.txt", kind: "file" }),
    ]);
    expect(listing).toMatchObject({ fileCount: 1, directoryCount: 1, extractable: true });
    expect((await readdir(root)).sort()).toEqual(before);
  });

  it("persists preferences through bb.sdk.plugins.updateSettings", async () => {
    const saved = (await host.harness.behavior.callRpc("savePreferences", {
      showHiddenFiles: true,
      sortField: "size",
    })) as { preferences: { showHiddenFiles: boolean; sortField: string } };
    expect(saved.preferences.showHiddenFiles).toBe(true);
    expect(saved.preferences.sortField).toBe("size");
    expect(host.harness.inspection.sdk.callsTo("plugins.updateSettings")).toHaveLength(1);
  });
});
