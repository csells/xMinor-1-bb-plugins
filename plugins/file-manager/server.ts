// server.ts — File Manager backend entry (§1: a plain bb.server factory over
// node:fs; metadata through bb.rpc, bytes through bb.http.route).
//
// This file is wiring only. It resolves the hard root once, builds the settings
// module, hands the two halves of the contract to bb.rpc, registers the byte
// routes and the upload GC schedule, and logs on dispose.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

// One source of truth for both sides (§4): the panel does
// `useRpc<typeof fileManagerContract>()` against this re-export.
export { fileManagerContract } from "./contract";

import { registerMentions } from "./src/mentions";
import { createBookmarks } from "./src/bookmarks";
import { registerRpc, type ArchiveSupport } from "./src/rpc";
import { createSettings } from "./src/settings";
import { getRoot, initRoot } from "./src/root";

/* --- BACKEND-TRANSFER modules (see the integration note at the bottom) --- */
import { createArchives } from "./src/archives";
import { createJobs } from "./src/jobs";
import { createUploads } from "./src/uploads";
import { registerHttpRoutes } from "./src/http-routes";

/** Kept in sync with package.json#version by hand, like the first-party plugins. */
export const PLUGIN_VERSION = "0.9.1";
export const PLUGIN_NAME = "File Manager";

/** §5.2: hourly sweep of upload sessions whose part file is older than 24 h. */
const UPLOAD_GC_CRON = "17 * * * *";
const UPLOAD_GC_NAME = "upload-gc";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  // §6: ROOT is realpath'ed exactly once; every later path check compares
  // against this value, after its own realpath.
  const root = await initRoot();
  const settings = await createSettings(bb);
  // Synchronous on purpose: every kv access is per call, so there is nothing
  // to warm up and nothing a failed read at load could take down (§8.11).
  const bookmarks = createBookmarks(bb);

  /* ---------------- byte transfer (BACKEND-TRANSFER) ---------------- */
  const jobs = await createJobs(bb);
  const archives = await createArchives(bb, { jobs, settings });
  const uploads = await createUploads(bb, { settings });
  const archiveSupport: ArchiveSupport = archives.support;

  registerHttpRoutes(bb, { uploads });
  bb.background.schedule(UPLOAD_GC_NAME, UPLOAD_GC_CRON, async () => {
    const dropped = await uploads.sweep();
    if (dropped > 0) bb.log.info(`upload-gc dropped ${dropped} stale upload session(s)`);
  });
  // §5.2: the GC also runs once at load, so a crash mid-upload cannot leave
  // stale parts lying around until the next hour boundary.
  void uploads.sweep().catch((error: unknown) => {
    bb.log.warn(`upload-gc sweep at load failed: ${String(error)}`);
  });

  /* ---------------- rpc ---------------- */
  registerRpc(bb, {
    settings,
    bookmarks,
    archiveSupport,
    pluginVersion: PLUGIN_VERSION,
    transfer: {
      extractArchive: archives.extractArchive,
      listArchive: archives.listArchive,
      jobStatus: jobs.jobStatus,
      jobCancel: jobs.jobCancel,
      uploadCreate: uploads.uploadCreate,
      uploadStatus: uploads.uploadStatus,
      uploadFinish: uploads.uploadFinish,
      uploadAbort: uploads.uploadAbort,
    },
  });

  /* ---------------- composer mentions (§8.8) ---------------- */
  // Host-rendered, no frontend bundle involved: "@" in any composer now lists
  // files from this machine, and the picked one is read fresh at send time.
  registerMentions(bb);

  bb.log.info(
    `${PLUGIN_NAME} ${PLUGIN_VERSION} loaded — root ${root}` +
      ` (zip:${archiveSupport.zip} tar:${archiveSupport.tar} 7z:${archiveSupport.sevenZip}` +
      ` rar:${archiveSupport.rar})`,
  );

  bb.onDispose(() => {
    // Hooks run LIFO, so this one — registered last — runs *first*, and must
    // therefore not tear anything down that the modules still need.
    // `createArchives` registers its own hook (kill the extractor children,
    // delete their staging directories) and it runs right after this line.
    // Uploads need no hook: a chunk in flight holds nothing but a raw fd, and
    // its `.part` file is the resume point by design (§5.2).
    bb.log.info(`${PLUGIN_NAME} disposed — root was ${getRoot()}`);
  });
}

/* --------------------------------------------------------------------------
 * Integration note (BACKEND-CORE → BACKEND-TRANSFER)
 *
 * The four imports above are the *entire* coupling surface between the two
 * backend workstreams. src/rpc.ts deliberately imports none of them: it takes
 * the seven transfer methods as `deps.transfer`, typed straight off
 * contract.ts, so a name change here is a one-line edit in this file only.
 *
 * Expected exports:
 *   src/jobs.ts        createJobs(bb) -> { jobStatus, jobCancel }
 *                      (handlers matching the contract methods of the same name)
 *   src/archives.ts    createArchives(bb, { jobs, settings })
 *                        -> { extractArchive, listArchive,
 *                             support: { zip, tar, sevenZip, rar } }
 *                      (listArchive is src/archive-listing.ts, built on the
 *                      same executable probe — §8.13)
 *   src/uploads.ts     createUploads(bb, { settings })
 *                        -> { uploadCreate, uploadStatus, uploadFinish,
 *                             uploadAbort, sweep() }
 *   src/http-routes.ts registerHttpRoutes(bb, { uploads }) -> void
 *
 * `src/bookmarks.ts` is BACKEND-CORE, not transfer: it carries no bytes and is
 * handed to `registerRpc` as an ordinary dependency, like `settings`.
 *
 * All three factories are awaited, so returning a plain object is fine too.
 * `settings` is the SettingsModule from src/settings.ts (chunkSizeBytes(),
 * preferences(), values(), resolveStartFolder(), savePreferences()).
 * ------------------------------------------------------------------------ */
