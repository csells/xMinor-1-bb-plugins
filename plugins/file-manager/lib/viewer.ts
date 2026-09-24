// lib/viewer.ts — which renderer the built-in viewer reaches for (§8.12).
//
// Only four kinds are decided from the name, and all four for the same reason:
// they are the ones the browser paints from a URL, so getting them wrong costs
// a request for bytes nothing can display. Everything else is `text` — a
// *question*, not a claim. `readTextFile` answers it from the bytes, which is
// the only way `Makefile`, `LICENSE`, `.gitignore` and `dockerfile` ever open,
// and the only honest answer for the extension nobody has heard of yet.
//
// The one exception to "the name only picks a transport" is an archive
// (§8.13): its bytes are never text, and what is worth showing is its table
// of contents — so an entry the listing already marked with `archiveFormat`
// gets `archive`, and its contents come from `listArchive` instead.
import type { FileEntry } from "../contract";
import { isImageName } from "./preview";

/** How the viewer will try to show a file. */
export type ViewerKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "archive";

/**
 * Video containers a browser plays without a plugin.
 *
 * Deliberately short: `mkv`, `avi`, `wmv` and `flv` are common on disk and
 * unplayable in a `<video>`, and offering a black rectangle is worse than
 * offering the download that the `text` branch ends in.
 */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);

/** Audio a browser decodes. `aiff` and `wma` are absent for the same reason. */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "aac",
  "flac",
  "opus",
  "weba",
]);

/** Rendered by bb's Markdown component, with the source one click away. */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx"]);

/** Lowercased extension after the last dot, or "" for a dotfile / no dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The renderer to try for a file name. Never fails: `text` is the catch-all. */
export function viewerKindFor(name: string): ViewerKind {
  if (isImageName(name)) return "image";
  const extension = extensionOf(name);
  if (extension === "pdf") return "pdf";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  return "text";
}

/**
 * The renderer for a listed entry: `archive` when the listing marked it as
 * one (the same test that drives its icon and its Extract… row), otherwise
 * whatever its name says.
 */
export function viewerKindForEntry(entry: FileEntry): ViewerKind {
  return entry.archiveFormat !== null ? "archive" : viewerKindFor(entry.name);
}

/** True for the kinds read as a string through `readTextFile`. */
export function isTextViewerKind(kind: ViewerKind): boolean {
  return kind === "text" || kind === "markdown";
}

/** True for the kinds shown from a `createPreviewUrl` URL rather than a string. */
export function isUrlViewerKind(kind: ViewerKind): boolean {
  return kind === "image" || kind === "pdf" || kind === "video" || kind === "audio";
}

/**
 * True for an entry the built-in viewer will accept at all.
 *
 * A folder is navigated into, not viewed, and a link out of the root is
 * refused by the server anyway (§6) — so those two are the whole exclusion
 * list. Everything else gets a try, because the alternative is deciding from
 * the name what only the bytes know.
 */
export function isViewableEntry(entry: FileEntry): boolean {
  if (entry.escapesRoot) return false;
  const kind = entry.isSymlink && entry.targetKind !== null ? entry.targetKind : entry.kind;
  return kind === "file";
}
