// The reader contract shared by the native and the SheetJS readers.
import type { SheetData, WorkbookSummary } from "../../lib/sheet-model.js";

export interface SpreadsheetReader {
  readonly summary: WorkbookSummary;
  /** "full" = native OOXML reader with styles; "basic" = SheetJS fallback. */
  readonly fidelity: "full" | "basic";
  /** Reads one sheet; safe to call repeatedly and concurrently. */
  readSheet(index: number, signal?: AbortSignal): Promise<SheetData>;
  /** Releases the file; reads already running finish first. */
  close(): void;
}

export interface OpenSpreadsheetOptions {
  /** The viewer's locale for dates and number separators, e.g. "ru-RU". */
  locale: string;
  signal?: AbortSignal;
}

/**
 * - too-large: a format read in one piece (not .xlsx) exceeds the size cap;
 *   converting it to .xlsx first makes it readable.
 * - encrypted: the workbook is password-protected.
 * - unreadable: not a spreadsheet, or damaged.
 */
export type SpreadsheetErrorCode = "too-large" | "encrypted" | "unreadable";

/** A failure whose message can be shown to the user as is. */
export class SpreadsheetError extends Error {
  readonly code: SpreadsheetErrorCode;

  constructor(code: SpreadsheetErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SpreadsheetError";
    this.code = code;
  }
}
