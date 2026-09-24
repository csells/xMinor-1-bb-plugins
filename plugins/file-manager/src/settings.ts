// src/settings.ts — §7.1. Declarative descriptors, a live in-process cache, and
// the writer the panel needs (`useSettings()` is read-only, so savePreferences
// proxies to bb.sdk.plugins.updateSettings).
import { stat } from "node:fs/promises";
import type { BbPluginApi, PluginSettingDescriptors } from "@get-bb/plugin-sdk";

import {
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  sortDirectionSchema,
  sortFieldSchema,
  viewModeSchema,
  type Preferences,
} from "../contract";
import { fmError, mapNodeError } from "./errors";
import { DEFAULT_ROOT, getRoot, resolveExisting } from "./root";

/** §7.1 verbatim. Four descriptor types exist; there is no `path` type. */
export const settingsDescriptors = {
  startFolder: {
    type: "string",
    // Deliberately not just "Start folder": the Start folder section below is
    // the same setting with a folder browser attached, and two identically
    // labelled editors on one page read as two different settings. This field
    // is the typed/CLI form of it (`bb plugin config file-manager set
    // startFolder …`); both write the same key, so whichever is used last wins
    // and the other refreshes itself.
    label: "Start folder (typed path)",
    description:
      "Absolute path under the hard root the panel opens on its first open, " +
      "after you forget the remembered folder, and whenever the last folder is " +
      "gone — or every time, with \"Reopen the last folder\" off. " +
      "The Start folder section below sets the same value with a folder browser.",
    default: DEFAULT_ROOT,
  },
  restoreLastFolder: {
    type: "boolean",
    label: "Reopen the last folder",
    description:
      "Open the folder you were last in instead of the start folder. " +
      "The start folder is used the first time you open the panel, after you " +
      "forget the remembered folder, and whenever the last folder is gone.",
    default: true,
  },
  openThreadWorkspace: {
    type: "boolean",
    label: "Open the thread's project folder",
    description:
      "When the File Manager is opened as a tab in a thread's side panel, start " +
      "in that thread's project folder (its environment checkout) instead of the " +
      "remembered or start folder. Threads with no environment, no folder on disk, " +
      "or a folder outside the hard root fall back to the usual choice.",
    default: false,
  },
  showHiddenFiles: {
    type: "boolean",
    label: "Show hidden files",
    description: "Show dot-files and dot-directories by default.",
    default: false,
  },
  confirmOnDelete: {
    type: "boolean",
    label: "Confirm before deleting",
    description: "Ask for confirmation before deleting files and folders.",
    default: true,
  },
  sortField: {
    type: "select",
    label: "Default sort column",
    options: ["name", "size", "modified", "kind"],
    default: "name",
  },
  sortDirection: {
    type: "select",
    label: "Default sort direction",
    options: ["asc", "desc"],
    default: "asc",
  },
  viewMode: {
    type: "select",
    label: "Default view",
    description:
      "List shows a sortable table with folders you can expand in place. " +
      "Gallery shows a grid of thumbnails for the current folder.",
    options: ["list", "gallery"],
    default: "list",
  },
  uploadChunkMiB: {
    type: "select",
    label: "Upload chunk size (MiB)",
    description: "Larger chunks are faster on fast links; smaller chunks survive slow ones.",
    options: ["4", "8", "16", "32", "64"],
    default: "16",
  },
} satisfies PluginSettingDescriptors;

export interface FileManagerSettingsValues {
  startFolder: string;
  restoreLastFolder: boolean;
  openThreadWorkspace: boolean;
  showHiddenFiles: boolean;
  confirmOnDelete: boolean;
  sortField: string;
  sortDirection: string;
  viewMode: string;
  uploadChunkMiB: string;
}

/** Input of the `savePreferences` RPC method (all keys optional). */
export interface SavePreferencesInput {
  startFolder?: string | undefined;
  openThreadWorkspace?: boolean | undefined;
  showHiddenFiles?: boolean | undefined;
  confirmOnDelete?: boolean | undefined;
  sortField?: "name" | "size" | "modified" | "kind" | undefined;
  sortDirection?: "asc" | "desc" | undefined;
  viewMode?: "list" | "gallery" | undefined;
  uploadChunkMiB?: "4" | "8" | "16" | "32" | "64" | undefined;
}

export interface SavePreferencesOutput {
  startFolder: string;
  preferences: Preferences;
  chunkSizeBytes: number;
}

export interface SettingsModule {
  /** Raw, cached descriptor values. */
  values(): FileManagerSettingsValues;
  /** The subset the panel treats as preferences, with enums validated. */
  preferences(): Preferences;
  /** `uploadChunkMiB` MiB clamped to [MIN_CHUNK_BYTES, MAX_CHUNK_BYTES]. */
  chunkSizeBytes(): number;
  /** Validated start folder; falls back to the root instead of throwing. */
  resolveStartFolder(): Promise<string>;
  savePreferences(input: SavePreferencesInput): Promise<SavePreferencesOutput>;
}

function clampChunkBytes(uploadChunkMiB: string): number {
  const mib = Number(uploadChunkMiB);
  const bytes = Number.isFinite(mib) && mib > 0 ? mib * 1024 * 1024 : 16 * 1024 * 1024;
  return Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(bytes)));
}

function toPreferences(values: FileManagerSettingsValues): Preferences {
  const sortField = sortFieldSchema.safeParse(values.sortField);
  const sortDirection = sortDirectionSchema.safeParse(values.sortDirection);
  const viewMode = viewModeSchema.safeParse(values.viewMode);
  return {
    showHiddenFiles: values.showHiddenFiles,
    confirmOnDelete: values.confirmOnDelete,
    restoreLastFolder: values.restoreLastFolder,
    openThreadWorkspace: values.openThreadWorkspace,
    sortField: sortField.success ? sortField.data : "name",
    sortDirection: sortDirection.success ? sortDirection.data : "asc",
    viewMode: viewMode.success ? viewMode.data : "list",
  };
}

/**
 * Validate a start folder the strict way (used when *writing*): it must resolve
 * inside the root and be a directory. Returns the realpath'ed value.
 */
export async function validateStartFolder(input: string): Promise<string> {
  const real = await resolveExisting(input);
  const st = await stat(real).catch((error: unknown) => {
    throw mapNodeError(error, real);
  });
  if (!st.isDirectory()) throw fmError("not_a_directory", real);
  return real;
}

export async function createSettings(bb: BbPluginApi): Promise<SettingsModule> {
  const handle = bb.settings.define(settingsDescriptors);
  let current: FileManagerSettingsValues = await handle.get();
  handle.onChange((next) => {
    current = next;
  });

  async function resolveStartFolder(): Promise<string> {
    try {
      return await validateStartFolder(current.startFolder);
    } catch (error) {
      // §7.1: never throw here — a bad setting must not brick the panel.
      bb.log.warn(
        `startFolder "${current.startFolder}" is unusable (${String(error)}); falling back to ${getRoot()}`,
      );
      return getRoot();
    }
  }

  return {
    values: () => current,
    preferences: () => toPreferences(current),
    chunkSizeBytes: () => clampChunkBytes(current.uploadChunkMiB),
    resolveStartFolder,

    async savePreferences(input: SavePreferencesInput): Promise<SavePreferencesOutput> {
      const values: Record<string, string | boolean> = {};
      if (input.startFolder !== undefined) {
        // Store the realpath'ed, validated form so a later read cannot escape.
        values.startFolder = await validateStartFolder(input.startFolder);
      }
      if (input.openThreadWorkspace !== undefined) {
        values.openThreadWorkspace = input.openThreadWorkspace;
      }
      if (input.showHiddenFiles !== undefined) values.showHiddenFiles = input.showHiddenFiles;
      if (input.confirmOnDelete !== undefined) values.confirmOnDelete = input.confirmOnDelete;
      if (input.sortField !== undefined) values.sortField = input.sortField;
      if (input.sortDirection !== undefined) values.sortDirection = input.sortDirection;
      if (input.viewMode !== undefined) values.viewMode = input.viewMode;
      if (input.uploadChunkMiB !== undefined) values.uploadChunkMiB = input.uploadChunkMiB;

      if (Object.keys(values).length > 0) {
        // bb.sdk is bind-gated: read it here, never at factory top level.
        await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values });
        // onChange fires asynchronously via the host; keep the cache correct now.
        current = { ...current, ...values } as FileManagerSettingsValues;
      }

      return {
        startFolder: await resolveStartFolder(),
        preferences: toPreferences(current),
        chunkSizeBytes: clampChunkBytes(current.uploadChunkMiB),
      };
    },
  };
}
