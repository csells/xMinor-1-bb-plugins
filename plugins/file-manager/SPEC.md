# File Manager — Implementation Spec (v0.1.0)

Frozen implementation contract for `bb-plugin-file-manager`. Written so that a
BACKEND engineer, a FRONTEND engineer and a PACKAGING engineer can work in
parallel without talking to each other. Everything in this document is derived
from verified bb 0.39.0 / `@get-bb/plugin-sdk` 0.4.8 sources; unverified items
are collected in §14 (Open questions & risks) and must not block work.

| Fact | Value | Where it comes from |
| --- | --- | --- |
| Package name | `bb-plugin-file-manager` | `package.json` |
| Plugin id (derived) | `file-manager` | `derivePluginId()` strips the `bb-plugin-` prefix |
| Panel route | `/plugins/file-manager/files/*` | navPanel `path: "files"` |
| RPC base | `POST /api/v1/plugins/file-manager/rpc/<method>` | `apps/server/src/routes/plugins.ts:610` |
| HTTP base | `/api/v1/plugins/file-manager/http/<path>` (exact match, no params) | `plugin-service.ts:1925-1932` |
| Token endpoint | `POST /api/v1/plugins/file-manager/token` body `{}` | `routes/plugins.ts:526-547` |
| Hard root | `/home/coder` (realpath'ed once at load) | product requirement |
| Server runtime | Node v24.18.0, single ext4 mount for `/` and `/home/coder` | measured on host `VIPServer` |
| Enrolled machines | exactly one (`host_3nt6p5jbbg`, VIPServer) = the bb server itself | `bb machine list` |

---

## 1. Architecture decision

**Decision: the backend is a plain `bb.server` factory that uses `node:fs` /
`node:fs/promises` directly. Byte transfer goes through `bb.http.route`
(streamed). Metadata goes through `bb.rpc`. No `bb.host` entry. No use of
`bb.sdk.files`.**

Justification (each point is a verified blocker for the alternatives):

1. **`bb.sdk.files` cannot carry the payloads this product requires.**
   `read` throws `file_too_large` above 25 MB (10 MB for images) and `write`
   caps at 25 MB (`apps/host-daemon/src/command-handlers/file-read.ts:15-16,
   318-322`; `file-write.ts:105-127`). Content travels as a base64/utf8 *string*
   inside JSON over the host WS-RPC with `COMMAND_TIMEOUT_MS = 30_000`
   (`apps/server/src/constants.ts:1`). Multi-GB is impossible by construction.
2. **`bb.sdk.files.list` cannot render this UI.** It returns only
   `{ name, path }` — no `sizeBytes`, no `modifiedAtMs`
   (`bb-plugin-sdk.d.ts:12467-12484`). `bb.sdk.hosts.directory` additionally
   *skips* dotfiles and `node_modules` (`host-files.ts:127-183`), which makes the
   required "hidden files" toggle and the size/mtime columns unimplementable.
3. **`createPreview` is not a download path.** Its GET route calls the same
   `host.read_file` (25 MB cap, whole file in memory, no `Range`)
   (`apps/server/src/routes/files.ts:352-416`).
4. **`bb.host` buys nothing today and costs correctness.** A `bb.host` entry
   exists to run code *on an enrolled machine* — but the only enrolled machine
   *is* the bb server (`/home/coder/.bb/host-id` = `host_3nt6p5jbbg`, the same
   box that serves 127.0.0.1:38886), and the host daemon exposes no streaming
   file API at all. SKILL.md's multi-machine rule
   (`bb-plugin-authoring/SKILL.md:931-941`) is explicitly scoped to CLI `run`,
   where a path argument names the *invoking* machine's disk. Our paths come
   from a browser panel talking to *this* server, so `node:fs` is the correct
   read of that rule: "`node:fs` remains correct for genuinely server-local
   data". First-party precedent: the `tasks` plugin stores and serves attachment
   blobs with `node:fs/promises` (`plugins/tasks/attachments/index.ts:1`), and
   `docs` uses `node:fs.watch` directly (`plugins/docs/server.ts:1-2`).
5. **`bb.http.route` is a genuine streaming boundary.** Request bodies arrive as
   `Readable.toWeb(incoming)` (`@hono/node-server` in
   `bb-app/server/dist/start-server.js:283300-283369`) and streamed `Response`
   bodies are piped chunk-by-chunk without buffering
   (`host-policy.ts:724-781`, test `plugin-wire.test.ts:66-86`). Handlers run
   in-process with the real Hono `Context` (`plugin-service.ts:1938`).
6. **There is no body-size limit anywhere, but there is a 5-minute wall.**
   `serve()` is called without `serverOptions` (`apps/server/src/start-server.ts:40-46`),
   so Node defaults apply: `requestTimeout = 300000` ms for *receiving a
   request*. Measured live: a slow body was killed at ~300 s. Therefore uploads
   **must** be chunked (§5.2); downloads are unaffected (`server.timeout = 0`).

**Multi-machine escape hatch (design, not v0.1 work):** every path in the RPC
contract is an absolute string plus an implicit "primary host". If a second
machine is ever enrolled, add an optional `hostId` field to the contract and
move `src/fsops.ts` behind an interface with a `bb.host` implementation. Nothing
in the frontend changes. Do not build this now.

### 1.1 Auth decision (this is the trap that shapes everything)

`auth: "local"` (the default) rejects **any** non-GET/HEAD/OPTIONS request whose
`content-type` is not exactly `application/json` with **415**
(`apps/server/src/browser-request-guard.ts:135-172`; verified live). Therefore:

* **Byte upload route → `{ auth: "token" }`.** This is the sanctioned
  first-party pattern: `plugins/tasks/attachments/index.ts:511` uses token auth
  with the comment *"Upload accepts a raw request body and therefore uses token
  auth"*. The frontend fetches the token once per session from
  `POST /api/v1/plugins/file-manager/token` (that route is origin-gated only)
  and sends `x-bb-plugin-token`.
  *Rejected alternative:* sending binary bytes while lying `content-type:
  application/json` (the guard only string-compares the header). It works, but it
  is a policy bypass with no precedent in the codebase. **Do not do it.**
* **Download route → default `auth: "local"`**, because GET is not subject to
  the content-type rule and `<a download>` navigation sends no `Origin` header.
* **All RPC → local semantics automatically** (JSON in, JSON out).

---

## 2. `package.json` (full file, ready to paste — owned by PACKAGING)

```json
{
  "name": "bb-plugin-file-manager",
  "version": "0.1.0",
  "description": "Browse, upload, download and organize files under /home/coder from a bb sidebar panel.",
  "license": "MIT",
  "type": "module",
  "keywords": ["bb-plugin", "files", "file-manager", "uploads"],
  "engines": {
    "bb": ">=0.39",
    "bbPluginSdk": ">=0.4.8"
  },
  "bb": {
    "name": "File Manager",
    "description": "Browse, upload, download, move, rename and extract files under /home/coder in a full-page panel.",
    "branding": {
      "icon": "FolderOpen"
    },
    "server": "./server.ts",
    "app": "./app.tsx"
  },
  "files": ["dist", "server.ts", "app.tsx", "contract.ts", "src", "components", "hooks", "lib", "assets", "README.md"],
  "scripts": {
    "build": "env -u BB_CLI bb plugin build .",
    "dev": "bb plugin dev .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --config vitest.config.ts",
    "types:check": "env -u BB_CLI bb plugin types --check .",
    "check": "npm run types:check && npm run typecheck && npm test && npm run build"
  },
  "dependencies": {
    "@hugeicons/core-free-icons": "^4.1.3",
    "@hugeicons/react": "^1.1.6",
    "@radix-ui/react-checkbox": "^1.3.7",
    "@radix-ui/react-separator": "^1.1.11",
    "@radix-ui/react-slot": "^1.3.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.4.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@get-bb/plugin-sdk": "0.4.8",
    "@radix-ui/react-context-menu": "^2.3.3",
    "@radix-ui/react-dialog": "^1.1.19",
    "@radix-ui/react-dropdown-menu": "^2.1.20",
    "@radix-ui/react-tooltip": "^1.2.12",
    "@testing-library/react": "^16.3.2",
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "better-sqlite3": "^12.0.0",
    "cron-parser": "^5.5.0",
    "hono": "^4.11.9",
    "jsdom": "^29.0.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "sonner": "^1.7.4",
    "typescript": "^5.7.0",
    "vitest": "^4.1.1"
  }
}
```

Rules that produced this split (do not "tidy" it):

* Everything esbuild inlines into `dist/app.js` or `dist/server.js` must be in
  `dependencies`, because git installs run `npm install --omit=dev --ignore-scripts`
  (`managed-plugin-artifacts.ts:155-180`).
* Packages the host shims at runtime are **never** bundled and belong in
  `devDependencies`: `react`, `react-dom`, `sonner`, `vaul`, `@get-bb/plugin-sdk/app`
  and the *portalled* radix families
  (`alert-dialog, context-menu, dialog, dropdown-menu, hover-card, menubar,
  navigation-menu, popover, select, tooltip`) — `build-plugin-app.ts:62-84`.
* `@radix-ui/react-checkbox` and `@radix-ui/react-separator` are **not** shimmed
  → they must stay in `dependencies`.
* `better-sqlite3`, `hono`, `@types/*` are devDependencies only to satisfy type
  references inside the SDK `.d.ts` under `skipLibCheck: false`.
* `cron-parser` is a runtime import of `@get-bb/plugin-sdk/testing` — without it
  `import("@get-bb/plugin-sdk/testing")` fails with `ERR_MODULE_NOT_FOUND`.

---

## 3. `tsconfig.json` (full file — owned by PACKAGING)

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "paths": { "@/*": ["./*"] },
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": false
  },
  "include": [
    "server.ts",
    "app.tsx",
    "contract.ts",
    "src",
    "components",
    "hooks",
    "lib",
    "test",
    "vitest.config.ts"
  ]
}
```

`paths: { "@/*": ["./*"] }` is **build-critical**, not cosmetic: esbuild resolves
`@/components/ui/button` through tsconfig `paths`. Without it the build fails,
not just the typecheck.

---

## 4. `contract.ts` — the frozen RPC interface (full file — owned by PACKAGING)

This file is written once by PACKAGING and then **read-only** for both other
workstreams. Backend imports it for handler types; frontend imports it as
`import type { fileManagerContract } from "./contract"` plus the plain constants.
`server.ts` re-exports it (`export { fileManagerContract } from "./contract";`)
so that `useRpc<typeof fileManagerContract>()` and the CLI both see one source.

```ts
// contract.ts — frozen wire contract between the File Manager backend and panel.
// Any change here is a breaking change: bump the plugin version and update both
// sides in the same commit.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Constants shared by both sides                                      */
/* ------------------------------------------------------------------ */

export const PLUGIN_ID = "file-manager";
/** navPanel `path` — the panel lives at /plugins/file-manager/files/* */
export const PANEL_PATH = "files";
/** Hard root. Nothing outside this prefix is ever readable or writable. */
export const ROOT_PATH = "/home/coder";

export const RPC_BASE = `/api/v1/plugins/${PLUGIN_ID}/rpc`;
export const HTTP_BASE = `/api/v1/plugins/${PLUGIN_ID}/http`;
export const TOKEN_URL = `/api/v1/plugins/${PLUGIN_ID}/token`;
export const UPLOAD_CHUNK_URL = `${HTTP_BASE}/upload/chunk`;
export const DOWNLOAD_URL = `${HTTP_BASE}/download`;

/** Realtime channels published with bb.realtime.publish(channel, payload). */
export const FS_CHANNEL = "fs";
export const JOB_CHANNEL = "job";

/** Hard listing cap; the panel shows a "truncated" banner past this. */
export const MAX_LIST_ENTRIES = 5000;
export const MAX_SEARCH_RESULTS = 500;
export const MAX_SEARCH_DEPTH = 8;
/** Directory that holds in-flight upload parts; always hidden from listings. */
export const STAGING_DIR_NAME = ".bb-file-manager";

export const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/u;
export const MIN_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Shared enums and schemas                                            */
/* ------------------------------------------------------------------ */

export const entryKindSchema = z.enum(["file", "directory", "symlink", "other"]);
export type EntryKind = z.infer<typeof entryKindSchema>;

export const archiveFormatSchema = z.enum([
  "zip",
  "tar",
  "tar.gz",
  "tar.bz2",
  "tar.xz",
  "7z",
]);
export type ArchiveFormat = z.infer<typeof archiveFormatSchema>;

export const sortFieldSchema = z.enum(["name", "size", "modified", "kind"]);
export const sortDirectionSchema = z.enum(["asc", "desc"]);
export const conflictPolicySchema = z.enum(["rename", "overwrite", "fail"]);

/**
 * Stable error codes. Handlers throw `Error` whose message is exactly
 * `"<code>: <human readable message>"`; the wire delivers it as
 * `{ code: "handler_error", message }`. The frontend splits on the first
 * ": " to recover the code (lib/errors.ts#parseRpcError).
 */
export const errorCodeSchema = z.enum([
  "invalid_path",
  "invalid_name",
  "path_escape",
  "not_found",
  "not_a_directory",
  "not_a_file",
  "exists",
  "not_empty",
  "permission_denied",
  "cross_device",
  "destination_inside_source",
  "unsupported_archive",
  "archive_failed",
  "upload_not_found",
  "upload_busy",
  "offset_mismatch",
  "size_mismatch",
  "no_space",
  "io_error",
  "unsupported",
]);
export type FileManagerErrorCode = z.infer<typeof errorCodeSchema>;

/** One directory entry. `path` is always absolute and inside ROOT_PATH. */
export const entrySchema = z.strictObject({
  /** Base name as it appears on disk. */
  name: z.string(),
  /** Absolute path of the entry itself (the link, not its target). */
  path: z.string(),
  /** lstat-derived kind: a symlink is reported as "symlink", never resolved. */
  kind: entryKindSchema,
  /** For symlinks: kind of the resolved target, or null when unresolvable. */
  targetKind: entryKindSchema.nullable(),
  /** lstat size for files; 0 for directories; link length for symlinks. */
  sizeBytes: z.number(),
  modifiedAtMs: z.number(),
  isHidden: z.boolean(),
  isSymlink: z.boolean(),
  /** True when the symlink resolves outside ROOT_PATH. Not navigable. */
  escapesRoot: z.boolean(),
  /** True when the name matches a supported archive extension. */
  archiveFormat: archiveFormatSchema.nullable(),
});
export type FileEntry = z.infer<typeof entrySchema>;

export const preferencesSchema = z.strictObject({
  showHiddenFiles: z.boolean(),
  confirmOnDelete: z.boolean(),
  sortField: sortFieldSchema,
  sortDirection: sortDirectionSchema,
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const volumeSchema = z.strictObject({
  totalBytes: z.number(),
  freeBytes: z.number(),
});

/** Per-path outcome for batch mutations. */
export const batchResultSchema = z.strictObject({
  succeeded: z.array(z.string()),
  failed: z.array(
    z.strictObject({
      path: z.string(),
      code: errorCodeSchema,
      message: z.string(),
    }),
  ),
});

export const jobSchema = z.strictObject({
  jobId: z.string(),
  kind: z.literal("extract"),
  state: z.enum(["running", "done", "failed", "canceled"]),
  /** Short human label, e.g. 'Extracting "archive.tar.gz"'. */
  label: z.string(),
  startedAtMs: z.number(),
  finishedAtMs: z.number().nullable(),
  /** Bytes read from the archive so far; 0 when unknown. */
  processedBytes: z.number(),
  /** Archive size in bytes; 0 when unknown. */
  totalBytes: z.number(),
  /** Absolute destination directory once known. */
  resultPath: z.string().nullable(),
  errorCode: errorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

/** Payload of the `fs` realtime channel. */
export const fsSignalSchema = z.strictObject({
  /** Absolute directories whose contents changed. */
  paths: z.array(z.string()),
  reason: z.enum([
    "create",
    "delete",
    "rename",
    "move",
    "copy",
    "upload",
    "extract",
  ]),
});
export type FsSignal = z.infer<typeof fsSignalSchema>;

/* ------------------------------------------------------------------ */
/* RPC contract                                                        */
/* ------------------------------------------------------------------ */

export const fileManagerContract = defineRpcContract({
  /** Panel bootstrap: root, persisted preferences, capabilities. */
  getState: {
    input: z.null(),
    output: z.strictObject({
      root: z.string(),
      /** Absolute, validated start folder; falls back to root when invalid. */
      startFolder: z.string(),
      preferences: preferencesSchema,
      /** Server-preferred upload chunk size in bytes (from settings). */
      chunkSizeBytes: z.number().int(),
      maxListEntries: z.number().int(),
      /** Which extractors are present on this host. */
      archiveSupport: z.strictObject({
        zip: z.boolean(),
        tar: z.boolean(),
        sevenZip: z.boolean(),
      }),
      pluginVersion: z.string(),
    }),
  },

  /** List one directory. Never recursive. */
  listDir: {
    input: z.strictObject({
      /** Absolute path, or a path relative to root. "" means root. */
      path: z.string(),
      showHidden: z.boolean().default(false),
    }),
    output: z.strictObject({
      path: z.string(),
      parentPath: z.string().nullable(),
      isRoot: z.boolean(),
      entries: z.array(entrySchema),
      /** True when the directory had more than MAX_LIST_ENTRIES entries. */
      truncated: z.boolean(),
      /** Entries present on disk before hidden filtering and truncation. */
      totalEntries: z.number().int(),
      /** How many entries the hidden filter removed. */
      hiddenCount: z.number().int(),
      /** False when the process cannot write into this directory. */
      writable: z.boolean(),
      volume: volumeSchema.nullable(),
    }),
  },

  /** Stat a single path; used for deep links and after external changes. */
  statPath: {
    input: z.strictObject({ path: z.string() }),
    output: z.strictObject({
      entry: entrySchema,
      parentPath: z.string().nullable(),
    }),
  },

  /** Depth-limited recursive name search below `path`. */
  searchDir: {
    input: z.strictObject({
      path: z.string(),
      /** Case-insensitive substring match on the entry name. */
      query: z.string().min(1),
      showHidden: z.boolean().default(false),
      maxDepth: z.number().int().min(1).max(MAX_SEARCH_DEPTH).default(4),
    }),
    output: z.strictObject({
      entries: z.array(entrySchema),
      truncated: z.boolean(),
    }),
  },

  createFolder: {
    input: z.strictObject({
      /** Parent directory. */
      path: z.string(),
      name: z.string().min(1),
    }),
    output: z.strictObject({ entry: entrySchema }),
  },

  renameEntry: {
    input: z.strictObject({
      path: z.string(),
      newName: z.string().min(1),
    }),
    output: z.strictObject({ entry: entrySchema }),
  },

  deleteEntries: {
    input: z.strictObject({
      paths: z.array(z.string()).min(1).max(1000),
      /** Required for non-empty directories; false fails with not_empty. */
      recursive: z.boolean().default(true),
    }),
    output: batchResultSchema,
  },

  moveEntries: {
    input: z.strictObject({
      paths: z.array(z.string()).min(1).max(1000),
      destinationDir: z.string(),
      conflict: conflictPolicySchema.default("fail"),
    }),
    output: batchResultSchema,
  },

  copyEntries: {
    input: z.strictObject({
      paths: z.array(z.string()).min(1).max(1000),
      destinationDir: z.string(),
      conflict: conflictPolicySchema.default("rename"),
    }),
    output: batchResultSchema,
  },

  /** Starts a background extraction; poll with jobStatus or listen on JOB_CHANNEL. */
  extractArchive: {
    input: z.strictObject({
      archivePath: z.string(),
      /** Defaults to the archive's own directory. */
      destinationDir: z.string().nullable().default(null),
      /** Extract into <dest>/<archive base name>/ instead of <dest>/. */
      createSubfolder: z.boolean().default(true),
      conflict: conflictPolicySchema.default("rename"),
    }),
    output: z.strictObject({ job: jobSchema }),
  },

  jobStatus: {
    input: z.strictObject({ jobId: z.string() }),
    output: z.strictObject({ job: jobSchema.nullable() }),
  },

  jobCancel: {
    input: z.strictObject({ jobId: z.string() }),
    output: z.strictObject({ job: jobSchema.nullable() }),
  },

  /**
   * Open (or resume) an upload session. Resume key is
   * (destination dir, file name, size, lastModifiedMs) — a repeat call with the
   * same tuple returns the existing session and its byte count.
   */
  uploadCreate: {
    input: z.strictObject({
      /** Destination directory (absolute or root-relative). */
      dirPath: z.string(),
      fileName: z.string().min(1),
      sizeBytes: z.number().int().min(0),
      lastModifiedMs: z.number().int().min(0).default(0),
      /**
       * For folder drops: POSIX sub-path under dirPath, e.g. "photos/2024".
       * Created on finish. "" for a plain file drop.
       */
      relativeDir: z.string().default(""),
    }),
    output: z.strictObject({
      uploadId: z.string(),
      /** Bytes already on disk — the client starts from this offset. */
      receivedBytes: z.number().int(),
      chunkSizeBytes: z.number().int(),
      resumed: z.boolean(),
    }),
  },

  uploadStatus: {
    input: z.strictObject({ uploadId: z.string() }),
    output: z.strictObject({
      uploadId: z.string(),
      receivedBytes: z.number().int(),
      sizeBytes: z.number().int(),
      dirPath: z.string(),
      fileName: z.string(),
    }),
  },

  /** Commits the staged part file into the destination directory. */
  uploadFinish: {
    input: z.strictObject({
      uploadId: z.string(),
      conflict: conflictPolicySchema.default("rename"),
    }),
    output: z.strictObject({ entry: entrySchema }),
  },

  /** Drops the session and its part file. */
  uploadAbort: {
    input: z.strictObject({ uploadId: z.string() }),
    output: z.strictObject({ ok: z.literal(true) }),
  },

  /**
   * Persists panel preferences. The frontend cannot write settings
   * (`useSettings()` is read-only), so this method proxies to
   * bb.sdk.plugins.updateSettings.
   */
  savePreferences: {
    input: z.strictObject({
      startFolder: z.string().optional(),
      showHiddenFiles: z.boolean().optional(),
      confirmOnDelete: z.boolean().optional(),
      sortField: sortFieldSchema.optional(),
      sortDirection: sortDirectionSchema.optional(),
      uploadChunkMiB: z.enum(["4", "8", "16", "32", "64"]).optional(),
    }),
    output: z.strictObject({
      startFolder: z.string(),
      preferences: preferencesSchema,
      chunkSizeBytes: z.number().int(),
    }),
  },
});

export type FileManagerContract = typeof fileManagerContract;
```

### 4.1 RPC semantics both sides must assume

* Transport: `POST /api/v1/plugins/file-manager/rpc/<method>`, JSON body =
  the input value, response envelope `{ ok: true, result }` or
  `{ ok: false, error: { code, message, issues? } }`. `useRpc().call()` rejects
  with an `Error` carrying `code` and `issues`.
* Input bodies are buffered whole (`context.req.text()`), outputs must be strict
  JSON (no `undefined`, `bigint`, cycles). **Never send bytes through RPC.**
* Expected failures for *single-target* methods are thrown
  (`throw new Error("not_found: /home/coder/x")`); expected failures for
  *batch* methods land in `failed[]` and the call still resolves.
* Every mutating method publishes on the `fs` channel before returning
  (§7.3).

---

## 5. HTTP route table (byte transfer)

Only **two** plugin routes exist. Route matching is exact `method + path`
string equality (`plugin-service.ts:1929`) — parameters and wildcards are
impossible, so every argument travels in the query string.

| # | Method | Path | Auth | Purpose |
| - | ------ | ---- | ---- | ------- |
| 1 | `POST` | `/api/v1/plugins/file-manager/http/upload/chunk` | `token` | append one chunk to a staged upload |
| 2 | `GET`  | `/api/v1/plugins/file-manager/http/download` | `local` (default) | stream one file, with `Range` |
| — | `POST` | `/api/v1/plugins/file-manager/token` | host route (origin-gated) | issue the plugin token to the panel |

### 5.1 Token acquisition (frontend, once per page session)

```
POST /api/v1/plugins/file-manager/token
content-type: application/json
body: {}
→ 200 { "ok": true, "token": "<64 hex>" }
```

Cache the promise; on any `401` from route 1, drop the cache and retry once
(the token can be rotated by `bb plugin token file-manager --rotate`).

### 5.2 Route 1 — `POST /http/upload/chunk` (auth: `token`)

**Query parameters**

| Name | Type | Rules |
| --- | --- | --- |
| `uploadId` | string | must match `/^[0-9a-f]{32}$/` |
| `offset` | integer | `Number.isSafeInteger`, `>= 0`, must equal the current staged size |

**Headers:** `x-bb-plugin-token: <token>` (required). `content-type` is
irrelevant on a token route — send `application/octet-stream`.
**Body:** raw bytes of `file.slice(offset, offset + chunkSize)`.

**Responses** (all JSON except the streaming success body, which is JSON too)

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{ "ok": true, "uploadId": "…", "received": 123456 }` | chunk durably written; `received` is the new staged size |
| `400` | `{ "ok": false, "error": "invalid_params" }` | bad `uploadId`/`offset`, or no body |
| `401` | host-generated | missing/invalid plugin token |
| `404` | `{ "ok": false, "error": "upload_not_found" }` | no session (expired, aborted, finished) |
| `409` | `{ "ok": false, "error": "offset_mismatch", "expected": 65536 }` | client must resume from `expected` |
| `409` | `{ "ok": false, "error": "upload_busy", "expected": 65536 }` | another chunk for this `uploadId` is in flight |
| `413` | `{ "ok": false, "error": "size_mismatch" }` | chunk would exceed the declared file size |
| `499` | `{ "ok": false, "error": "aborted", "received": 65536 }` | client disconnected mid-chunk; `received` is authoritative |
| `500` | `{ "ok": false, "error": "io_error", "message": "…" }` | unexpected fs failure |

**Server algorithm (normative)**

```
1. validate uploadId, offset
2. session = readSessionMeta(uploadId)            // JSON sidecar on disk, no DB
   if !session -> 404
3. if lockedUploads.has(uploadId) -> 409 upload_busy { expected: currentSize }
   lockedUploads.add(uploadId)
4. current = (await stat(partPath)).size
   if current !== offset -> 409 offset_mismatch { expected: current }
   if offset + declaredChunkMax > session.sizeBytes is not checkable up front;
   instead cap the write: abort and truncate back to session.sizeBytes if the
   body would push past it -> 413 size_mismatch
5. out = createWriteStream(partPath, { flags: "r+", start: offset })
   await pipeline(Readable.fromWeb(c.req.raw.body), out,
                  { signal: c.req.raw.signal })
6. fh = await open(partPath, "r+"); await fh.sync(); await fh.close()   // durability
7. respond 200 { received: (await stat(partPath)).size }
finally: lockedUploads.delete(uploadId)
```

* `flags: "r+"` + explicit `start` (never `"a"`): positional writes are
  idempotent, append mode would double-write a retried chunk.
* On abort do **not** delete the part file — the surviving byte count is what
  makes resume work; answer `499` with the real size.
* Do not touch `bb.storage`, `bb.log` or any other `bb.*` handle inside the
  streaming section: a `bb plugin reload` only drains in-flight handlers for
  5 s (`plugin-runtime.ts:321`) and then disposes plugin resources under you.
  Raw `node:fs` descriptors are unaffected.

**Temp-file strategy**

```
<ROOT>/.bb-file-manager/uploads/<uploadId>.part      staged bytes
<ROOT>/.bb-file-manager/uploads/<uploadId>.json      session metadata
```

* Created by `uploadCreate` (`open(part, "w")` → zero-length file, then close).
* Same filesystem as every destination under `/home/coder` (single ext4 mount
  verified), so `uploadFinish` commits with one atomic `rename`. If `rename`
  fails with `EXDEV`, fall back to `copyFile` + `unlink` and report progress via
  the `fs` channel only at the end.
* `<ROOT>/.bb-file-manager` is filtered out of every listing unconditionally
  (even with hidden files shown).
* Session JSON: `{ uploadId, dirPath, relativeDir, fileName, sizeBytes,
  lastModifiedMs, sessionKey, createdAtMs }`. `sessionKey =
  sha256(dirPath + "\0" + relativeDir + "\0" + fileName + "\0" + sizeBytes +
  "\0" + lastModifiedMs)` — `uploadCreate` scans existing sessions for a match
  to resume across page reloads.
* GC: `bb.background.schedule("upload-gc", "17 * * * *", …)` removes sessions
  whose `.part` mtime is older than 24 h. Also runs once at load.

**Resume protocol (client side, normative)**

```
1. { uploadId, receivedBytes, chunkSizeBytes } = rpc.uploadCreate(...)
2. offset = receivedBytes
3. while offset < file.size:
     size  = adaptiveChunkSize()            // see below
     blob  = file.slice(offset, min(offset + size, file.size))
     res   = XHR POST /http/upload/chunk?uploadId&offset  (body = blob)
     409 offset_mismatch|upload_busy -> offset = res.expected; continue
     499 aborted                    -> offset = res.received; retry (backoff)
     401                            -> refresh token; retry once
     5xx / network                  -> retry up to 3x with 1s,3s,9s backoff,
                                       re-probing offset via rpc.uploadStatus
     200                            -> offset = res.received
4. rpc.uploadFinish({ uploadId, conflict: "rename" })
```

`adaptiveChunkSize()`: start at the server-provided `chunkSizeBytes`
(default 16 MiB); after each chunk recompute
`clamp(observedBytesPerSecond * 45s, 4 MiB, 64 MiB)`. The 45 s target keeps
every request far inside Node's 300 s `requestTimeout`, which is the real
ceiling (there is no body size limit anywhere).

Concurrency: at most **2 files** uploading simultaneously, **1 chunk per file**.
Extra files queue.

### 5.3 Route 2 — `GET /http/download` (auth: `local`, the default)

**Query parameters**

| Name | Type | Rules |
| --- | --- | --- |
| `path` | string | URL-encoded absolute path, resolved by §6 |
| `disposition` | `attachment` \| `inline` | optional, default `attachment` |

**Response headers (exact list — all required)**

```
Content-Type: application/octet-stream
Content-Length: <byte count of the served range>
Accept-Ranges: bytes
Cache-Control: no-store, no-transform
ETag: "<size in hex>-<floor(mtimeMs) in hex>"
Last-Modified: <st.mtime as UTC string>
Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<encodeURIComponent(name) with ' → %27>
X-Content-Type-Options: nosniff
Content-Range: bytes <start>-<end>/<size>      // only on 206
```

* `Content-Type: application/octet-stream` is **mandatory**: it is not in hono's
  `COMPRESSIBLE_CONTENT_TYPE_REGEX`, so the global `compress()` middleware
  (`server.ts:320-329`, which does apply to plugin routes) skips it. Omitting the
  header makes `@hono/node-server` default to `text/plain; charset=UTF-8`, which
  *is* compressible → the whole multi-GB file gets gzipped and `Content-Length`
  is deleted. `Cache-Control: no-transform` is the second line of defence.
* The bundled hono is 4.11.9, which does **not** skip `206` in `compress()` —
  another reason the content type must be octet-stream.
* ASCII fallback for `filename=`: strip everything outside `\x20-\x7e` and all
  `"` characters.

**Status codes**

| Status | When |
| --- | --- |
| `200` | full body |
| `206` | valid single `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` |
| `400` | missing/invalid `path` |
| `403` | path resolves outside root (`path_escape`) |
| `404` | not found, or not a regular file (directories are not downloadable in v0.1) |
| `416` | unsatisfiable range; also send `Content-Range: bytes */<size>` |

**Body**: `Readable.toWeb(createReadStream(abs, { start, end }))`. Register
`c.req.raw.signal` → `stream.destroy()` so an aborted download does not leak an
fd. Multi-range (`bytes=0-99,200-299`) is **not** supported — answer `200` with
the full body, which is a legal degradation.

Frontend triggers the download by creating a detached `<a href download>` and
clicking it — never `await res.blob()`.

---

## 6. Path safety

`ROOT` is resolved **once** at factory time: `const ROOT = await realpath("/home/coder")`.
Everything below is the only sanctioned way to turn user input into a path.

```
CONSTANTS
  ROOT            = realpath("/home/coder")          // computed once
  STAGING         = ROOT + "/.bb-file-manager"

assertInside(p):
    if p === ROOT: return p
    if p.startsWith(ROOT + path.sep): return p
    throw Error("path_escape: " + p)

validateName(name):                                   // single path component
    if name === "" or name === "." or name === "..":   throw invalid_name
    if name.includes("/") or name.includes("\0"):      throw invalid_name
    if /[\x00-\x1f]/.test(name):                       throw invalid_name
    if Buffer.byteLength(name, "utf8") > 255:          throw invalid_name
    return name

normalize(input):                                     // lexical only
    if input === "" or input === "~":  return ROOT
    if input.startsWith("~/"):         input = ROOT + input.slice(1)
    // absolute inputs stay absolute; relative inputs resolve under ROOT
    return path.resolve(ROOT, input)

// (A) target must already exist and MAY be followed through symlinks
//     use for: listDir, statPath, searchDir, download, extract source,
//     destination directories, upload destination directory
resolveExisting(input):
    abs  = normalize(input)
    assertInside(abs)                     // cheap lexical pre-check
    real = await fs.realpath(abs)         // ENOENT → throw not_found
                                          // ELOOP  → throw io_error
    assertInside(real)                    // THE check: realpath BEFORE prefix test
    return real

// (B) target must NOT be followed (operate on the link itself)
//     use for: delete, move source, copy source, rename source
resolveLink(input):
    abs       = normalize(input)
    assertInside(abs)
    parentReal = await resolveExisting(path.dirname(abs))
    target     = path.join(parentReal, validateName(path.basename(abs)))
    assertInside(target)
    st         = await fs.lstat(target)   // ENOENT → not_found
    return { path: target, lstat: st }

// (C) target does not exist yet
//     use for: createFolder, rename destination, upload commit, move/copy dest
resolveNew(dirInput, name):
    dirReal = await resolveExisting(dirInput)
    target  = path.join(dirReal, validateName(name))
    assertInside(target)
    return target

// containment check for move/copy: refuse moving a directory into itself
assertNotInsideSelf(source, destinationDir):
    if destinationDir === source or destinationDir.startsWith(source + sep):
        throw Error("destination_inside_source: " + destinationDir)
```

Rules that follow from the algorithm — all of them are testable:

1. **`realpath` always precedes the prefix test.** A symlink `/home/coder/x → /etc`
   fails `assertInside` because `realpath("/home/coder/x") === "/etc"`. A naive
   `startsWith` on the raw string would have let it through. This mirrors what
   the bb host daemon does (`file-write.ts:66-104`, `path-mutations.ts:33-140`).
2. **Deletes, moves, renames never follow the final symlink** (`resolveLink`),
   so removing a link removes the link, not its target. The *parent chain* is
   still realpath'ed, so a symlinked ancestor cannot be used to escape.
3. **Listing marks, but does not resolve, symlinks.** For each `dirent`:
   `lstat` gives `kind`/`sizeBytes`/`modifiedAtMs`; if it is a symlink, attempt
   `realpath` in a try/catch: success inside root → `targetKind` from `stat`,
   `escapesRoot: false`; success outside root or failure → `targetKind: null`,
   `escapesRoot: true`. Entries with `escapesRoot: true` are rendered greyed out,
   are not navigable, and every backend method rejects them anyway (step 1).
4. **Hidden files** = `name.startsWith(".")`. Filtered only when
   `showHidden === false`. `.bb-file-manager` at the root is filtered
   **always**, in both modes.
5. **The root itself can never be deleted, renamed or moved**: `resolveLink`
   on `ROOT` yields `parentReal = "/home"` → `assertInside("/home")` throws.
   Add an explicit `if (target === ROOT) throw` guard anyway.
6. **Destination directories must be directories**: after `resolveExisting`,
   `stat().isDirectory()` or throw `not_a_directory`.
7. **Downloads require a regular file**: `stat().isFile()` or `404`.
8. **Uploads** validate the file name with `validateName` and resolve the
   destination with `resolveNew` at *finish* time, not at *create* time (the
   directory may have been renamed meanwhile → `not_found`).
9. **Archive extraction** stages into a fresh directory obtained through
   `resolveNew`, and after extraction walks the result to assert every path is
   still inside root (defence against symlink members in the archive).
   Empirically verified on this host: GNU tar 1.35 refuses `..` members
   (`Member name contains '..'`, exit 2) and strips leading `/`; Info-ZIP unzip
   6.00 strips `../` and absolute prefixes with a warning (exit 1). Neither is
   trusted — the post-walk is still required.
10. **Archive listing** (§8.13) clamps the archive with `resolveExisting` like
    any read and then writes nothing at all: a zip is read in-process, `tar`
    and `7z` run only in list mode, with stdin closed and the archive after
    `--file` / `--`. Member names such as `../x` or `/etc/x` are displayed and
    never used as paths.

---

## 7. Settings, storage, realtime

### 7.1 Settings descriptors (backend, `src/settings.ts`)

```ts
const settings = bb.settings.define({
  startFolder: {
    type: "string",
    label: "Start folder",
    description: "Absolute path under /home/coder that the panel opens by default.",
    default: "/home/coder",
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
  uploadChunkMiB: {
    type: "select",
    label: "Upload chunk size (MiB)",
    description: "Larger chunks are faster on fast links; smaller chunks survive slow ones.",
    options: ["4", "8", "16", "32", "64"],
    default: "16",
  },
});
```

Notes that are contract, not taste:

* The descriptor language has exactly four types — `string`, `boolean`,
  `select`, `project`. **There is no `path` type**, so `startFolder` is a
  validated string.
* Every descriptor has a `default`, so `settings.get()` returns non-optional
  values.
* `PluginSettingsHandle` has **only** `get()` and `onChange()` — no writer.
  The panel therefore persists changes through `savePreferences`, which calls
  `bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values })`.
  `bb.sdk` is bind-gated: read it inside the handler, never at factory top level.
* `settings.onChange((next) => { current = next; })` keeps the in-process cache
  fresh; saving settings does **not** reload the plugin.
* `startFolder` is validated on every read: `resolveExisting` + `isDirectory()`;
  on failure fall back to `ROOT` and log a warning (do not throw — that would
  brick the panel).
* `chunkSizeBytes = Number(uploadChunkMiB) * 1024 * 1024`, clamped to
  `[MIN_CHUNK_BYTES, MAX_CHUNK_BYTES]`.

### 7.2 Storage

* `bb.storage.kv` — one row, `bookmarks:v1` (§8.11). Unused in v0.1: settings
  covered everything persistent until the bookmark list, which is an ordered
  list of records and has no descriptor type to live in. The 256 KB per-value
  cap is what sets `MAX_BOOKMARKS`.
* `bb.storage.database()` — **not used** in v0.1. Upload sessions live in
  sidecar JSON files precisely so the chunk handler never touches a `bb.*`
  handle that a reload can close under it.
* In-memory only: `Map<jobId, Job>` and `Set<uploadId>` (chunk lock). Both are
  reset on reload; `jobStatus` on an unknown id returns `{ job: null }` and the
  panel then refetches the directory.

### 7.3 Realtime

```ts
bb.realtime.publish("fs", { paths: ["/home/coder/x"], reason: "upload" });
bb.realtime.publish("job", job);
```

Publish `fs` after every successful mutation, with the **directories** that
changed (for a move: both source dirs and the destination). The panel refetches
when any published path equals the current directory. `useRealtime` filters by
`pluginId` + channel; there are no per-channel subscriptions server-side, so
keep payloads small.

Frontend must also refetch when `useRealtimeConnectionState()` transitions to
`"connected"` (missed signals while disconnected).

---

## 8. Frontend component tree

Panel body is **full-bleed**: the host renders the plugin icon + `title` in the
shared title bar and wraps the component in `-m-4 … overflow-hidden md:-m-5`.
The root element owns padding and scrolling. **Do not render your own title.**

Route model: the panel path is the *root-relative* directory path.
`subPath` arrives URL-encoded **per segment** — decode with
`subPath.split("/").map(decodeURIComponent).join("/")` and encode by handing the
raw relative path to `toPluginPanel` (the host encodes each segment).
Sort, search, hidden-toggle and selection live in React state, **never** in the
URL (a `?` or `#` inside a file name would break naive parsing).

```
app.tsx                                   FRONTEND  slot registration (§10) + panel root wiring
components/FileManagerPanel.tsx           FRONTEND  layout, state owner, keyboard map, DnD root
components/HeaderActions.tsx              FRONTEND  headerContent: Upload / New folder / overflow menu
components/SidebarAccessory.tsx           FRONTEND  active upload count (text only)
components/Toolbar.tsx                    FRONTEND  breadcrumbs + search + sort + hidden toggle + view actions
components/Breadcrumbs.tsx                FRONTEND  clickable path segments, drop targets
components/FileTable.tsx                  FRONTEND  header row, sorting, rubber-band-free multi-select
components/FileRow.tsx                    FRONTEND  one row: icon, name, size, mtime, drag source/target
components/FileGallery.tsx                FRONTEND  the gallery view: thumbnail grid over the same handlers (§8.9)
components/RowContextMenu.tsx             FRONTEND  right-click menu for a selection
components/BackgroundContextMenu.tsx      FRONTEND  right-click menu for empty space
components/ActivityTray.tsx               FRONTEND  upload progress + extract jobs, bottom-right
components/EmptyState.tsx                 FRONTEND  empty dir / no search results / escapesRoot dir
components/ErrorBanner.tsx                FRONTEND  inline error with Retry
components/dialogs/NewFolderDialog.tsx    FRONTEND
components/dialogs/RenameDialog.tsx       FRONTEND
components/dialogs/ConfirmDeleteDialog.tsx FRONTEND
components/dialogs/ExtractDialog.tsx      FRONTEND
components/dialogs/PropertiesDialog.tsx   FRONTEND  §8.10: one path in full, or a summary of a selection
components/dialogs/FolderPickerDialog.tsx FRONTEND  own folder browser (native picker is macOS-only)
components/dialogs/FileViewerDialog.tsx  FRONTEND  §8.12: the file itself, when this surface has no bb preview panel
components/ArchiveContents.tsx            FRONTEND  §8.13: an archive's contents as a tree (viewer and file opener)
hooks/useDirectory.ts                     FRONTEND  listDir + realtime refetch + sort/filter memo
hooks/useSelection.ts                     FRONTEND  anchor/range/toggle logic
hooks/useClipboard.ts                     FRONTEND  cut/copy/paste state
hooks/useUploads.ts                       FRONTEND  React binding for lib/upload-manager
hooks/useJobs.ts                          FRONTEND  extract job list + JOB_CHANNEL
hooks/usePreviewBase.ts                   FRONTEND  one createPreviewUrl per folder, renewed before it lapses (§8.9)
lib/preview.ts                            FRONTEND  which entries have thumbnails, and baseUrl + name → URL (§8.9)
lib/viewer.ts                             FRONTEND  which renderer a file name gets, and what is a question for the server (§8.12)
lib/archive-tree.ts                       FRONTEND  an archive's member list as a folder tree (§8.13)
lib/fm-rpc.ts                             FRONTEND  typed useRpc wrapper + error parsing
lib/upload-manager.ts                     FRONTEND  token cache, XHR chunking, queue, resume, events
lib/download.ts                           FRONTEND  anchor-click download helper
lib/fm-paths.ts                           FRONTEND  subPath encode/decode, join, basename, relative<->absolute
lib/format.ts                             FRONTEND  bytes, dates, speed, ETA
lib/errors.ts                             FRONTEND  parseRpcError → { code, message }, toast text
```

### 8.1 `FileManagerPanel` behaviour

* On mount: `rpc.call("getState")`; if `subPath === ""` and
  `startFolder !== root`, `navigate.toPluginPanel("files", { subPath: relative(startFolder), replace: true })`.
* `useDirectory(currentPath)` calls `listDir` with the effective `showHidden`.
* `useRealtime("fs", …)` refetches when `payload.paths` includes the current dir.
* `useRealtime("job", …)` feeds `useJobs`; a finished extract triggers a refetch.
* Loading: skeleton rows (never a spinner-only screen). Errors: `ErrorBanner`.
* Wrap RPC failures locally — a throw inside the slot component disables the
  plugin's UI for the whole session until `bb plugin reload`.

### 8.2 Mouse interactions

| Action | Result |
| --- | --- |
| single click on a row | select only that row; set the selection anchor |
| `Ctrl/Cmd` + click | toggle that row; anchor moves to it |
| `Shift` + click | select the inclusive range from the anchor |
| click on the checkbox cell | toggle without clearing others; anchor moves |
| click on empty table space | clear selection |
| double click on a directory | navigate into it (`toPluginPanel`) |
| double click on a file | open it in bb's preview panel, or in the built-in viewer when this surface has none (§8.2.1) |
| double click on an archive | open `ExtractDialog` |
| double click on a row with `escapesRoot` | no-op + toast "Link points outside /home/coder" |

#### 8.2.1 Opening a file (v0.7, reworked in v0.8)

Double-click (and `Enter`, and the row menu's **Open**) hand the file to bb's
own preview panel through
`useBbNavigate().experimental_openFilePreview({ target: { kind: "host",
hostId, path }, location: null })`, so it opens as a tab beside the manager.
bb addresses a live file by host id, which is why `getState` carries
`primaryHostId` — `bb.sdk.system.config()` on the backend, resolved once and
remembered.

Three ways that call answers `false`: no `primaryHostId` (an older server, or
a config call that failed), no `experimental_openFilePreview` on the client's
runtime, and a host with no preview panel on this surface. A throw is caught
for the same reason a slot component never throws — it takes the plugin's
whole UI down.

**All three end in the built-in viewer (§8.12), not in a download.** That
correction is the whole of v0.8. bb wires `openFilePreview` into exactly two
surfaces — the thread split view and the right-hand plugin panel host — so the
third answer was not an edge case at all: on the sidebar's own full-page File
Manager, *every* file answered `false`, and every double-click quietly put a
copy in ~/Downloads instead of showing anything. Downloading stays where it was
always explicit: the row menu, and a button inside the viewer.

An archive still opens `ExtractDialog`: extracting it is what the gesture is
for. Looking inside one is quick look's job since v0.9 (§8.13) — `Space` — so
the double-click keeps the meaning it has always had. A socket, fifo or device node still downloads — there is no
content to render, and the bytes are the only thing that can be handed over.
| right click on a row | `RowContextMenu`; if the row is not selected, select it first |
| right click on empty space | `BackgroundContextMenu` |
| click on a breadcrumb | navigate to that ancestor |
| column header click | toggle sort field / direction (persisted via `savePreferences`) |

### 8.3 Keyboard map (bound on the panel root, `tabIndex={0}`)

| Key | Action |
| --- | --- |
| `↑` / `↓` | move focus; with `Shift` extend the selection |
| `Home` / `End` | first / last row |
| `Enter` | open (directory) or download (file) |
| `Space` | quick look: open the focused file in bb's preview panel (§8.9) |
| `Backspace`, `Alt+←` | go to parent |
| `F2` | rename (single selection only) |
| `Alt+Enter` | properties of the selection, or of the current folder (§8.10) |
| `Delete` | delete selection (confirmation when `confirmOnDelete`) |
| `Ctrl/Cmd+A` | select all visible rows |
| `Ctrl/Cmd+X` / `+C` / `+V` | cut / copy / paste |
| `Ctrl/Cmd+F` | focus the search box |
| `Ctrl/Cmd+Shift+N` | new folder |
| `Ctrl/Cmd+Shift+.` | toggle hidden files |
| `Escape` | clear search box if focused, else clear selection, else close dialog |
| `F5` / `Ctrl/Cmd+R` | **not bound** (leave browser reload alone) |

Never call `preventDefault()` on keys you do not handle, and skip the whole map
when the event target is an `input`, `textarea` or `[contenteditable]`.

### 8.4 Drag & drop

**External (OS → panel), the multi-GB path**

* Listen for `dragenter`/`dragover`/`dragleave`/`drop` on the panel root.
* Treat as external when `event.dataTransfer.types.includes("Files")`.
* `dragover` must `preventDefault()` and set `dropEffect = "copy"`, otherwise
  the browser navigates away and the panel is lost.
* Drop target resolution: a hovered directory row / breadcrumb, else the current
  directory. Highlight the resolved target only.
* Enumerate with `dataTransfer.items` + `webkitGetAsEntry()` when available so
  that *folders* are supported (recursive walk producing
  `{ file, relativeDir }`); fall back to `dataTransfer.files` (flat) otherwise.
  If `webkitGetAsEntry` is unavailable, show a toast: "Folder upload is not
  supported in this browser — drop individual files."
* Each file goes into `uploadManager.enqueue({ file, dirPath, relativeDir })`.

**Internal (row → folder)**

* Rows are `draggable`. `dragstart`:
  `dataTransfer.effectAllowed = "move"`,
  `setData("application/x-bb-file-manager", JSON.stringify(selectedPaths))`,
  plus a `text/plain` fallback of newline-joined paths. If the dragged row is
  not in the current selection, select it first.
* Valid targets: directory rows, the `..` row, breadcrumb segments.
  Invalid targets (self, a descendant, a row with `escapesRoot`) must not
  highlight and must reject the drop.
* `drop` → `rpc.call("moveEntries", { paths, destinationDir, conflict: "fail" })`;
  on `exists` failures show a "Replace / Keep both / Skip" dialog and re-issue
  with `overwrite` or `rename`.
* Optimistic UI: remove the moved rows immediately, restore on failure.

### 8.5 Cut / copy / paste

`useClipboard` holds `{ mode: "cut" | "copy", paths: string[] } | null`.
Cut rows render at `opacity-50`. Paste calls `moveEntries` (cut, then clears the
clipboard) or `copyEntries` (copy, clipboard kept). Pasting into a directory that
is inside a cut source is rejected client-side and server-side.

### 8.6 `FolderPickerDialog`

There is **no native folder picker**: `pickHostFolder` throws
`unsupported_platform` off macOS and the frontend SDK does not expose
`sdk.hosts` at all. The dialog is a small tree/list browser built on
`listDir` (`showHidden` follows the current toggle) with a breadcrumb and an
"Choose this folder" button. Used for: "Set as start folder", "Move to…",
"Extract to…".

### 8.7 Upload manager (`lib/upload-manager.ts`)

Framework-free class with an event emitter so it survives re-renders:

```
enqueue(items: { file: File; dirPath: string; relativeDir: string }[]): void
cancel(id: string): void
retry(id: string): void
subscribe(listener: (state: UploadState[]) => void): () => void
```

`UploadState = { id, fileName, dirPath, relativeDir, sizeBytes, sentBytes,
status: "queued"|"uploading"|"finishing"|"done"|"error"|"canceled",
bytesPerSecond, etaMs, errorMessage }`.

Use **XMLHttpRequest**, not `fetch`: `fetch` with a `Blob` body reports no
upload progress. `xhr.upload.onprogress` gives byte-accurate progress.
Wire `AbortSignal` → `xhr.abort()`. Persist nothing to `localStorage` in v0.1;
resume-after-reload works because `uploadCreate` matches the session key.

### 8.8 Mentions and the composer (v0.7)

bb's own attachment picker uploads from the machine the **browser** runs on.
This plugin owns the other machine — the one bb itself runs on — so a file
under the hard root reaches an agent as an **@-mention**, not as an upload.

**The provider (`src/mentions.ts`, host-rendered, no frontend involved).**

```ts
bb.ui.registerMentionProvider({ id: MENTION_PROVIDER_ID, label: MENTION_PROVIDER_LABEL, search, resolve });
```

`MENTION_PROVIDER_ID` (`"file"`) and `MENTION_PROVIDER_LABEL` (`"Files"`) live
in contract.ts because both halves address the provider by name: a pill the
panel inserts with a different string renders fine and then resolves to nothing
at send time. `triggers` is omitted — `@` is the default, and claiming `#` or
`~` too would put these rows in menus they have no business in.

- **`search({ query })`** reuses `searchDir` from the root: depth 4, hidden
  files excluded, directories and root-escaping links dropped, at most 20 rows
  of `{ id: <absolute path>, title: <name>, subtitle: "~/relative/path" }`. An
  empty query returns nothing rather than walking the home folder to answer
  "everything". bb time-boxes the handler at **2s** and treats failure as an
  empty list, so nothing throws — and `searchDir` grew two optional inputs for
  this caller: `limit` (stop after N matches) and `budgetMs` (a wall clock, so
  an answer the host has already dropped stops costing the disk).
- **`resolve(itemId)`** runs once per picked item **at send time**, and a throw
  **blocks the send**. So every failure comes back as prose inside `context`
  instead. The id round-trips through the draft, so it is re-clamped with
  `resolveExisting` (§6) like any other input. The block is
  `File: / Size: / Modified:` plus, for text, the content in a fence longer
  than any backtick run inside it. Beyond `MAX_CONTEXT_BYTES` (256 KB) only the
  head is read and a `[Truncated: …]` line says so; a binary file (NUL in the
  first 8 KB, or a decode too lossy to be text), a directory and an empty file
  get the metadata and one sentence saying why there is no content.

**Entry 1 — the row menu.** `RowContextMenu` gains *Add to chat* beside
*Download*, enabled on the same set (real files, no folders, nothing that
escapes the root) and inserting one pill per selected file through
`useComposer().insertMention`. Which draft that reaches is the host's call:
a panel tab beside a thread writes into that thread's composer, the sidebar
page seeds the next new thread's.

**Entry 2 — the `+` menu.** `app.composer.customize` registers one row,
*From File Manager…*, and one **banner**. The banner is the load-bearing part:
a `plusMenu` row is host-rendered, so its `run({ composer, view })` is a
callback with nowhere to mount a dialog, and of the two surfaces that do mount
components the host **drops `actions` entirely in the compact layout** — the
narrow surfaces where a file browser helps most. `banners` are mounted for
every composer and `chrome: "bare"` renders the component with no wrapper, so
an idle picker contributes no DOM. `run` therefore only publishes the composer
scope on `lib/composer-bus.ts`, and the banner mounted in **that** scope opens
`FilePickerDialog` (every composer on screen mounts one, so a thread's `+` must
not open a dialog over the side chat beside it).

The picker takes **any number of files** (v0.7.1). Rows carry a checkbox,
`Shift`-click takes the run between the last row touched and this one — always
adding, never clearing, because losing a ten-file pick to a stray modifier is
the worst outcome available — and a folder-wide toggle sits above the list. The
selection is a `Map` keyed by absolute path: it survives navigation, so files
from several folders can go out together, and its insertion order is the order
the mentions enter the draft. A double-click confirms the whole selection with
that row added rather than replacing it.

`FilePickerDialog` is a sibling of `FolderPickerDialog`, not a mode inside it:
the folder picker's confirm returns the folder you are standing in and it has
no selection, while this one needs file rows, a selection that survives a
navigation, and a confirm that is disabled until something is picked. It takes
the root as a **prop** — it opens from the composer, where the panel may never
have mounted and so may never have published the backend's root — and asks
`getState` for it on first open, which is also where its start folder comes
from.

### 8.9 Gallery and quick look (v0.7)

Two answers to one question — *what is actually in this file?* — that the panel
could not give before: a grid that shows the images instead of naming them, and
a keystroke that opens the focused row in bb's preview panel.

**Quick look — `Space`.** Bound in `handleKeyDown` below the `isTypingTarget`
guard, so typing a space in the filter or in the path bar is untouched. It runs
exactly the path a double-click runs — `showEntry`, i.e. bb's preview panel
where there is one and the built-in viewer where there is not (§8.2.1, §8.12)
— and differs from `Enter` in two ways, each deliberate:

| Case | `Enter` | `Space` |
| --- | --- | --- |
| directory | navigates into it | nothing (there is nothing to read) |
| archive | opens `ExtractDialog` | shows its contents (§8.13) |
| file, no preview panel on this surface | built-in viewer | built-in viewer |

The third row was the difference that mattered until v0.8, and it read
"downloads / nothing": a peek that silently puts a file in the downloads folder
is not a peek, so Space did nothing at all rather than that. Now both do the
same right thing and the rule survives only as "quick look never downloads".
`preventDefault()` is called
whenever a row holds the cursor — including for a folder — because the
alternative is Space paging the listing out from under that row; with no row
focused Space is left to the browser, per §8.3's rule about unhandled keys.
One more guard has no equivalent anywhere else in the map: `isActivationTarget`
skips the binding when the event target is a button, a link or a checkbox,
because Space is *their* activation key and the panel root sees their events on
the way up.

**Gallery — `viewMode`.** A second surface for the same folder,
`components/FileGallery.tsx`, rendered instead of `FileTable` inside the same
scroll container and the same `ContextMenuTrigger`. Every handler is the
panel's existing one: `handleRowClick`, `handleRowContextMenu`, `openEntry`,
`handleRowDragStart` / `DragOver` / `DragLeave`, `handleToggleSelect`. Nothing
about selection, the clipboard or drag & drop is reimplemented, which is what
keeps the two views from drifting.

What it deliberately does not have:

* **no tree.** Expanding a folder in place is a list affordance; a grid has
  nowhere to indent into. The gallery renders `directory.entries` for the
  current folder only, filtered by the same query. `useTree` keeps running so
  the list comes back with its expanded folders and cached child listings
  intact, and the "first N rows" banner is hidden while the gallery is up —
  it describes rows nobody can see.
* **no sort headers.** There are no columns; the toolbar's sort menu is the
  affordance in this view.
* **no `..` row inside the grid.** `..` is a navigation, not a selectable
  entry, so it renders above the listbox — a button among `role="option"`
  children is neither valid ARIA nor reachable by the selection keys. It is
  still a drop target.

ARIA mirrors the table's treegrid one level down: the grid is
`role="listbox" aria-multiselectable tabIndex={0}` with `aria-activedescendant`
pointing at the focused tile, and tiles are `role="option"` with
`aria-selected`. `ArrowLeft` / `ArrowRight` move to the previous and next tile
— the tree meanings they carry in the list have nothing to act on here.

**Thumbnails.** `createPreviewUrl` (RPC, `src/preview.ts`) clamps a folder with
`resolveExistingDir` and hands it to `bb.sdk.files.createPreview({ rootPath,
ttlMs: PREVIEW_TTL_MS })`; the panel appends each entry's name to the returned
`baseUrl`, one URL-encoded segment at a time (`lib/preview.ts#previewUrl`).

Three rules behind that shape:

* **One call per folder, not per file.** The URL is folder-rooted, so a file
  that appears while the gallery is open is already covered and an `fs` signal
  costs no round trip.
* **Bytes never travel over RPC.** A folder of photos is hundreds of megabytes;
  reading it into JS to build data-URLs would hold all of it in the page. The
  download route is not an option either — it is `octet-stream` +
  `Content-Disposition` on purpose, which is the opposite of an `<img src>`.
* **Failure is decoration failing.** A server with no preview transport rejects
  with `unsupported`; `hooks/usePreviewBase.ts` swallows it, and every tile
  shows its type icon. No toast: it is not the user's mistake, and it would
  fire once per folder. A broken image (`onError`) falls back to the same icon,
  remembered per `src` so a renewed URL gets its own attempt.

`usePreviewBase` renews the URL 30 s before `expiresAtMs` while the gallery is
open, and answers `null` for any folder but the one it was minted for — between
a navigation and the next answer the previous folder's URL is still in state,
and hanging a tile off it would request the wrong file.

The chosen view is a preference like any other: `viewMode` in
`preferencesSchema`, a `select` descriptor in `src/settings.ts`, written back
through `savePreferences`. It rides in `getState` rather than `useSettings()`
for `restoreLastFolder`'s reason — the panel must know which surface to paint
in the tick it learns the root, not one render later.

The switch lives in the toolbar in the wide chrome (one icon button, icon and
label both naming the destination) and in the overflow menu in the compact one
(`components/PanelActions.tsx`), because ~450px already carries the path bar,
the filter and three buttons, and a sixth control there costs the path bar more
width than a view switch is worth.

---

### 8.10 Properties

`components/dialogs/PropertiesDialog.tsx`, reached three ways: **Properties**
in the row menu, **Properties** in the empty-space menu (which describes the
folder on screen — there is no row to talk about), and `Alt+Enter`, which takes
the selection when there is one and the current folder when there is not.
`Alt+Enter` is read above the plain-`Enter` case of the keyboard map, because
that case opens the focused row and does not look at `altKey`.

**One target** is described by `pathProperties`: name, absolute path, parent,
kind, size, modified / created / accessed times, mode in both forms
(`-rw-r--r--` and `0644`), owner, link count, content type, and for a symlink
its raw target plus where it resolves.

Three rules the backend keeps:

* **The final component is never followed.** A symlink describes *itself* — its
  own mode, its own size (the length of the target string), its own times —
  and reports the target separately. `resolveLink` does the clamping, exactly
  as `statPath` does; the hard root is the one path it refuses, so that case is
  handled explicitly (§6 rule 5).
* **A link out of the root is named, not resolved.** `linkTarget` carries the
  raw text so the dialog can show where it claims to point, while
  `linkTargetPath` stays null and `escapesRoot` is true — the panel is never
  handed a path it is not allowed to open (§6 rule 3).
* **Only the process's own user is named.** Node exposes no `getpwuid`, and
  parsing `/etc/passwd` would leave the hard root and answer wrongly wherever
  users come from LDAP or SSSD. Every other owner — and every group — is a
  number, the way `ls -n` prints it.

**A folder's real size** is the one expensive question, so it stays behind a
**Calculate size** button and its own method, `directorySize`. The walk is
bounded on three axes (`src/properties.ts`): depth 32, 200 000 entries, and a
5 s wall clock. Depth only prunes the branch it hit; the other two abandon the
walk. Any of them makes the answer `partial: true` with a `stoppedBy`, and the
dialog renders that as "over 5 MB" plus a note — a lower bound, never a total.

Symlinks are not followed (a link to an ancestor would loop forever) and the
staging directory is skipped (§6 rule 4); hidden entries *are* counted, because
a folder's size includes its dot-files.

bb's RPC has no abort channel, so a dialog closed mid-walk cannot call the walk
off. It retires the ticket the answer would land on — every reply carries the
ticket it was asked under — and the 5 s budget bounds what is left running.

**Several rows** get a summary instead, computed from the listing rows the
panel already holds: how many files, how many folders, and the total of the
files whose size is known. Folders have no size in a listing and a symlink's
`sizeBytes` is the length of its target string rather than of the file, so
neither is added up and the dialog says so.
### 8.11 Bookmarks

One `startFolder` is one folder; people work in several. A bookmark is a
`{ path, name }` pair — an absolute folder plus the label the menu shows.

**Storage.** One `bb.storage.kv` row, `bookmarks:v1`, holding the array in
order (`src/bookmarks.ts`). It is server-side on purpose, unlike the
last-folder memory of PATHBAR-SPEC §1: that is one browser profile's memory of
a moment, this is a decision about this machine's folders and belongs to the
machine. It is not a setting because §7.1 has four descriptor types and none of
them is "list of records" — encoding JSON into the `string` type would put a
blob on the settings form and turn every add into a read-modify-write through
`sdk.plugins.updateSettings`. The version is in the key, so a shape change is a
new key and never a migration.

**Limits.** `MAX_BOOKMARKS = 50` and `MAX_BOOKMARK_NAME_LENGTH = 80`
(contract.ts). The first exists because kv caps a value at 256 KB and
50 × (PATH_MAX + a short name) fits with room to spare; the second because a
label has to fit a menu row. The name is counted in **code points**, not bytes:
it never becomes a file name, so §6's 255-byte rule does not apply and a byte
budget would only punish non-Latin labels.

**Path safety.** Two strengths, both from `src/root.ts`:

| Operation | Clamp | Why |
| --- | --- | --- |
| `addBookmark` | `resolveExistingDir` — realpath, *then* the prefix test | the stored form must be one that cannot escape later, exactly like `validateStartFolder` |
| `listBookmarks` | `normalize` + `isInside` per row | a folder that is gone has no realpath; a row outside the root is dropped, not shown |
| `removeBookmark`, `renameBookmark` | `normalize` + `assertInside` | a dead bookmark must still be removable, and the value is only compared against stored strings — it never reaches `node:fs` |

**Availability.** `listBookmarks` probes each row with `resolveExistingDir` and
reports `available`. A missing folder is **marked, not dropped**: an unmounted
share comes back and a list that deletes itself does not. A row whose path is
outside the root *is* dropped — "unavailable" would invite the user to wait for
something that can never open here.

**Contract.** `listBookmarks`, `addBookmark`, `removeBookmark`,
`renameBookmark`, appended after `savePreferences`. Every mutator answers with
the **whole list**, so the panel replaces its state wholesale and has no
reconciliation of its own to get wrong. `addBookmark` on a folder already
bookmarked is a no-op (the star is a toggle, so a repeat is a double click),
except that an explicit `name` still lands. The 51st is refused with
`unsupported`; the panel refuses it first, with a sentence that says what to do
(`lib/bookmarks.ts#BOOKMARKS_FULL_TEXT`).

There is **no `reorderBookmarks`**. The list is insertion-ordered, and its only
surface is a menu — not a drag surface. An RPC on a frozen contract that no
affordance can reach is weight with no user behind it; reordering waits for a
manage-bookmarks screen that would need it.

**Frontend.** `hooks/useBookmarks.ts` holds the list and stamps every call at
issue time, so a background re-read cannot land after a removal and undo it.
`components/BookmarksMenu.tsx` renders the items and re-reads on every
appearance (`available` describes *now*, and the content of a menu is mounted
only while it is open).

Placement, per chrome:

| Control | Wide (nav panel) | Compact (panel tab, ~450px) |
| --- | --- | --- |
| star toggle | toolbar | toolbar — it *is* the state, and an overflow item cannot show state without being opened |
| the list | its own dropdown in the toolbar | the panel-tab overflow menu (`components/PanelActions.tsx`), at the top, above Refresh |

A *missing* row removes itself when selected instead of carrying a nested
delete button: `DropdownMenuItem` renders as a `<button>` on compact
viewports, and a button inside it would be invalid markup for an affordance
nobody sees until they hover it. Navigation always goes through the panel's
existing `navigateTo`, so the route rules of §10.1 hold unchanged.

The two context menus of §8.2 carry the same toggle for the folder they were
opened on — the row menu only for a single, non-escaping directory, because a
bookmark is a place to go and a file is not one.

---

### 8.12 The built-in viewer (v0.8)

`components/dialogs/FileViewerDialog.tsx` — what shows a file when this surface
has no bb preview panel to delegate to.

**Why it exists.** §8.2.1 delegated to `experimental_openFilePreview` and, on a
`false`, downloaded. bb provides that capability from exactly two places — the
thread split view and the right-hand plugin panel host — and from a default of
`() => false` everywhere else. The sidebar's own full-page File Manager is one
of the "everywhere else", so on the surface the panel is most used from, *no*
file ever opened: every double-click and every row-menu Open put a copy in
~/Downloads and showed nothing. That is the bug v0.8 fixes, and no amount of
correcting the call site would have: the surface has no preview panel to open
into, so the panel has to be one.

bb's panel still wins wherever it exists (`showEntry` asks it first). It sits
*beside* the manager and survives navigation, which a modal cannot.

**Two transports, split by what the renderer needs** — and since v0.9 a third
for archives, whose table of contents is what is worth showing (§8.13).

| Kind | Source | Rendered with |
| --- | --- | --- |
| image (`lib/preview.ts#isImageName`) | `createPreviewUrl` + the file name | `<img>` |
| `pdf` | same | `<iframe>` |
| video (`mp4 m4v webm ogv mov`) | same | `<video controls>` |
| audio (`mp3 wav ogg oga m4a aac flac opus weba`) | same | `<audio controls>` |
| `md` / `markdown` / `mdx` | `readTextFile` | bb's `Markdown`, with a **Source** toggle |
| an archive (`entry.archiveFormat`, v0.9) | `listArchive` | the contents tree of §8.13 |
| everything else | `readTextFile` | bb's `experimental_SourceCode` |

The URL half is the gallery's transport (§8.9) reused unchanged — folder-rooted,
one mint per folder, bytes that never enter JS. The string half is new, and it
is the only thing in this plugin that reads file content over RPC: a renderer
needs the text *as a string*, and the download route is
`application/octet-stream` + `Content-Disposition` on purpose.

**"Is this text?" is answered from the bytes, never from the name**
(`src/preview.ts#readTextFile`). `lib/viewer.ts` decides only the four
browser-painted kinds from the extension, because getting *those* wrong costs a
request for bytes nothing can display; every other name — including `tool.bin`
and `bundle.zip` — falls to `text`, which is a **question for the server**, not
a claim. That is the only way `Makefile`, `LICENSE`, `.gitignore` and the
extension nobody has heard of yet ever open, and it is why the codec lists above
are short: `mkv`, `avi` and `wmv` are named on disk and unplayable in a
`<video>`, so they take the text branch and end in the honest download offer
rather than in a black rectangle.

The server's rules, in order: `resolveExisting` (§6, unchanged), must be a
regular file, read at most `MAX_TEXT_PREVIEW_BYTES` (1 MiB) from offset 0, and
then two tests — a NUL byte anywhere in the window, and `TextDecoder("utf-8",
{ fatal: true })`. Either failure throws `unsupported`, which the viewer renders
as "No preview for this kind of file" plus the download, and which is
deliberately distinct from a real `permission_denied` or `io_error`. A cap that
lands mid-character is not a binary file: a truncated window retries the decode
up to three bytes earlier, an untruncated one gets exactly one attempt.

**Reach.** Double-click, `Enter`, `Space` (§8.9) and the row menu's **Open**,
all through the panel's single `openEntry` / `showEntry` pair — the menu does
not get a second opinion about what "open" means. `Open` on a row was
directory-only before v0.8; it now covers any single non-escaping file, which
is what made the action visible at all.

### 8.13 Looking inside an archive (v0.9)

`listArchive` (RPC), `src/archive-listing.ts` (the bounded listers),
`src/archive-parse.ts` (the pure parsers), `components/ArchiveContents.tsx`
(the view), `lib/archive-tree.ts` (the tree model).

**Why.** Before v0.9 an archive had exactly one answer in this plugin:
extract it. Quick look on a `.zip` ended in "No preview for this kind of
file", and a `.zip` link in a chat message opened bb's own preview, which has
nothing to show for one. Deciding whether to extract — and where to — needs
the contents first.

**Where it shows.**

| Surface | Reached by | Extract… |
| --- | --- | --- |
| built-in viewer (§8.12) | `Space` (quick look) on an archive row | swaps the viewer for the panel's `ExtractDialog` (`setDialog`) |
| "Preview + location" opener (§10.2) | a plain click on an archive link in a message | switches the tab to the reveal with `extractOnReveal`: the file manager opens on the archive's folder, selects it, and opens `ExtractDialog` on it |

Double-click, `Enter` and **Open** still open `ExtractDialog` (§8.2.1). On a
surface with bb's preview panel, `Space` hands the archive to that panel as it
hands any file (§8.2.1); bb then opens it with the first matching file opener,
which is this plugin's "Preview + location" — the same tree. There is no
second extraction path anywhere: both surfaces end in the existing dialog, job
and tray, and "Extract…" is only offered when the listing says `extractable`
(the same plan probe `extractArchive` runs before promising a job).

**The contract.** `listArchive({ path })` → `archiveListingSchema`: the
realpath'ed archive and its format, the archive's size, the first
`MAX_ARCHIVE_ENTRIES` (10 000) members in archive order, and totals over every
member the scan saw — `totalEntries`, `fileCount`, `directoryCount` (implied
folders included: most zips never list their folders), `uncompressedBytes`,
`encryptedCount`. `truncated` says the list is shorter than the archive;
`partial` + `stoppedBy` (`entries` / `time` / `output` / `damaged`) say the
counts themselves are lower bounds, and `problem` carries the reader's own
complaint for `damaged`. A member is `{ path, kind, sizeBytes, modifiedAtMs,
encrypted, linkTarget }`, `kind` one of `file`, `directory`, `symlink`,
`hardlink`, `other`.

**Readers — one per family, chosen for what each is best at.**

| Format | Reader | Why |
| --- | --- | --- |
| `zip` | [yauzl](https://github.com/thejoshwolfe/yauzl) 3.x, in-process, `decodeStrings: false` | the only way to get member names as raw bytes (below). Reads the central directory through a 256 KiB window (two tiny reads per member otherwise: 25 000 members went from 1.5 s to 0.3 s) shifted past any prefix, so a self-extracting zip reads too. Needs no tool on the host. |
| `tar`, `tar.gz`, `tar.bz2`, `tar.xz` | GNU `tar --list --verbose --full-time --numeric-owner --quoting-style=c --force-local --file <archive>`, `LC_ALL=C`, `TZ=UTC`, `TAR_OPTIONS` unset | tar already decompresses all three; C quoting puts every name in double quotes with C escapes, so spaces, newlines, quotes, `" -> "` inside a name and stray bytes never break a column. |
| `7z`, `rar` | `7z l -slt -sccUTF-8 -bd -p<dummy> -- <archive>` | one `Key = Value` block per member. The dummy password makes an archive with an encrypted *file list* fail at once ("its list of files is encrypted") instead of prompting. |

A zip yauzl cannot read at all (a truncated file, a malformed directory) goes
to 7z when it is installed — 7z salvages what the local headers still say.
Names from that fallback are 7z's decoding, not ours.

**Names.** A zip member name is decoded from its raw bytes:

1. an Info-ZIP Unicode Path extra field (0x7075) whose CRC matches the raw
   name — the writer's own statement of the name;
2. the UTF-8 flag (bit 11) — UTF-8, lossily if the bytes disagree;
3. otherwise valid UTF-8 is UTF-8, and anything else is **CP866**, the DOS
   code page Windows Explorer writes on a Russian system. Real Russian text in
   CP866 almost never passes as UTF-8 (capitals and `а`–`п` are UTF-8
   continuation bytes), so the order is safe. The table is built in, not
   `TextDecoder("ibm866")`, so it does not depend on the Node build's ICU.

Backslashes become slashes (.NET's `ZipFile` wrote them for years). tar names
come back byte-exact from the C escapes and go through step 3; 7z prints
UTF-8 itself. Measured on this host: `unzip -Z` happens to decode CP866 here
(a distro patch plus a guess), `7z l` turns the same names into U+FFFD even
with `-mcp=866` — which is why zip is not read through either.

**Display, never action.** A member path is `/`-split for the tree with empty
and `.` segments dropped, `..` kept as a folder literally named `..`, and a
leading `/` kept as a folder named `/` (`memberSegments` on the server,
`archiveSegments` in the page — the same rules, so the folder count and the
tree agree). Control characters render as their Unicode pictures (`␊`), so a
newline in a name is visible rather than collapsed.

**Bounds.** The RPC waits and bb cannot cancel a request, so:

| Bound | Default | On hit |
| --- | --- | --- |
| members returned | 10 000 (`MAX_ARCHIVE_ENTRIES`) | the rest are counted, `truncated` |
| members counted | 1 000 000 | stop, `partial`, `stoppedBy: "entries"` |
| distinct folders remembered | 100 000 | the same — this set is the only thing that grows with a hostile archive |
| wall clock | 10 s | stop, `stoppedBy: "time"` |
| tool output | 256 MiB, one line ≤ 64 KiB | stop, `stoppedBy: "output"`; an overlong line is dropped whole |

Output is parsed a line at a time as it arrives and never held whole. A tool
that has to stop is killed like an extraction's: SIGTERM, then SIGKILL after
3 s, and to its whole process group (it is spawned `detached`), so the `xz`
GNU tar runs underneath dies with it. A plugin dispose kills every running
lister and fails its request. A non-zero exit after some members is
`damaged` — a cut-short download still shows what it holds; with none it is
`archive_failed` carrying the tool's first stderr lines (or 7z's `ERRORS:`
list, which it prints on stdout).

**Path safety** is §6 unchanged: `resolveExisting` (realpath, then the prefix
test), a regular file or `not_a_file`, the format from the realpath'ed name or
`unsupported_archive`. A missing tool is `unsupported_archive` with the reason
("7z is not installed on this host"); every other failure maps through
`mapNodeError`. Listing writes nothing: yauzl reads a file handle, and the
tools run in list mode with stdin closed, their argument after `--file` / `--`.

**RAR.** Every 7z *lists* a RAR — headers need no decoder — but Debian's
`7zip` has no RAR codec, so it cannot *extract* one (`7zip-rar` adds it).
`probeRarCodec` reads `7z i` once at load; `archiveSupport.rar` and
`extractable` follow it, `planFor` refuses `rar` without it, and the viewer
shows a RAR's contents with no Extract… on such a host.

**The view.** A summary line — files, folders, uncompressed size, archive
size, encrypted count — then a note when the list or the counts are not the
whole archive, then the tree: folders first, name order as in the panel
(numeric, case-blind), a chevron per folder, the chain of lone top-level
folders open on arrival (most archives wrap everything in one folder). Per
row: name, uncompressed size, modified time (`—` when the format recorded
none, including a zip's zero DOS date), a lock for an encrypted member, `→
target` for a symlink, `hard link to …` for a tar hard link. The tree is a
WAI-ARIA `tree` with `aria-activedescendant` (↑/↓, →/←, Home/End,
Enter/Space) and the rendered rows are capped at `MAX_TREE_ROWS`, like the
panel's own tree. States: loading, error ("Could not read this archive", or
"Can't look inside this archive here" for `unsupported_archive`), empty.

## 9. Visual & theming rules

The Tailwind pass emits **default-theme utilities only**, wrapped in
`@scope ([data-bb-plugin="file-manager"], [data-bb-plugin-root]:not([data-bb-plugin]))`.
Custom `@theme` colors, hand-written `oklch(...)` and hard-coded greys are
forbidden — they will not follow the user's palette.

**Allowed semantic classes** (bridged host tokens):

| Purpose | Class |
| --- | --- |
| panel surface | `bg-background text-foreground` |
| secondary text | `text-muted-foreground` |
| hairlines / dividers | `border-border`, `border-border-hairline` |
| row hover | `hover:bg-state-hover` |
| row selected | `bg-surface-selected` (+ `border-surface-selected-border`) |
| row active/pressed | `bg-state-active` |
| menus & dialogs | `bg-popover text-popover-foreground` |
| dialog card | `bg-card text-card-foreground` |
| primary button | `bg-primary text-primary-foreground` |
| secondary chip | `bg-secondary text-secondary-foreground` |
| destructive text/menu item | `text-destructive focus:bg-destructive/15 focus:text-destructive` |
| destructive surface | `bg-surface-destructive border-surface-destructive-border` |
| warning banner | `bg-surface-attention text-warning-text` |
| success | `text-success` |
| recessed panels (tray) | `bg-surface-recessed`, `bg-surface-raised` |
| drop-target ring | `ring-2 ring-primary/50` and a `before:bg-primary` insert line |
| focus ring | `focus-visible:ring-2 focus-visible:ring-ring` |
| numbers (size, %, ETA) | `tabular-nums` |
| radii | `rounded-md`, `rounded-lg` (`--radius-*` tokens) |

**Layout skeleton (normative):**

```tsx
<div className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
  <Toolbar className="flex items-center gap-2 border-b border-border px-3 py-2" />
  <div className="min-h-0 flex-1 overflow-auto">
    <FileTable />
  </div>
  <ActivityTray className="pointer-events-none absolute bottom-3 right-3 w-80" />
</div>
```

Density: rows `h-9`, text `text-sm`, secondary columns `text-xs
text-muted-foreground`, icons `size-4`. Use `@container` queries (the panel can
be narrow) and hide the `size`/`modified` columns below `@md`.

**Portals:** every `Dialog`, `DropdownMenu`, `ContextMenu`, `Tooltip` must carry
`usePortalScopeProps()` on its portalled content. The vendored `@bb/*`
components already do this; if you hand-roll Radix, spread it yourself —
otherwise the plugin stylesheet cannot reach the portal (it is `@scope`d) and
Electron may route clicks into the window drag region.

**Toasts:** `import { toast } from "sonner"` (host-shimmed). Never mount your
own `<Toaster>`.

**Icons:** only names from the vendored `ICON_MAP` (`components/ui/icon.tsx`).
Verified-present names to use here: `FolderOpen`, `Folder`, `FolderPlus`,
`File`, `FileText`, `Download`, `Copy`, `Edit`, `Trash2`, `Search`, `Sort`,
`ArrowUpDown`, `Archive`, `ArchiveRestore`, `Eye`, `EyeOff`, `MoreHorizontal`,
`Loading`, `Spinner`, `X`, `Check`, `AlertTriangle`, `PackageReceive`,
`ListView`, `GridView`, `Rows2`, `Rows3`, `Container`, `Layers`, `ExternalLink`,
`Paperclip`, `DragDropVertical`.
**Do not use** `Files`, `HardDrive`, `Upload`, `Columns3` — they do not exist and
silently degrade to `Zap`.

---

## 10. Nav panel registration (verbatim)

`app.tsx`, bottom of file. `icon: "FolderOpen"` is confirmed present in bb
0.39.0's `ICON_MAP` (`Folder02Icon`) and in the shipped app bundle.
`bb.branding.icon` in `package.json` **overrides** this on compact surfaces, so
both must say `FolderOpen` (§2).

```tsx
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "file-manager",
    title: "File Manager",
    icon: "FolderOpen",
    path: PANEL_PATH, // "files" → /plugins/file-manager/files/*
    component: FileManagerPanel,
    headerContent: HeaderActions,
    experimental_sidebarAccessory: SidebarAccessory,
  });
});
```

`id` and `path` must match `/^[a-zA-Z0-9_-]+$/` or the whole frontend fails to
register. Do not add `fixedTabs` (`experimental_fixedTabs` before SDK 0.4.16): only the active fixed tab
is mounted and closing the panel unmounts it, which would strand tree state.

### 10.1 Panel-tab registration (v0.5)

The same file manager also opens as a tab in bb's right-hand panel, from
"New tab" → Actions (beside Start terminal and Start side chat). Two
registrations, because bb keeps the two launchers apart:

```tsx
app.slots.threadPanelAction({
  id: "file-manager",
  title: "File Manager",
  icon: "FolderOpen",
  layout: "flush",
  component: FileManagerTab,
});
app.slots.experimental_newThreadPanelAction({ /* the same, on New thread */ });
```

`layout: "flush"` because the body owns its own scrolling and needs a definite
height for the listing; `run` is omitted because nothing has to be resolved
before the tab opens. Neither `threadId` nor `projectId` is read: the root is
the home folder of whoever runs bb, not a thread or a project.

One body serves both surfaces. `FileManagerSurface` takes two props instead of
reading the route itself:

- `location: FmLocation` (`hooks/useFmLocation.ts`) — `{ subPath, navigate }`.
  The nav panel's flavour writes the route (`toPluginPanel`), so back/forward
  still walks the folder history; the panel tab's flavour is component state,
  because a panel tab has no route and navigating with `toPluginPanel` would
  take the whole app to the plugin page and the thread off screen.
- `chrome: "host-header" | "inline"` — which chrome the surface wears. Only
  `"host-header"` is on `components/panel-bus.ts`: a tab that published would
  leave the title bar describing the wrong folder, and a tab that subscribed
  would run every header click twice.

A panel is ~450px wide, so `"inline"` also switches the toolbar to its compact
variant: upload / new folder / an overflow menu (`components/PanelActions.tsx`)
at the trailing edge, sort / hidden files / collapse-all / refresh folded into
that menu, and the filter folded into a magnifier so the path bar keeps a
readable width. `Ctrl`/`Cmd`+`F` unfolds it; closing it clears the filter, so
rows can never stay hidden behind a control that is off screen.

### 10.2 File openers — "show me where this file is" (v0.6)

Right-clicking a file link in a rendered message gives bb's own menu: *Open
in …*, *Open with built-in preview*, one *Open with `<title>`* row per matching
`fileOpener`, *Copy file path*, *Copy file name*. The chosen opener renders as
a tab in the side panel — the surface a reveal wants. So two registrations:

```tsx
app.slots.fileOpener({ id: "preview",  title: "Preview + location", extensions, component: FilePreviewOpener });
app.slots.fileOpener({ id: "location", title: "File location",      extensions, component: FileLocationOpener });
```

**Order is load-bearing.** bb matches an opener by exact extension (no
wildcards) and, absent a Settings → *File openers* pin, uses the FIRST
registration that matches for every automatic open — a plain click included.
So `preview` is registered first and renders the `Original` prop (bb's own
preview) under one 40px strip naming the folder and carrying an *Open location*
button. `location` is only ever reached from the context menu, and opens the
file manager directly.

`LOCATION_OPENER_EXTENSIONS` (contract.ts) is the claimed set: text, ebooks,
config, data, code, web, images, audio, video, archives, fonts and binaries.
Documents are deliberately excluded (v0.9): `pdf`, `doc`, `docx`, `xls`,
`xlsx`, `ppt`, `pptx`, `odt`, `ods`, `odp` and `rtf` belong to the pdf-viewer
plugin, which renders them. bb's automatic pick is the first matching opener
in plugin-id order and `file-manager` sorts before `pdf-viewer`, so claiming
any of them here would shadow the viewer with a strip over bb's `Original`,
which cannot render an office file at all. `epub`, Apple's `pages`,
`numbers` and `key`, and `csv`/`tsv` stay claimed — the viewer does not read
them. A name with no extension (`Makefile`, `LICENSE`) is unreachable: bb's own
`getFileExtension` returns null and the menu renders no opener rows at all, for
any plugin.

**An archive link is drawn, not delegated (v0.9).** bb's `Original` has
nothing to show for an archive, so when `detectArchiveFormat` (shared in
contract.ts) recognises the link's name, `FilePreviewOpener` renders the
§8.13 contents under the same strip instead. It resolves the link with
`resolveFileLocation` first — the listing needs the absolute path, and a link
can name a file that has since gone — and its **Extract…** switches to the
reveal with `extractOnReveal`, so the panel's own `ExtractDialog` opens on the
selected archive. Every other name still renders `Original` with no request
made until the strip's button is pressed.

**Resolution is a backend job.** An opener's `path` is relative to its
`source`: a worktree (`environmentId` → `environments.get().path`), a thread's
storage root (`threadId` → `threads.storagePaths()`), or absolute for a host
path. `resolveFileLocation` (`src/locate.ts`) turns that pair into
`{ dirPath, absolutePath, name, exists, isDirectory, matchHint }` under the
usual §6 clamp.

**A missing target is not an error.** Agents write globs
(`backups/*-otlozhena-2026-08-25.md`) and paths that have since moved, and the
folder is still the useful answer, so the resolver walks up to the nearest
existing directory and reports it. When the name held glob characters, its
longest literal run comes back as `matchHint` and the panel opens with that in
the filter — the file the link meant is then the only row on screen. A path
outside the root stays a refusal (`path_escape`): walking up from it would
answer with a folder nobody named.

The panel body takes four optional props for this (§10.1's surface): 
`initialPath` (the folder to open, outranking §1.5's rules), `revealPath` (the
entry to select once its folder lists, through the same machinery the path bar
uses), `extractOnReveal` (v0.9: once that entry is selected and it is an
archive, open `ExtractDialog` on it) and `initialQuery` (the filter seed, which
unfolds the compact filter).

### 10.3 Thread workspace — the folder a thread's code lives in (v0.7)

`threadPanelAction` is the one surface bb names a thread for, so it is the one
surface that can offer a jump into that thread's checkout. `FileManagerTab`
forwards its `threadId` into `FileManagerSurface` as a fourth optional prop;
every other surface (the nav panel, the New thread launcher, both file openers)
leaves it null, because the root is the home folder rather than a thread.

**Resolution is a backend job**, and it is the same chain §10.2 walks for a
workspace file link:

```
threads.get({ threadId }).environmentId
  → environments.get({ environmentId }).path
  → realpath → §6 prefix test
```

`threadWorkspace` (`src/locate.ts#resolveThreadWorkspace`, beside `locateFile`
because both questions end at one clamped absolute path) answers
`{ path, insideRoot, reason }`:

| Case | `path` | `insideRoot` | `reason` |
| --- | --- | --- | --- |
| checkout under the root | realpath'ed dir | `true` | `null` |
| thread has no environment | `null` | `false` | `no_environment` |
| no path recorded, path gone, or not a directory | `null` | `false` | `no_checkout` |
| checkout outside the root | realpath'ed dir | `false` | `outside_root` |

**None of the three "no"s is a throw.** They are ordinary states of a healthy
bb and the toolbar renders each of them differently; a rejection would flatten
all three into one toast. `path` is non-null exactly when a real directory is
there, `outside_root` included — reporting where it is beats saying nothing.
Only a thread bb itself cannot answer for rejects. The clamp is applied to the
realpath, never to the string bb handed over, so a symlink inside the root that
lands outside it comes back `outside_root` rather than passing the prefix test.

**The panel asks once, on mount** (`hooks/useThreadWorkspace.ts`), not on
click: the toolbar has to know whether to offer the jump before the user
reaches for it. A surface with no thread costs no request and no extra render —
`absent` and `loading` are derived from the prop, tagged with the thread they
belong to, because a stray commit between `getState` landing and `listDir`
starting is enough to flash the empty state at the user.

**Where the control lives** (`components/PanelActions.tsx`):

- **can be used** → its own icon button (`FolderGit`) at the head of the compact
  action cluster. A jump into the thread's code is why this tab sits beside the
  thread; burying it in the overflow to save 32px would spend the feature.
- **cannot be used** → no button, and a *disabled row* in the overflow menu
  carrying the reason in full text. A disabled `<button>` cannot explain
  itself: the vendored Tooltip is unusable (Radix tooltip is a devDependency,
  so shipping it would break a catalog install) and browsers do not reliably
  show a native `title` on a disabled control.
- **never both**, and nothing at all while the lookup is in flight.

The jump itself goes through `navigateTo`, the same call every other folder
move uses — a second navigation path would be a second set of bugs. A lookup
that *failed* keeps the button live, because "bb did not answer" is not "there
is nowhere to go": the click retries once, and only then becomes a toast.

**Opening there without the click (v0.9.1).** `openThreadWorkspace` — a
`boolean` descriptor, default `false`, carried in `getState().preferences`
beside `restoreLastFolder` and for the same reason (§7.1: the panel decides
where to open in the tick `getState` lands) — makes the *bootstrap* ask the
same question the toolbar asks, and open the answer.

The lookup is the one place the bootstrap may wait on a second round trip, and
it is spent only where it can pay off: the preference is on **and** the surface
has a `threadId`, read once through a ref like `initialPath` is, so a later
prop change cannot drag a user who has since navigated back to the checkout.
Every "no" — all three `reason`s, and a lookup that threw — leaves the folder
`null`, and the decision is the one it was before the preference existed.

`pickInitialFolder` gains `workspaceFolder: string | null` and a `"workspace"`
source, ranked **below a deep link and above the memory**: the memory is one
value shared by every surface, so letting it win would mean the first thread
you opened decides where every later thread's panel opens. The §6 prefix test
is applied there as well as at the caller — `threadWorkspace` reports an
`outside_root` checkout rather than hiding it, and redirecting to it would
strand the panel in a folder it may not list.

The toolbar button stays exactly as it is. With the preference on it opens the
folder it would have jumped to, which makes it a no-op *and* the way back after
the user has moved elsewhere; with the preference off nothing about §10.3
changes.

---

## 11. Test plan

### 11.1 Unit tests (vitest 4, `npm test`)

`vitest.config.ts` and `vitest.setup.ts` are owned by PACKAGING (§13). Backend
tests are plain node; frontend tests need `// @vitest-environment jsdom` as the
first line plus the `matchMedia` / `scrollIntoView` stubs in the setup file.

**BACKEND — `test/backend/*.test.ts`** (`createFakePluginHost` from
`@get-bb/plugin-sdk/testing`; each test builds a real temp tree with `mkdtemp`)

| File | Must cover |
| --- | --- |
| `paths.test.ts` | `resolveExisting` rejects `/etc`, `../..`, `~/..%2f`, a symlink to `/etc`, and a symlink *inside* root to `/tmp`; accepts root itself; `validateName` rejects `""`, `.`, `..`, `a/b`, `\0`, 300-byte names |
| `listing.test.ts` | size/mtime present; hidden filtering both ways; `.bb-file-manager` hidden in both modes; symlink rows get `isSymlink`, `targetKind`, `escapesRoot`; truncation flag at `MAX_LIST_ENTRIES`; `volume` present |
| `mutations.test.ts` | createFolder/rename/delete/move/copy happy paths; `exists`, `not_empty`, `destination_inside_source`, `path_escape` in `failed[]`; deleting a symlink removes the link only; `fs` signal published with the right dirs |
| `uploads.test.ts` | create→chunk→finish writes exact bytes; wrong offset → 409 with `expected`; resume after a partial chunk; duplicate `uploadCreate` resumes the same session; `conflict: "rename"` produces `name (1).ext`; abort removes both sidecar files; GC drops stale sessions |
| `http.test.ts` | **`registrations.httpRoutes` contains `{ method:"POST", path:"/upload/chunk", auth:"token" }`** (the fake host records auth but does not enforce it — this assertion is the only guard against regressing to `local`, which would 415 in production); download returns exact bytes, `content-type: application/octet-stream`, correct `content-disposition` incl. `filename*=UTF-8''` for a Cyrillic name; `Range: bytes=2-5` → 206 + `content-range`; `Range: bytes=999-` → 416; directory path → 404; escaping path → 403 |
| `archives.test.ts` | zip and tar.gz extract into a subfolder; a member named `../escaped` never lands outside root; unsupported extension → `unsupported_archive`; job transitions `running → done`; cancel kills the child process and reports `canceled`; v0.9: `hasRarCodec` reads `7z i`, `rar` is extractable only with the codec, and a `.rar` is refused up front without it |
| `archive-parse.test.ts` | §8.13, pure: CP866 table, UTF-8-then-CP866 fallback, the zip UTF-8 flag, a Unicode Path field trusted only on a matching CRC, backslashes; zip kinds from Unix and DOS attributes, zero DOS date → null, prefix length of a self-extracting zip; `readCQuoted` and `parseTarLine` on real GNU tar lines (spaces, newline, quote, backslash, Cyrillic octal escapes, `-> ` inside a name, hard links, devices, pre-1970, pax fractions, volume labels); `7z -slt` blocks (multi-line path, folders, encryption, symlinks, the `ERRORS:` list); `LineSplitter` drops an overlong line whole; `ListingCollector` counts implied folders and refuses past its caps |
| `archive-listing.test.ts` | §8.13, I/O: CP866 / UTF-8-without-flag / UTF-8-flag names from a real zip; odd names shown as written and the root left untouched; encrypted members and undated ones; a self-extracting zip; 11 500 members → 10 000 sent and all counted; the scan cap; a cut zip salvaged by 7z as `damaged`; tar.gz with a symlink, a hard link and awkward names; a `../` member; a cut tar.gz as `damaged` with tar's complaint; 7z plain, with encrypted members, with an encrypted file list; RAR through 7z with `extractable` following the codec; `path_escape` for a path or a link out of the root, `not_found`, `not_a_file`, `unsupported_archive`, a missing tool; fake children for the exact tar arguments, the clock, the output cap, the scan cap, dispose and a tool that will not start |
| `preview.test.ts` | §8.9 + §8.12: `createPreviewUrl` mints for a folder under the root and refuses `/etc`, a symlink out, a missing folder and a file; `readTextFile` returns a short file whole, opens a name with no extension, caps a long one and says `truncated`, keeps a multi-byte character split by the cap, and throws `unsupported` for a NUL byte and for non-UTF-8 — but `not_a_file` / `not_found` / `path_escape` for the failures that are not about the bytes |
| `settings.test.ts` | invalid `startFolder` falls back to root; `savePreferences` calls `sdk.plugins.updateSettings` with exactly the changed keys (`harness.inspection.sdk.callsTo(...)`) |
| `bookmarks.test.ts` | §8.11: `addBookmark` stores the realpath'ed folder and refuses `/etc`, a missing folder, a file and the 51st; `listBookmarks` marks a deleted folder `available: false` and keeps it, drops a row outside the root, dedupes and caps a corrupt row; `removeBookmark` and `renameBookmark` work on a folder that is gone and still reject an escaping path |

**FRONTEND — `test/frontend/*.test.tsx`** (`loadPluginApp(() => import("../../app"))`
— the thunk form is required, plus `renderSlot`)

| File | Must cover |
| --- | --- |
| `registration.test.tsx` | `app.navPanels[0]` matches `{ id: "file-manager", title: "File Manager", icon: "FolderOpen", path: "files" }`; `headerContent` and `experimental_sidebarAccessory` are functions |
| `panel.test.tsx` | renders rows from a stubbed `listDir`; hidden toggle re-issues `listDir` with `showHidden: true`; sorting by size reorders without an RPC; search filters client-side; `emitRealtime("fs", { paths:[cwd] })` triggers exactly one refetch; `setRealtimeConnectionState("connected")` refetches |
| `selection.test.tsx` | click / ctrl-click / shift-click / `Ctrl+A` / `Escape` produce the expected selections |
| `menus.test.tsx` | right-click on a file shows Download/Rename/Cut/Copy/Delete; Delete opens the confirm dialog when `confirmOnDelete`, calls `deleteEntries` when confirmed |
| `uploads.test.tsx` | dropping two `File`s calls `uploadCreate` twice and posts chunks in order (stub `XMLHttpRequest`); a 409 response resumes from `expected`; the tray shows percentages |
| `viewer.test.tsx` | §8.12: markdown renders through bb's `Markdown` and toggles to `experimental_SourceCode`; every other text file goes straight to the source viewer, including one with no extension; an image / PDF / video / audio hangs off the folder's preview URL with its name percent-encoded and never calls `readTextFile`; `unsupported` renders the download offer while `permission_denied` renders a failure; a host that *does* take the preview never opens the dialog at all |
| `archive-viewer.test.tsx` | §8.13 in the panel: `Space` on an archive shows its tree (never `readTextFile`); folders first by name with the lone top folder open; click and arrow keys open and close folders; the summary line, the lock and the link target; the truncated, damaged, timed-out, empty, failed and unsupported states; Extract… swaps the viewer for `ExtractDialog` and starts `extractArchive`, and is absent when not `extractable`; a double click still extracts; a previewing host still gets the archive |
| `archive-tree.test.ts` | §8.13, pure: implied folders, folders first, numeric case-blind order, an explicit folder merged into its implied one, duplicate files kept, `..` and `/` shown as folders, the lone-folder chain opened, the row cap, control characters made visible |
| `openers.test.tsx` | §10.2: registration order and titles; the claimed set, with `pdf` and every office format left to the pdf-viewer; the reveal, glob pre-filter and refusal; bb's preview in a scrolling flex frame; v0.9: an archive link shows its contents under the strip (resolve, then list), Extract… reveals it with `ExtractDialog` open, Open location only reveals, a missing archive says so, any other name keeps `Original` with no request |
| `bookmarks.test.tsx` | §8.11: the star lights up for a bookmarked folder and toggles `addBookmark` / `removeBookmark`; the list navigates through `navigateTo`; a missing row is marked and removes itself; the rename dialog sends `renameBookmark`; both context menus toggle; the compact chrome keeps the star and moves the list into the overflow; the 51st is refused client-side |

### 11.2 Shell smoke tests (copy-pasteable)

```bash
cd /home/coder/.bb/personal-workspaces/env_85kdqqyirz/bb-plugin-file-manager
npm install
bb plugin install . --yes          # --yes is mandatory in a non-TTY shell
bb plugin list --json | jq '.plugins[] | select(.id=="file-manager")
  | {status, statusDetail, hasApp:.app.hasApp, compatible:.app.bundle.compatible, jsUrl:.app.bundle.jsUrl}'
# expect: status "running", statusDetail null, hasApp true, compatible true

BASE="$BB_SERVER_URL"   # http://127.0.0.1:38886
ID=file-manager

# 1. headless proof the sidebar entry is registered (the server itself knows
#    nothing about navPanels; the bundle is NOT minified, so grep it)
JS=$(curl -sS "$BASE/api/v1/plugins" | jq -r --arg id "$ID" '.plugins[]|select(.id==$id)|.app.bundle.jsUrl')
curl -sS "$BASE$JS" | grep -A6 'slots.navPanel'

# 2. RPC: bootstrap + list (local auth: JSON content-type is mandatory)
curl -sS -X POST "$BASE/api/v1/plugins/$ID/rpc/getState" \
  -H 'content-type: application/json' -d 'null' | jq
curl -sS -X POST "$BASE/api/v1/plugins/$ID/rpc/listDir" \
  -H 'content-type: application/json' \
  -d '{"path":"/home/coder","showHidden":false}' | jq '.result.entries | length'

# 3. path traversal must fail
curl -sS -X POST "$BASE/api/v1/plugins/$ID/rpc/listDir" \
  -H 'content-type: application/json' -d '{"path":"/etc"}' | jq
curl -sS -X POST "$BASE/api/v1/plugins/$ID/rpc/listDir" \
  -H 'content-type: application/json' -d '{"path":"/home/coder/../../etc"}' | jq
# expect ok:false, message starting with "path_escape: "

# 4. token + chunked upload of a 200 MiB file (the real path)
TOKEN=$(bb plugin token $ID --json | jq -r .token)
head -c 209715200 /dev/urandom > /tmp/fm-big.bin
UP=$(curl -sS -X POST "$BASE/api/v1/plugins/$ID/rpc/uploadCreate" \
  -H 'content-type: application/json' \
  -d "{\"dirPath\":\"/home/coder\",\"fileName\":\"fm-big.bin\",\"sizeBytes\":209715200}")
UID_=$(echo "$UP" | jq -r .result.uploadId)
OFF=0; CH=$((16*1024*1024))
while [ $OFF -lt 209715200 ]; do
  dd if=/tmp/fm-big.bin bs=1 skip=$OFF count=$CH status=none 2>/dev/null > /tmp/fm-chunk.bin || true
  curl -sS -X POST "$BASE/api/v1/plugins/$ID/http/upload/chunk?uploadId=$UID_&offset=$OFF" \
    -H "x-bb-plugin-token: $TOKEN" -H 'content-type: application/octet-stream' \
    --data-binary @/tmp/fm-chunk.bin | jq -c .
  OFF=$((OFF+CH))
done
curl -sS -X POST "$BASE/api/v1/plugins/$ID/rpc/uploadFinish" \
  -H 'content-type: application/json' -d "{\"uploadId\":\"$UID_\"}" | jq
cmp /tmp/fm-big.bin /home/coder/fm-big.bin && echo "UPLOAD BYTE-EXACT"

# 5. the 415 trap: the same POST on a local-auth route is rejected
curl -sS -i -X POST "$BASE/api/v1/plugins/$ID/http/upload/chunk?uploadId=$UID_&offset=0" \
  --data-binary @/tmp/fm-chunk.bin | head -1     # 401 (no token) — never 200

# 6. streamed download + headers + Range
curl -sS -D /tmp/h.txt -o /tmp/fm-out.bin \
  "$BASE/api/v1/plugins/$ID/http/download?path=%2Fhome%2Fcoder%2Ffm-big.bin"
grep -Ei 'content-type|content-length|accept-ranges|content-disposition|cache-control' /tmp/h.txt
cmp /tmp/fm-big.bin /tmp/fm-out.bin && echo "DOWNLOAD BYTE-EXACT"
curl -sS -D - -o /dev/null -H 'Range: bytes=0-99' \
  "$BASE/api/v1/plugins/$ID/http/download?path=%2Fhome%2Fcoder%2Ffm-big.bin" | head -8
# expect: HTTP/1.1 206, content-range: bytes 0-99/209715200, content-length: 100

# 7. compression must NOT kick in (Content-Length must survive)
curl -sS -D - -o /dev/null -H 'Accept-Encoding: gzip' \
  "$BASE/api/v1/plugins/$ID/http/download?path=%2Fhome%2Fcoder%2Ffm-big.bin" \
  | grep -Ei 'content-encoding|content-length|transfer-encoding'
# expect a content-length line and NO content-encoding: gzip

# 8. cleanup
curl -sS -X POST "$BASE/api/v1/plugins/$ID/rpc/deleteEntries" \
  -H 'content-type: application/json' \
  -d '{"paths":["/home/coder/fm-big.bin"],"recursive":false}' | jq
bb plugin logs $ID -n 50
```

Dev loop: `bb plugin dev` (rebuilds `dist/app.js` and reloads on save, 300 ms
debounce, ignores `dist/ node_modules/ .git/`). A path install also rebuilds the
frontend automatically on `bb plugin reload` when any source file's mtime is
newer than `dist/app.js`. The backend is always loaded from source — no build
needed for `server.ts` edits.

---

## 12. Marketplace checklist (PACKAGING)

Files that must exist in the plugin repository:

- [ ] `package.json` exactly as §2 (real `bb.description`, `branding.icon: "FolderOpen"`, `bb.app` present)
- [ ] `README.md` — what it does, install, settings table, **security section**
      (hard root `/home/coder`, `realpath` clamping, token-gated upload route,
      local-auth download route), screenshot
- [ ] `LICENSE` — MIT, already present
- [ ] `.gitignore` — must keep `dist/` and `node_modules/` out (already correct)
- [ ] `assets/icon.svg` *(optional)* — only if a custom glyph is wanted; must be
      a namespaced `<svg>` root **without** an `<?xml …?>` prolog or DOCTYPE
      (bb's sanitizer rejects those). Otherwise keep the named icon.
- [ ] no `dist/` committed (bb builds git installs itself)
- [ ] every runtime import in `dependencies` (git installs run
      `npm install --omit=dev --ignore-scripts`)
- [ ] public GitHub repo, annotated tag `v0.1.0` pushed **before** opening the PR
      (the registry CI runs `git ls-remote --tags` liveness)

Marketplace entry `entries/file-manager.json` in a fork of
`github.com/get-bb/marketplace` (strict schema, `additionalProperties: false`):

```json
{
  "id": "file-manager",
  "displayName": "File Manager",
  "description": "Browse, upload, download, move, rename and extract files under /home/coder from a full-page bb panel, with chunked resumable uploads for multi-gigabyte files.",
  "icon": "FolderOpen",
  "tags": ["host-access", "files", "uploads", "downloads", "interface"],
  "author": { "name": "<ASK THE USER>", "github": "xMinor-1", "url": "https://github.com/xMinor-1" },
  "source": {
    "git": { "url": "https://github.com/xMinor-1/bb-plugin-file-manager.git", "range": "^0.1.0" }
  }
}
```

* **Do not add an `engines` field** — the entry schema is strict and rejects it,
  even though two SKILL.md files still show it (verified: the registry build
  fails with `must NOT have additional properties`).
* The first tag that matches bb's curated category vocabulary decides the Browse
  section — `host-access` first is deliberate.
* `id` must equal the id bb derives from the package name (`file-manager`), or
  installs are refused.
* Validate locally before the PR: `npm ci && npm run check` inside the
  marketplace clone; PR title `Add plugin entry: file-manager`.
* Pushing the tag and opening the PR require **explicit user approval**.

---

## 13. File-by-file work breakdown

**Rule: no two workstreams ever write the same file.** If you believe you need
to edit another stream's file, stop and raise it — do not edit.

### PACKAGING (do this first; it unblocks the other two)

| File | Content |
| --- | --- |
| `package.json` | §2 verbatim |
| `tsconfig.json` | §3 verbatim |
| `contract.ts` | §4 verbatim — **frozen**, nobody else edits it |
| `components.json` | copy from `/tmp/bbscaffoldprobe/bb-plugin-probe/components.json` (registry ref `desktop-v0.39.0`) |
| `components/ui/{button,card,dialog,input,icon,motion,coarse-pointer-sizing,overlay-trigger,responsive-overlay}.tsx` | copy from `/tmp/bbscaffoldprobe/bb-plugin-probe/components/ui/` |
| `components/ui/hooks/{use-compact-viewport.tsx,use-media-query.ts}` | same source |
| `hooks/useBrowserDimmingModal.ts`, `lib/utils.ts`, `lib/portal-scope.ts` | same source |
| `components/ui/{context-menu,menu-item-hover,dropdown-menu,table,checkbox,tooltip,separator}.tsx` | `npx shadcn add @bb/context-menu @bb/dropdown-menu @bb/table @bb/checkbox @bb/tooltip @bb/separator` (needs network). **Offline fallback**: extract `files[0].content` from `…/bb-main/packages/plugin-registry/r/<name>.json` — e.g. `node -e 'const j=require("<r>/table.json");require("fs").writeFileSync("components/ui/table.tsx",j.files[0].content)'` |
| `vitest.config.ts` | plain `defineConfig` from `vitest/config` (**not** the monorepo helper): `{ test: { name:"bb-plugin-file-manager", setupFiles:["./vitest.setup.ts"], include:["test/**/*.test.{ts,tsx}"], exclude:["node_modules/**","dist/**"], testTimeout: 20_000 } }` |
| `vitest.setup.ts` | `configure({ asyncUtilTimeout: 8000 })` + `matchMedia` stub + `scrollIntoView` stub (copy from `plugins/tasks/vitest.setup.ts`) |
| `README.md` | rewrite: features, install, settings, security, dev loop |
| `assets/icon.svg` | optional, §12 rules |

Verification: `npm install && npx tsc --noEmit` (with placeholder `server.ts`
and `app.tsx` still in place) must pass before handing off.

### BACKEND (owns `server.ts` and everything under `src/` and `test/backend/`)

| File | Responsibility |
| --- | --- |
| `server.ts` | factory only: resolve `ROOT`, build settings, register rpc + http + schedule + dispose; re-export `fileManagerContract` |
| `src/root.ts` | `ROOT`, `assertInside`, `validateName`, `normalize`, `resolveExisting`, `resolveLink`, `resolveNew`, `assertNotInsideSelf` (§6) |
| `src/errors.ts` | `FileManagerError(code, message)` → `Error("<code>: <message>")`, `mapNodeError(err)` (ENOENT→not_found, EACCES/EPERM→permission_denied, ENOTEMPTY→not_empty, EEXIST→exists, EXDEV→cross_device, ENOSPC→no_space) |
| `src/settings.ts` | descriptors (§7.1), cached values, `onChange`, `savePreferences` via `bb.sdk.plugins.updateSettings`, `chunkSizeBytes` |
| `src/listing.ts` | `listDir`, `statPath`, `searchDir`, entry mapping, archive detection, `statfs` volume info |
| `src/mutations.ts` | `createFolder`, `renameEntry`, `deleteEntries`, `moveEntries`, `copyEntries`, conflict policies, `uniqueName()` (`name (1).ext`), EXDEV fallback via `fs.cp` + `rm` |
| `src/uploads.ts` | session sidecars, `uploadCreate/Status/Finish/Abort`, chunk lock set, `writeChunk()`, GC sweep |
| `src/archives.ts` | format detection by extension, `spawn` of `tar`/`unzip`/`7z` with `--no-same-owner --no-same-permissions`, staging dir, post-extraction containment walk, capability probe at load (v0.9: plus the RAR codec probe, and it builds the lister) |
| `src/archive-listing.ts` | v0.9, §8.13: `listArchive` — the §6 clamp, yauzl for zip, `tar -tv` and `7z l` children with their bounds, kill and dispose |
| `src/archive-parse.ts` | v0.9, §8.13: pure name decoding (UTF-8 / CP866), zip record mapping, the tar and 7z line parsers, `LineSplitter`, `ListingCollector` |
| `src/jobs.ts` | in-memory job map, `publishJob`, `jobStatus`, `jobCancel` |
| `src/http-routes.ts` | route 1 (`token`) and route 2 (`local`) exactly as §5 |
| `src/rpc.ts` | `bb.rpc.register(fileManagerContract, handlers)` wiring only |
| `src/signals.ts` | `publishFs(paths, reason)` |
| `test/backend/*.test.ts` | §11.1 |

### FRONTEND (owns `app.tsx`, `components/` except `components/ui/`, `hooks/` except `useBrowserDimmingModal.ts`, `lib/` except `utils.ts`/`portal-scope.ts`, `test/frontend/`)

| File | Responsibility |
| --- | --- |
| `app.tsx` | slot registration (§10) + `FileManagerPanel` import |
| `components/*.tsx`, `components/dialogs/*.tsx` | §8 tree (v0.9: `components/ArchiveContents.tsx`, §8.13) |
| `lib/archive-tree.ts` | v0.9, §8.13: the archive tree model — implied folders, order, expansion, the row cap |
| `hooks/*.ts` | §8 tree |
| `lib/fm-rpc.ts`, `lib/upload-manager.ts`, `lib/download.ts`, `lib/fm-paths.ts`, `lib/format.ts`, `lib/errors.ts` | §8 tree |
| `test/frontend/*.test.tsx` | §11.1 |

Frontend contract assumptions it may rely on without asking:

* Absolute paths everywhere in RPC; `lib/fm-paths.ts` converts to/from the
  root-relative form used in `subPath`.
* Any RPC rejection carries a message shaped `"<code>: <text>"`.
* Batch methods resolve even when some paths failed.
* Uploads: `uploadCreate` → N × chunk POST → `uploadFinish`, resume by
  `expected`/`received` (§5.2).
* Download: build the URL, click an anchor. Never read the body in JS.

### Integration order

1. PACKAGING lands `package.json`, `tsconfig.json`, `contract.ts`, vendored UI.
2. BACKEND and FRONTEND start in parallel against `contract.ts`.
3. FRONTEND stubs RPC with `renderSlot({ rpc: … })` until the backend lands.
4. First joint checkpoint: `bb plugin install . --yes` + smoke tests 1–3.
5. Second checkpoint: upload/download smoke tests 4–7.

---

## 14. Open questions & risks (do not block on these)

1. **Multi-GB end-to-end has never been run on this box.** The code path is
   verified by sources and by a 50 MB live POST, but the first prototype must
   run smoke test 4 with a ≥5 GB file. Chunking makes the 300 s
   `requestTimeout` a non-issue; disk space (39 GB free) is the practical limit.
2. **Node may or may not emit a 408 before destroying a timed-out request.**
   Irrelevant for correctness (the client resumes from `expected`), but it
   changes the error text a user sees.
3. **`webkitGetAsEntry` in the Electron shell is unverified** — folder drops may
   fall back to flat file drops. Ship the fallback toast.
4. **Electron cannot give the plugin a dropped file's local path**
   (`File.path` removed in Electron 32+, `webUtils.getPathForFile` is not
   reachable from plugin code), so a "same machine, just copy it server-side"
   shortcut is impossible. All bytes go over HTTP.
5. **Archive extraction shells out to `tar`/`unzip`/`7z`.** All three exist here
   (GNU tar 1.35, Info-ZIP 6.00, 7z). If a reviewer objects to
   `child_process`, the alternative is bundling `tar` + `yauzl` as
   `dependencies`; the containment walk stays either way. Listing (§8.13)
   already uses `yauzl` for zip, as a runtime dependency; tar and 7z listing
   still shell out, and listing the tar family needs **GNU** tar
   (`--quoting-style`, `--full-time`). BSD tar has neither option, so there
   the listing would fail with tar's own message — unverified, as no BSD tar
   is installed here.
6. **A `bb plugin reload` during a large download can dispose plugin resources
   under the live stream** (the drain window is 5 s and a streamed `Response`
   returns immediately). Mitigation is already in the spec: hold nothing but a
   raw fd inside the stream.
7. **`fs.rename` across filesystems (`EXDEV`)** cannot happen today (single ext4
   mount) but the fallback is specified because a future bind-mount under
   `/home/coder` would silently break moves and upload commits.
8. **`bb connect` tunnel limits are unknown.** If the panel is driven remotely
   through getbb.app rather than loopback, the proxy may impose its own body or
   duration limits; adaptive chunk sizing is the mitigation.
9. **`author.name` for the marketplace entry is `Foma`** — decided by the owner
   and applied across every entry and `LICENSE` in this repository.
10. **`npx shadcn add @bb/*` needs network** to `raw.githubusercontent.com` at
    tag `desktop-v0.39.0`; the offline extraction fallback in §13 is the
    supported path if that tag or the network is unavailable.

### Explicitly out of scope for v0.1 (do not build)

Folder download as an archive, archive *creation*, file preview/editing,
trash/undo, permissions editing, multi-host support, `bb file-manager` CLI
subcommand, drag-out to the OS, thumbnails, and a persistent operation history.
