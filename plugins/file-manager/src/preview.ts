// src/preview.ts — the two ways the panel gets at a file's contents.
//
// The panel needs to *display* the files it lists, not just describe them, and
// that splits in two along one line: bytes a browser paints from a URL, and
// text a renderer needs as a string.
//
//   * `createPreviewUrl` (§8.9, §8.12) — images, PDFs, audio and video. The
//     download route is the wrong tool for those: it is
//     `application/octet-stream` with `no-store` and `Content-Disposition`,
//     deliberately, so an <img src> on it would fight the very headers that
//     make a download a download. bb already has the right primitive —
//     `bb.sdk.files.createPreview` mints a short-lived URL rooted at one
//     folder — so this is only the §6 path clamp in front of it and one stable
//     error code behind it.
//   * `readTextFile` (§8.12) — everything the viewer renders as text. Capped,
//     and it decides "is this text?" from the bytes rather than from the name,
//     because `Makefile`, `LICENSE` and `.gitignore` carry no extension and
//     still have to open.
import { open, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { MAX_TEXT_PREVIEW_BYTES, PREVIEW_TTL_MS } from "../contract";
import { fmError, mapNodeError } from "./errors";
import { resolveExisting, resolveExistingDir } from "./root";

export interface CreatePreviewUrlInput {
  path: string;
}

export interface CreatePreviewUrlOutput {
  baseUrl: string;
  path: string;
  expiresAtMs: number;
}

export async function createPreviewUrl(
  bb: BbPluginApi,
  input: CreatePreviewUrlInput,
): Promise<CreatePreviewUrlOutput> {
  // The clamp comes first and is the ordinary one: whatever the URL can reach
  // is decided here, by a realpath'ed folder inside the hard root, and never
  // by a string the panel sent.
  const dir = await resolveExistingDir(input.path);

  let preview: { baseUrl: string; expiresAtMs: number };
  try {
    // No `hostId`: the root of this plugin is the home folder of the user
    // running bb, so the files are on bb's own machine — which is what the
    // files area addresses when no host is named.
    preview = await bb.sdk.files.createPreview({ rootPath: dir, ttlMs: PREVIEW_TTL_MS });
  } catch (error) {
    // A server too old to mint preview URLs, or one that refused this folder,
    // must not read as a broken plugin: thumbnails are decoration, and the
    // panel falls back to type icons on any rejection. One stable code keeps
    // that branch from string-matching whatever the host happened to say.
    bb.log.warn(`could not create a preview URL for ${dir}: ${String(error)}`);
    throw fmError("unsupported", "previews are not available on this server");
  }

  return { baseUrl: preview.baseUrl, path: dir, expiresAtMs: preview.expiresAtMs };
}

/* ------------------------------------------------------------------ */
/* readTextFile                                                        */
/* ------------------------------------------------------------------ */

export interface ReadTextFileInput {
  path: string;
}

export interface ReadTextFileOutput {
  path: string;
  text: string;
  sizeBytes: number;
  readBytes: number;
  truncated: boolean;
}

/**
 * Decode a read window as UTF-8, or null when it is not UTF-8 at all.
 *
 * `truncated` buys up to three attempts: a cap that lands mid-character leaves
 * a legal prefix plus a stump, and a viewer refusing a 4 MB source file over
 * one clipped emoji at the cut would be absurd. An untruncated window gets
 * exactly one attempt — there is no cut to blame, so a failure is the file.
 */
function decodeUtf8(bytes: Uint8Array, truncated: boolean): string | null {
  // `fatal` is what makes this a test and not a lossy conversion: without it
  // every byte sequence "decodes", into U+FFFD soup.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maxTrim = truncated ? 3 : 0;
  for (let trim = 0; trim <= maxTrim; trim += 1) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.length - trim));
    } catch {
      // Not this cut; try one byte earlier.
    }
  }
  return null;
}

export async function readTextFile(input: ReadTextFileInput): Promise<ReadTextFileOutput> {
  const absolutePath = await resolveExisting(input.path);

  let stats: Stats;
  try {
    stats = await stat(absolutePath);
  } catch (error) {
    throw mapNodeError(error, absolutePath);
  }
  if (!stats.isFile()) throw fmError("not_a_file", absolutePath);

  const window = Math.min(stats.size, MAX_TEXT_PREVIEW_BYTES);
  const buffer = Buffer.alloc(window);
  let readBytes = 0;
  // A plain handle rather than readFile: the point is to never hold more than
  // the cap in memory, whatever the file turns out to weigh.
  const handle = await open(absolutePath, "r").catch((error: unknown) => {
    throw mapNodeError(error, absolutePath);
  });
  try {
    if (window > 0) {
      const result = await handle.read(buffer, 0, window, 0);
      readBytes = result.bytesRead;
    }
  } catch (error) {
    throw mapNodeError(error, absolutePath);
  } finally {
    await handle.close();
  }

  const bytes = buffer.subarray(0, readBytes);
  // A NUL byte is the cheap half of the binary test and the decisive one: no
  // UTF-8 text contains it, and every executable, archive and image does.
  if (bytes.includes(0)) throw fmError("unsupported", `${absolutePath} is not a text file`);

  const truncated = stats.size > readBytes;
  const text = decodeUtf8(bytes, truncated);
  if (text === null) throw fmError("unsupported", `${absolutePath} is not a text file`);

  return {
    path: absolutePath,
    text,
    sizeBytes: stats.size,
    readBytes: Buffer.byteLength(text, "utf8"),
    truncated,
  };
}
