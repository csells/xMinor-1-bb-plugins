// Which files the viewer opens and how. Shared by the backend and the panel,
// so it stays free of Node and DOM imports.

/**
 * - `pdf` renders as is.
 * - `text` and `presentation` are converted to PDF by LibreOffice.
 * - `spreadsheet` renders as a grid of cells.
 */
export type DocumentFamily = "pdf" | "text" | "presentation" | "spreadsheet";

export const PDF_EXTENSIONS = ["pdf"] as const;

/** Word processing: Word, OpenDocument Text, RTF, and their templates. */
export const TEXT_EXTENSIONS = [
  "docx",
  "docm",
  "doc",
  "dotx",
  "dotm",
  "dot",
  "odt",
  "ott",
  "fodt",
  "rtf",
] as const;

/** Slides: PowerPoint, OpenDocument Presentation, and their templates. */
export const PRESENTATION_EXTENSIONS = [
  "pptx",
  "pptm",
  "ppt",
  "ppsx",
  "ppsm",
  "pps",
  "potx",
  "potm",
  "pot",
  "odp",
  "otp",
  "fodp",
] as const;

/** Workbooks: Excel in every generation, OpenDocument Spreadsheet. */
export const SPREADSHEET_EXTENSIONS = [
  "xlsx",
  "xlsm",
  "xltx",
  "xltm",
  "xls",
  "xlt",
  "xlsb",
  "ods",
  "ots",
  "fods",
] as const;

/**
 * Spreadsheets stored as SpreadsheetML (a zip of XML parts) — the ones the
 * native reader opens without a conversion.
 */
export const OOXML_SPREADSHEET_EXTENSIONS = [
  "xlsx",
  "xlsm",
  "xltx",
  "xltm",
] as const;

/** Lowercased extension after the last dot, or "" when there is none. */
export function extensionOf(path: string): string {
  const name = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const FAMILY_BY_EXTENSION: ReadonlyMap<string, DocumentFamily> = new Map([
  ...PDF_EXTENSIONS.map((extension) => [extension, "pdf"] as const),
  ...TEXT_EXTENSIONS.map((extension) => [extension, "text"] as const),
  ...PRESENTATION_EXTENSIONS.map(
    (extension) => [extension, "presentation"] as const,
  ),
  ...SPREADSHEET_EXTENSIONS.map(
    (extension) => [extension, "spreadsheet"] as const,
  ),
]);

/** The family a path belongs to, or null when the viewer does not open it. */
export function documentFamily(path: string): DocumentFamily | null {
  return FAMILY_BY_EXTENSION.get(extensionOf(path)) ?? null;
}

export function isSupportedPath(path: string): boolean {
  return documentFamily(path) !== null;
}

export function isOoxmlSpreadsheetPath(path: string): boolean {
  return (OOXML_SPREADSHEET_EXTENSIONS as readonly string[]).includes(
    extensionOf(path),
  );
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  doc: "application/msword",
  dot: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  dotm: "application/vnd.ms-word.template.macroEnabled.12",
  odt: "application/vnd.oasis.opendocument.text",
  ott: "application/vnd.oasis.opendocument.text-template",
  rtf: "application/rtf",
  ppt: "application/vnd.ms-powerpoint",
  pps: "application/vnd.ms-powerpoint",
  pot: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ppsm: "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  potm: "application/vnd.ms-powerpoint.template.macroEnabled.12",
  odp: "application/vnd.oasis.opendocument.presentation",
  otp: "application/vnd.oasis.opendocument.presentation-template",
  xls: "application/vnd.ms-excel",
  xlt: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  xltm: "application/vnd.ms-excel.template.macroEnabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  ots: "application/vnd.oasis.opendocument.spreadsheet-template",
};

/** Content-Type for serving a file; unknown types download as bytes. */
export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? "application/octet-stream";
}
