// Settings descriptors (§7.1), the startFolder fallback, and savePreferences,
// which is the only writer the panel has (`useSettings()` is read-only).
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";

import { MAX_CHUNK_BYTES, MIN_CHUNK_BYTES, PLUGIN_ID } from "../../contract";
import { isFileManagerError } from "../../src/errors";
import { DEFAULT_ROOT, initRoot } from "../../src/root";
import { createSettings, settingsDescriptors, type SettingsModule } from "../../src/settings";

const MIB = 1024 * 1024;

let root = "";
let outside = "";

/** Fake host whose `plugins.updateSettings` writes back through the harness. */
function makeHost(stored: Record<string, string | boolean> = {}): FakePluginHost {
  const host = createFakePluginHost({ pluginId: PLUGIN_ID, settings: stored });
  host.harness.sdk.stub("plugins.updateSettings", ((args: {
    pluginId: string;
    values: Record<string, string | boolean>;
  }) => {
    void host.harness.setSettings(args.values);
    return { pluginId: args.pluginId, values: args.values };
  }) as (...args: never[]) => unknown);
  return host;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => {
      throw new Error(`expected the call to reject with ${code}`);
    },
    (reason: unknown) => reason,
  );
  expect(isFileManagerError(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-set-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-outside-")));
  await initRoot(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("settingsDescriptors", () => {
  it("declares exactly the nine settings of §7.1 with their defaults", () => {
    expect(Object.keys(settingsDescriptors)).toEqual([
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
    expect(settingsDescriptors.startFolder).toMatchObject({
      type: "string",
      default: DEFAULT_ROOT,
    });
    expect(settingsDescriptors.showHiddenFiles).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(settingsDescriptors.confirmOnDelete).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(settingsDescriptors.sortField).toMatchObject({
      type: "select",
      options: ["name", "size", "modified", "kind"],
      default: "name",
    });
    expect(settingsDescriptors.sortDirection).toMatchObject({
      type: "select",
      options: ["asc", "desc"],
      default: "asc",
    });
    expect(settingsDescriptors.viewMode).toMatchObject({
      type: "select",
      options: ["list", "gallery"],
      default: "list",
    });
    expect(settingsDescriptors.uploadChunkMiB).toMatchObject({
      type: "select",
      options: ["4", "8", "16", "32", "64"],
      default: "16",
    });
    // There is no `path` descriptor type — startFolder must be a string.
    for (const descriptor of Object.values(settingsDescriptors)) {
      expect(["string", "boolean", "select", "project"]).toContain(descriptor.type);
    }
  });

  it("registers those descriptors with the host", async () => {
    const host = makeHost();
    await createSettings(host.bb);
    expect(Object.keys(host.harness.registrations.settingsDescriptors)).toEqual(
      Object.keys(settingsDescriptors),
    );
    await host.harness.dispose();
  });
});

describe("defaults and derived values", () => {
  it("exposes the declared defaults as preferences", async () => {
    const host = makeHost();
    const settings = await createSettings(host.bb);
    expect(settings.preferences()).toEqual({
      showHiddenFiles: false,
      confirmOnDelete: true,
      restoreLastFolder: true,
      openThreadWorkspace: false,
      sortField: "name",
      sortDirection: "asc",
      viewMode: "list",
    });
    expect(settings.chunkSizeBytes()).toBe(16 * MIB);
    await host.harness.dispose();
  });

  it.each([
    ["4", 4 * MIB],
    ["8", 8 * MIB],
    ["16", 16 * MIB],
    ["32", 32 * MIB],
    ["64", 64 * MIB],
  ])("turns uploadChunkMiB %s into %d bytes", async (uploadChunkMiB, expected) => {
    const host = makeHost({ uploadChunkMiB });
    const settings = await createSettings(host.bb);
    expect(settings.chunkSizeBytes()).toBe(expected);
    expect(settings.chunkSizeBytes()).toBeGreaterThanOrEqual(MIN_CHUNK_BYTES);
    expect(settings.chunkSizeBytes()).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    await host.harness.dispose();
  });

  it("falls back to a sane sort and view when the stored enum is unknown", async () => {
    // The host stores whatever the CLI wrote; the contract enums are narrower.
    const host = makeHost({
      sortField: "colour",
      sortDirection: "sideways",
      viewMode: "carousel",
    });
    const settings = await createSettings(host.bb);
    expect(settings.preferences()).toMatchObject({
      sortField: "name",
      sortDirection: "asc",
      viewMode: "list",
    });
    await host.harness.dispose();
  });

  it("reads a stored gallery view back as a preference", async () => {
    const host = makeHost({ viewMode: "gallery" });
    const settings = await createSettings(host.bb);
    expect(settings.preferences().viewMode).toBe("gallery");
    await host.harness.dispose();
  });
});

describe("resolveStartFolder", () => {
  async function build(stored: Record<string, string | boolean>): Promise<{
    settings: SettingsModule;
    host: FakePluginHost;
  }> {
    const host = makeHost(stored);
    return { settings: await createSettings(host.bb), host };
  }

  it("returns a valid folder under the root", async () => {
    await mkdir(path.join(root, "projects"));
    const { settings, host } = await build({ startFolder: path.join(root, "projects") });
    await expect(settings.resolveStartFolder()).resolves.toBe(path.join(root, "projects"));
    await host.harness.dispose();
  });

  it("falls back to the root (and warns) when the folder is outside it", async () => {
    const { settings, host } = await build({ startFolder: outside });
    await expect(settings.resolveStartFolder()).resolves.toBe(root);
    expect(host.harness.logEntries.some((entry) => entry.level === "warn")).toBe(true);
    await host.harness.dispose();
  });

  it("falls back when the folder is missing, is a file, or is the stock default", async () => {
    await writeFile(path.join(root, "a.txt"), "a");
    for (const startFolder of [path.join(root, "ghost"), path.join(root, "a.txt"), DEFAULT_ROOT]) {
      const { settings, host } = await build({ startFolder });
      await expect(settings.resolveStartFolder()).resolves.toBe(root);
      await host.harness.dispose();
    }
  });

  it("falls back when the folder is a symlink pointing out of the root", async () => {
    await symlink(outside, path.join(root, "escape"));
    const { settings, host } = await build({ startFolder: path.join(root, "escape") });
    await expect(settings.resolveStartFolder()).resolves.toBe(root);
    await host.harness.dispose();
  });
});

describe("savePreferences", () => {
  it("sends exactly the changed keys to sdk.plugins.updateSettings", async () => {
    const host = makeHost();
    const settings = await createSettings(host.bb);

    const result = await settings.savePreferences({ showHiddenFiles: true, sortField: "size" });

    const calls = host.harness.sdk.callsTo("plugins.updateSettings");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({
      pluginId: PLUGIN_ID,
      values: { showHiddenFiles: true, sortField: "size" },
    });
    expect(result.preferences).toEqual({
      showHiddenFiles: true,
      confirmOnDelete: true,
      restoreLastFolder: true,
      openThreadWorkspace: false,
      sortField: "size",
      sortDirection: "asc",
      viewMode: "list",
    });
    expect(result.startFolder).toBe(root);
    expect(result.chunkSizeBytes).toBe(16 * MIB);
    await host.harness.dispose();
  });

  it("persists the realpath'ed start folder, not the raw input", async () => {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "alias"));
    const host = makeHost();
    const settings = await createSettings(host.bb);

    const result = await settings.savePreferences({ startFolder: path.join(root, "alias") });

    expect(host.harness.sdk.callsTo("plugins.updateSettings")[0]?.[0]).toEqual({
      pluginId: PLUGIN_ID,
      values: { startFolder: path.join(root, "real") },
    });
    expect(result.startFolder).toBe(path.join(root, "real"));
    await host.harness.dispose();
  });

  it("refuses an escaping or unusable start folder without writing anything", async () => {
    const host = makeHost();
    const settings = await createSettings(host.bb);

    await expectCode(settings.savePreferences({ startFolder: "/etc" }), "path_escape");
    await expectCode(settings.savePreferences({ startFolder: outside }), "path_escape");
    await expectCode(
      settings.savePreferences({ startFolder: path.join(root, "ghost") }),
      "not_found",
    );
    await writeFile(path.join(root, "a.txt"), "a");
    await expectCode(
      settings.savePreferences({ startFolder: path.join(root, "a.txt") }),
      "not_a_directory",
    );

    expect(host.harness.sdk.callsTo("plugins.updateSettings")).toHaveLength(0);
    await host.harness.dispose();
  });

  it("writes the view mode and reflects it straight away", async () => {
    const host = makeHost();
    const settings = await createSettings(host.bb);

    const result = await settings.savePreferences({ viewMode: "gallery" });

    expect(host.harness.sdk.callsTo("plugins.updateSettings")[0]?.[0]).toEqual({
      pluginId: PLUGIN_ID,
      values: { viewMode: "gallery" },
    });
    expect(result.preferences.viewMode).toBe("gallery");
    expect(settings.preferences().viewMode).toBe("gallery");
    await host.harness.dispose();
  });

  it("updates the chunk size and the cached values", async () => {
    const host = makeHost();
    const settings = await createSettings(host.bb);

    const result = await settings.savePreferences({ uploadChunkMiB: "64" });
    expect(result.chunkSizeBytes).toBe(64 * MIB);
    expect(settings.chunkSizeBytes()).toBe(64 * MIB);
    expect(settings.values().uploadChunkMiB).toBe("64");
    await host.harness.dispose();
  });

  it("writes nothing when no key was supplied", async () => {
    const host = makeHost();
    const settings = await createSettings(host.bb);
    const result = await settings.savePreferences({});
    expect(host.harness.sdk.callsTo("plugins.updateSettings")).toHaveLength(0);
    expect(result.preferences).toEqual(settings.preferences());
    await host.harness.dispose();
  });

  it("keeps the cache fresh when settings change outside this module", async () => {
    const host = makeHost();
    const settings = await createSettings(host.bb);
    expect(settings.preferences().confirmOnDelete).toBe(true);
    await host.harness.setSettings({ confirmOnDelete: false, uploadChunkMiB: "4" });
    expect(settings.preferences().confirmOnDelete).toBe(false);
    expect(settings.chunkSizeBytes()).toBe(4 * MIB);
    await host.harness.dispose();
  });
});
