// Pure path helpers shared by the backend. Kept free of the plugin API so
// they can be unit-tested without a bb server.

/** The last segment of a POSIX-ish path, or the path itself when it has none. */
export function baseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** Everything before the last segment; "." when the path has no directory. */
export function directoryName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (index === -1) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

/** Joins a root with a relative path, tolerating a trailing slash on the root. */
export function joinPath(root: string, relative: string): string {
  const left = root.replace(/\/+$/, "");
  const right = relative.replace(/^\/+/, "");
  return right.length === 0 ? left : `${left}/${right}`;
}

/**
 * Appends one file name to a file-preview base URL. Preview URLs are
 * path-shaped, so each segment is encoded individually.
 */
export function previewUrlFor(baseUrl: string, fileName: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(fileName)}`;
}

/**
 * The name a converted document keeps: "Отчёт Q3.docx" → "Отчёт Q3.pdf".
 * Safe as one path segment and short enough for any file system.
 */
export function pdfNameFor(originalName: string): string {
  const stem = originalName.replace(/\.[^.]*$/, "");
  const safe = [...stem]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code >= 0x20 && code !== 0x7f && character !== "/" && character !== "\\"
      );
    })
    .join("")
    .trim()
    .slice(0, 120);
  return `${safe || "document"}.pdf`;
}
