// src/rpc.ts — wiring only. Core (metadata) handlers live here; the byte-transfer
// half of the contract is injected as `deps.transfer` so this module never
// imports src/uploads.ts, src/archives.ts or src/jobs.ts.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";

import { MAX_LIST_ENTRIES, fileManagerContract, type FileManagerContract } from "../contract";
import type { BookmarksModule } from "./bookmarks";
import { listDir, searchDir, statPath } from "./listing";
import { locateFile, resolveThreadWorkspace } from "./locate";
import {
  copyEntries,
  createFolder,
  deleteEntries,
  moveEntries,
  renameEntry,
} from "./mutations";
import { createPreviewUrl, readTextFile } from "./preview";
import { directorySize, pathProperties } from "./properties";
import { getRoot } from "./root";
import type { SettingsModule } from "./settings";

export type FileManagerHandlers = PluginRpcHandlers<FileManagerContract>;

/** The half of the contract BACKEND-TRANSFER implements (uploads + archives). */
export type TransferHandlers = Pick<
  FileManagerHandlers,
  | "extractArchive"
  | "listArchive"
  | "jobStatus"
  | "jobCancel"
  | "uploadCreate"
  | "uploadStatus"
  | "uploadFinish"
  | "uploadAbort"
>;

/** Which extractors are present on this host (probed once at load). */
export interface ArchiveSupport {
  zip: boolean;
  tar: boolean;
  sevenZip: boolean;
  rar: boolean;
}

export interface RpcDeps {
  settings: SettingsModule;
  /** §8.11 folder shortcuts; the only reader/writer of the plugin's kv row. */
  bookmarks: BookmarksModule;
  archiveSupport: ArchiveSupport;
  pluginVersion: string;
  transfer: TransferHandlers;
}

/**
 * The id of the machine bb runs on, which is the machine this plugin reads.
 *
 * Resolved once and remembered: `getState` runs on every panel mount, and the
 * answer cannot change without a server restart. A failure is not fatal — the
 * panel falls back to downloading a double-clicked file — so it is cached as
 * "unknown" only for this call and retried on the next one.
 */
async function resolvePrimaryHostId(bb: BbPluginApi): Promise<string | null> {
  if (cachedPrimaryHostId !== undefined) return cachedPrimaryHostId;
  try {
    const config = await bb.sdk.system.config();
    cachedPrimaryHostId = config.primaryHostId;
    return cachedPrimaryHostId;
  } catch (error) {
    bb.log.warn(`could not resolve the primary host: ${String(error)}`);
    return null;
  }
}

let cachedPrimaryHostId: string | null | undefined;

/** The metadata half of the contract — everything that never carries bytes. */
export function createCoreHandlers(
  bb: BbPluginApi,
  deps: Omit<RpcDeps, "transfer">,
): Omit<FileManagerHandlers, keyof TransferHandlers> {
  return {
    async getState() {
      return {
        root: getRoot(),
        primaryHostId: await resolvePrimaryHostId(bb),
        startFolder: await deps.settings.resolveStartFolder(),
        preferences: deps.settings.preferences(),
        chunkSizeBytes: deps.settings.chunkSizeBytes(),
        maxListEntries: MAX_LIST_ENTRIES,
        archiveSupport: deps.archiveSupport,
        pluginVersion: deps.pluginVersion,
      };
    },

    listDir: (input) => listDir(input),
    pathProperties: (input) => pathProperties(input),
    directorySize: (input) => directorySize(input),
    statPath: (input) => statPath(input),
    createPreviewUrl: (input) => createPreviewUrl(bb, input),
    readTextFile: (input) => readTextFile(input),
    resolveFileLocation: (input) => locateFile(bb, input),
    threadWorkspace: (input) => resolveThreadWorkspace(bb, input),
    searchDir: (input) => searchDir(input),

    createFolder: (input) => createFolder(bb, input),
    renameEntry: (input) => renameEntry(bb, input),
    deleteEntries: (input) => deleteEntries(bb, input),
    moveEntries: (input) => moveEntries(bb, input),
    copyEntries: (input) => copyEntries(bb, input),

    savePreferences: (input) => deps.settings.savePreferences(input),

    listBookmarks: () => deps.bookmarks.list(),
    addBookmark: (input) => deps.bookmarks.add(input),
    removeBookmark: (input) => deps.bookmarks.remove(input),
    renameBookmark: (input) => deps.bookmarks.rename(input),
  };
}

export function registerRpc(bb: BbPluginApi, deps: RpcDeps): void {
  const handlers: FileManagerHandlers = {
    ...createCoreHandlers(bb, deps),
    ...deps.transfer,
  };
  bb.rpc.register(fileManagerContract, handlers);
}
