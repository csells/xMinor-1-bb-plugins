// src/properties.ts — "what exactly is this?" (§8.10).
//
// Two answers, deliberately kept apart because they cost different amounts.
// `pathProperties` is a single lstat and never looks below the path it was
// given, so the panel can call it every time a dialog opens. `directorySize`
// walks a whole subtree, which under a home directory can mean hundreds of
// thousands of inodes — so it is a separate call the user has to ask for, it
// is bounded on three axes, and it is allowed to answer "this is a lower
// bound" instead of pretending it saw everything.
//
// Every path still comes out of src/root.ts: `resolveLink` for the entry
// itself (a symlink is described, never followed) and `resolveExistingDir` for
// the walk root.
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import type { Dirent, Stats } from "node:fs";

import type { ArchiveFormat, EntryKind } from "../contract";
import { mapNodeError } from "./errors";
import { detectArchiveFormat, entryFrom } from "./listing";
import {
  assertInside,
  getRoot,
  isInside,
  isStagingPath,
  normalize,
  parentOf,
  resolveExistingDir,
  resolveLink,
} from "./root";

/* ------------------------------------------------------------------ */
/* Content type (by extension only)                                    */
/* ------------------------------------------------------------------ */

/**
 * Guessed from the name, never from the bytes. Sniffing would mean opening a
 * file the user only asked *about* — and an extension is already what the rest
 * of the plugin trusts (`detectArchiveFormat`, the row icon, §10.2's openers).
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  // text and docs
  txt: "text/plain", log: "text/plain", md: "text/markdown",
  markdown: "text/markdown", mdx: "text/markdown", rst: "text/x-rst",
  tex: "application/x-tex", rtf: "application/rtf", pdf: "application/pdf",
  epub: "application/epub+zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  // config and data
  json: "application/json", jsonc: "application/json", json5: "application/json",
  ndjson: "application/x-ndjson", yaml: "application/yaml", yml: "application/yaml",
  toml: "application/toml", xml: "application/xml", csv: "text/csv",
  tsv: "text/tab-separated-values", ini: "text/plain", cfg: "text/plain",
  conf: "text/plain", env: "text/plain", properties: "text/plain",
  sql: "application/sql", ics: "text/calendar", vcf: "text/vcard",
  db: "application/vnd.sqlite3", sqlite: "application/vnd.sqlite3",
  sqlite3: "application/vnd.sqlite3",
  // code
  ts: "text/typescript", tsx: "text/typescript", js: "text/javascript",
  jsx: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
  py: "text/x-python", rb: "text/x-ruby", go: "text/x-go", rs: "text/x-rust",
  java: "text/x-java", kt: "text/x-kotlin", swift: "text/x-swift",
  c: "text/x-c", h: "text/x-c", cc: "text/x-c++", cpp: "text/x-c++",
  hpp: "text/x-c++", cs: "text/x-csharp", php: "application/x-httpd-php",
  sh: "application/x-sh", bash: "application/x-sh", zsh: "application/x-sh",
  ps1: "application/x-powershell", lua: "text/x-lua", r: "text/x-r",
  pl: "text/x-perl", dart: "text/x-dart", vue: "text/x-vue",
  svelte: "text/x-svelte", graphql: "application/graphql", gql: "application/graphql",
  proto: "text/x-protobuf", diff: "text/x-diff", patch: "text/x-diff",
  // web
  html: "text/html", htm: "text/html", xhtml: "application/xhtml+xml",
  css: "text/css", scss: "text/x-scss", sass: "text/x-sass", less: "text/x-less",
  // images
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
  bmp: "image/bmp", ico: "image/vnd.microsoft.icon", tif: "image/tiff",
  tiff: "image/tiff", heic: "image/heic", psd: "image/vnd.adobe.photoshop",
  // audio and video
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", aac: "audio/aac",
  ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", opus: "audio/opus",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo",
  mpg: "video/mpeg", mpeg: "video/mpeg",
  // fonts and binaries
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  wasm: "application/wasm", exe: "application/vnd.microsoft.portable-executable",
  so: "application/x-sharedlib", dll: "application/x-msdownload",
  bin: "application/octet-stream", dat: "application/octet-stream",
  // certificates
  pem: "application/x-pem-file", crt: "application/x-x509-ca-cert",
  cer: "application/x-x509-ca-cert", asc: "application/pgp-signature",
  sig: "application/pgp-signature", gpg: "application/pgp-encrypted",
};

/** Archives are matched by suffix, so `.tar.gz` wins over a bare `.gz`. */
const ARCHIVE_CONTENT_TYPES: Readonly<Record<ArchiveFormat, string>> = {
  zip: "application/zip",
  tar: "application/x-tar",
  "tar.gz": "application/gzip",
  "tar.bz2": "application/x-bzip2",
  "tar.xz": "application/x-xz",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
};

/** `null` when the name says nothing useful — `Makefile`, `.bashrc`, `LICENSE`. */
export function contentTypeOf(name: string): string | null {
  const archive = detectArchiveFormat(name);
  if (archive !== null) return ARCHIVE_CONTENT_TYPES[archive];
  const dot = name.lastIndexOf(".");
  // `dot > 0` on purpose: a leading dot is a hidden file, not an extension.
  if (dot <= 0) return null;
  return CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

const RWX = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"] as const;

/** The leading character of the `ls -l` mode column. */
function typeCharOf(st: Stats): string {
  if (st.isSymbolicLink()) return "l";
  if (st.isDirectory()) return "d";
  if (st.isBlockDevice()) return "b";
  if (st.isCharacterDevice()) return "c";
  if (st.isFIFO()) return "p";
  if (st.isSocket()) return "s";
  return "-";
}

/** Four octal digits, so the setuid/setgid/sticky triple is never dropped. */
export function formatModeOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/**
 * The `ls -l` permission column: "drwxr-xr-x", "-rw-r--r--", "lrwxrwxrwx".
 * setuid / setgid / sticky replace the matching execute bit with `s`/`s`/`t`
 * (uppercase when that execute bit is off), which is the only way to see them
 * without reading the octal — and the only way to notice a setuid binary.
 */
export function formatModeText(mode: number, typeChar = "-"): string {
  const chars = [(mode >> 6) & 0o7, (mode >> 3) & 0o7, mode & 0o7]
    .map((triple) => RWX[triple] ?? "---")
    .join("")
    .split("");
  const special = (mode >> 9) & 0o7;
  if (special & 0o4) chars[2] = chars[2] === "x" ? "s" : "S";
  if (special & 0o2) chars[5] = chars[5] === "x" ? "s" : "S";
  if (special & 0o1) chars[8] = chars[8] === "x" ? "t" : "T";
  return typeChar + chars.join("");
}

/**
 * Only the user bb itself runs as can be named. Node exposes no getpwuid, and
 * parsing /etc/passwd would both leave the hard root and answer wrongly on any
 * host that resolves users through LDAP or SSSD — so every other owner, and
 * every group, is reported as a plain number, which is what `ls -n` does.
 */
function ownerNameFor(uid: number): string | null {
  try {
    const self = userInfo();
    return self.uid === uid ? self.username : null;
  } catch {
    // userInfo() throws when the running uid has no passwd entry at all.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* pathProperties                                                      */
/* ------------------------------------------------------------------ */

export interface PathPropertiesOutput {
  name: string;
  path: string;
  parentPath: string | null;
  kind: EntryKind;
  targetKind: EntryKind | null;
  isSymlink: boolean;
  escapesRoot: boolean;
  linkTarget: string | null;
  linkTargetPath: string | null;
  sizeBytes: number;
  modifiedAtMs: number;
  createdAtMs: number | null;
  accessedAtMs: number;
  modeOctal: string;
  modeText: string;
  ownerUid: number;
  ownerGid: number;
  ownerName: string | null;
  linkCount: number;
  contentType: string | null;
}

/** What a symlink row is really about: its target's kind, when it has one. */
function effectiveKind(kind: EntryKind, targetKind: EntryKind | null): EntryKind {
  return kind === "symlink" && targetKind !== null ? targetKind : kind;
}

/**
 * Describe one path without following its final component — the dialog is
 * about the entry the user right-clicked, so a symlink reports its own mode,
 * its own size and where it points, not its target's.
 */
export async function pathProperties(input: { path: string }): Promise<PathPropertiesOutput> {
  const abs = normalize(input.path);
  const root = getRoot();

  let target: string;
  let st: Stats;
  if (abs === root) {
    // The one path `resolveLink` refuses (§6 rule 5), and the one the empty
    // -space menu asks about whenever the panel is sitting in the root.
    assertInside(abs);
    target = root;
    try {
      st = await lstat(root);
    } catch (error) {
      throw mapNodeError(error, root);
    }
  } else {
    const resolved = await resolveLink(input.path);
    target = resolved.path;
    st = resolved.lstat;
  }

  // Reuse the listing's own symlink handling: `targetKind` and `escapesRoot`
  // come from the same guarded realpath every row already reports (§6 rule 3).
  const entry = await entryFrom(target, st);

  let linkTarget: string | null = null;
  let linkTargetPath: string | null = null;
  if (entry.isSymlink) {
    linkTarget = await readlink(target).catch(() => null);
    const real = await realpath(target).catch(() => null);
    // A link out of the root is *named* (the raw text above) but never
    // resolved into a path the panel could try to open.
    linkTargetPath = real !== null && isInside(real) ? real : null;
  }

  const kind = effectiveKind(entry.kind, entry.targetKind);

  return {
    name: entry.name,
    path: entry.path,
    parentPath: parentOf(entry.path),
    kind: entry.kind,
    targetKind: entry.targetKind,
    isSymlink: entry.isSymlink,
    escapesRoot: entry.escapesRoot,
    linkTarget,
    linkTargetPath,
    sizeBytes: st.size,
    modifiedAtMs: Math.floor(st.mtimeMs),
    // A filesystem with no birth time reports 0, and rendering that as
    // "1 Jan 1970" would be a lie — say "unknown" instead.
    createdAtMs: st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs) : null,
    accessedAtMs: Math.floor(st.atimeMs),
    modeOctal: formatModeOctal(st.mode),
    modeText: formatModeText(st.mode, typeCharOf(st)),
    ownerUid: st.uid,
    ownerGid: st.gid,
    ownerName: ownerNameFor(st.uid),
    linkCount: st.nlink,
    contentType: kind === "directory" ? null : contentTypeOf(entry.name),
  };
}

/* ------------------------------------------------------------------ */
/* directorySize                                                       */
/* ------------------------------------------------------------------ */

/**
 * The three limits, and why these numbers.
 *
 * A home directory is the worst case this plugin ever sees, and the answer is
 * wanted while a dialog is open — not eventually.
 *
 *  - **depth 32**: hand-made trees are 5–10 deep and a nested `node_modules`
 *    reaches ~20; 32 clears both while still bounding a tree that generates
 *    itself. Hitting it does not stop the walk, it just stops that branch and
 *    marks the answer partial.
 *  - **200 000 entries**: roughly one large dependency tree, and about a
 *    second of `readdir` + `lstat` on a warm ext4 cache.
 *  - **5 s**: past this a dialog stops looking busy and starts looking broken.
 *    It also bounds the work an abandoned call leaves behind: bb's RPC has no
 *    abort channel, so a dialog closed mid-count cannot call the walk off — it
 *    can only ignore the answer, and this is what makes that cheap.
 */
export const DIRECTORY_SIZE_MAX_DEPTH = 32;
export const DIRECTORY_SIZE_MAX_ENTRIES = 200_000;
export const DIRECTORY_SIZE_TIME_BUDGET_MS = 5_000;

export type DirectorySizeStop = "depth" | "entries" | "time";

export interface DirectorySizeOutput {
  path: string;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  visitedEntries: number;
  partial: boolean;
  stoppedBy: DirectorySizeStop | null;
  elapsedMs: number;
}

/**
 * Recursive size of one directory, bounded by {@link DIRECTORY_SIZE_MAX_DEPTH},
 * {@link DIRECTORY_SIZE_MAX_ENTRIES} and {@link DIRECTORY_SIZE_TIME_BUDGET_MS}.
 *
 * Hidden entries count — a folder's size includes its dot-files — but symlinks
 * are never followed (a link to an ancestor loops forever, a link out of the
 * root would count bytes this plugin is not allowed to read) and the staging
 * directory is skipped, because half-written upload parts belong to no folder
 * the user can see (§6 rule 4).
 */
export async function directorySize(input: { path: string }): Promise<DirectorySizeOutput> {
  const dirReal = await resolveExistingDir(input.path);
  const startedAt = Date.now();

  let sizeBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let visitedEntries = 0;
  /** Only the two limits that abandon the walk; depth just prunes a branch. */
  let hardStop: "entries" | "time" | null = null;
  let depthLimited = false;

  // Depth-first over an explicit stack: recursion would hold one pending
  // promise per level for a walk that is a flat loop anyway.
  const stack: { dir: string; depth: number }[] = [{ dir: dirReal, depth: 0 }];

  while (stack.length > 0 && hardStop === null) {
    const current = stack.pop();
    if (current === undefined) break;

    let children: Dirent[];
    try {
      children = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skipped, exactly like searchDir does
    }

    for (const child of children) {
      if (Date.now() - startedAt > DIRECTORY_SIZE_TIME_BUDGET_MS) {
        hardStop = "time";
        break;
      }
      if (visitedEntries >= DIRECTORY_SIZE_MAX_ENTRIES) {
        hardStop = "entries";
        break;
      }

      const absolutePath = path.join(current.dir, child.name);
      if (isStagingPath(absolutePath)) continue;
      visitedEntries += 1;

      // `withFileTypes` reports the link itself, so this is the lstat kind.
      if (child.isSymbolicLink()) continue;

      if (child.isDirectory()) {
        directoryCount += 1;
        if (current.depth + 1 >= DIRECTORY_SIZE_MAX_DEPTH) {
          depthLimited = true;
          continue;
        }
        stack.push({ dir: absolutePath, depth: current.depth + 1 });
        continue;
      }

      // Sockets, FIFOs and device nodes carry no size worth adding up.
      if (!child.isFile()) continue;

      try {
        const st = await lstat(absolutePath);
        sizeBytes += st.size;
        fileCount += 1;
      } catch {
        // Vanished between readdir and lstat — simply not counted.
      }
    }
  }

  const stoppedBy: DirectorySizeStop | null = hardStop ?? (depthLimited ? "depth" : null);
  return {
    path: dirReal,
    sizeBytes,
    fileCount,
    directoryCount,
    visitedEntries,
    partial: stoppedBy !== null,
    stoppedBy,
    elapsedMs: Date.now() - startedAt,
  };
}
