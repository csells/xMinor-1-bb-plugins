// The fallback reader for everything that is not SpreadsheetML: BIFF .xls,
// .xlsb, OpenDocument, and the HTML or SpreadsheetML-2003 files that many
// systems export under an .xls name.
//
// SheetJS parses a whole file synchronously on the event loop, so files over
// SHEETJS_MAX_BYTES are refused rather than stalling bb — converting them to
// .xlsx lets the native reader stream them instead. SheetJS Community keeps
// fills but no fonts, borders or alignment, hence fidelity "basic".
import { readFile, stat } from "node:fs/promises";
import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import {
  SHEET_CELL_LIMIT,
  SHEET_COLUMN_LIMIT,
  SHEET_ROW_LIMIT,
  type CellKind,
  type CellStyle,
  type SheetCell,
  type SheetData,
  type SheetMerge,
  type SheetRow,
  type SheetSummary,
  type WorkbookSummary,
} from "../../lib/sheet-model.js";
import { CellFormatter, isoToSerial, type PreparedFormat } from "./format.js";
import { Pacer } from "./pacer.js";
import { type SpreadsheetReader, SpreadsheetError } from "./types.js";
import { columnWidthToPx, emptySheet } from "./worksheet.js";

// Legacy workbooks store text in Windows code pages (1251 for Russian).
XLSX.set_cptable(cptable);

/** Largest file handed to SheetJS: its parse blocks the event loop for roughly 0.3 s per MB. */
export const SHEETJS_MAX_BYTES = 20 * 1024 * 1024;

/** BIFF error codes. */
const ERROR_TEXT: Readonly<Record<number, string>> = {
  0x00: "#NULL!",
  0x07: "#DIV/0!",
  0x0f: "#VALUE!",
  0x17: "#REF!",
  0x1d: "#NAME?",
  0x24: "#NUM!",
  0x2a: "#N/A",
  0x2b: "#GETTING_DATA",
};

const DEFAULT_ROW_HEIGHT_PX = 20;
const DEFAULT_COL_WIDTH_PX = 64;
const NO_CUSTOM_FORMATS: ReadonlyMap<number, string> = new Map();

type SheetJsCell = XLSX.CellObject & { s?: unknown; z?: string | number };

export async function openSheetJsWorkbook(
  filePath: string,
  options: { locale: string; signal?: AbortSignal },
): Promise<SpreadsheetReader> {
  const { size } = await stat(filePath);
  if (size > SHEETJS_MAX_BYTES) {
    throw new SpreadsheetError(
      "too-large",
      `This spreadsheet is ${(size / 1024 / 1024).toFixed(1)} MB. Files in this format are previewed up to ${
        SHEETJS_MAX_BYTES / 1024 / 1024
      } MB; save it as .xlsx to view it.`,
    );
  }
  const data = await readFile(filePath, { signal: options.signal });
  options.signal?.throwIfAborted();
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(data, {
      type: "buffer",
      dense: true,
      cellStyles: true,
      cellNF: true,
      cellText: false,
      cellFormula: false,
      cellHTML: false,
      cellDates: false,
      // HTML and text exports keep their text as written instead of being re-guessed as numbers.
      raw: true,
      sheetRows: SHEET_ROW_LIMIT,
      bookVBA: false,
    });
  } catch (error) {
    throw readError(error);
  }
  const formatter = new CellFormatter({
    locale: options.locale,
    date1904: workbook.Workbook?.WBProps?.date1904 === true,
  });
  return new SheetJsReader(workbook, formatter);
}

function readError(error: unknown): SpreadsheetError {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypt/i.test(message)) {
    return new SpreadsheetError("encrypted", "This spreadsheet is password-protected.", { cause: error });
  }
  return new SpreadsheetError("unreadable", "This file is not a spreadsheet the viewer can read, or it is damaged.", {
    cause: error,
  });
}

class SheetJsReader implements SpreadsheetReader {
  readonly summary: WorkbookSummary;
  readonly fidelity = "basic" as const;
  #workbook: XLSX.WorkBook | null;
  readonly #formatter: CellFormatter;

  constructor(workbook: XLSX.WorkBook, formatter: CellFormatter) {
    this.#workbook = workbook;
    this.#formatter = formatter;
    const properties = workbook.Workbook?.Sheets ?? [];
    const sheets: SheetSummary[] = workbook.SheetNames.map((name, index) => ({
      name,
      hidden: (properties[index]?.Hidden ?? 0) !== 0,
      kind: sheetKind(workbook.Sheets[name]),
    }));
    const visible = sheets.findIndex((sheet) => !sheet.hidden && sheet.kind === "worksheet");
    this.summary = { sheets, activeSheet: visible === -1 ? 0 : visible };
  }

  async readSheet(index: number, signal?: AbortSignal): Promise<SheetData> {
    const workbook = this.#workbook;
    if (!workbook) throw new Error("The spreadsheet has been closed.");
    const name = workbook.SheetNames[index];
    if (name === undefined) throw new RangeError(`The workbook has no sheet ${index}.`);
    const sheet = workbook.Sheets[name];
    if (!sheet || this.summary.sheets[index]?.kind === "chartsheet") return emptySheet(index, name);
    return convertSheet(sheet, index, name, this.#formatter, new Pacer(signal));
  }

  close(): void {
    this.#workbook = null;
  }
}

function sheetKind(sheet: XLSX.WorkSheet | undefined): SheetSummary["kind"] {
  const type: string | undefined = sheet?.["!type"];
  if (type === undefined || type === "sheet") return "worksheet";
  return type === "chart" ? "chartsheet" : "other";
}

async function convertSheet(
  sheet: XLSX.WorkSheet,
  index: number,
  name: string,
  formatter: CellFormatter,
  pacer: Pacer,
): Promise<SheetData> {
  const data: (SheetJsCell[] | undefined)[] = sheet["!data"] ?? [];
  const rowInfo = sheet["!rows"] ?? [];
  const fills = new FillTable();
  const rows: SheetRow[] = [];
  let emitted = 0;
  let cutRow = SHEET_ROW_LIMIT;
  let gridMaxRow = -1;
  let gridMaxCol = -1;
  let allMaxRow = -1;
  let allMaxCol = -1;

  const rowCount = Math.max(data.length, rowInfo.length);
  for (let r = 0; r < rowCount; r += 1) {
    const source = data[r];
    const info = rowInfo[r];
    if (!source && !info) continue;
    const cells: SheetCell[] = [];
    let rowContent = -1;
    let rowGridContent = -1;
    for (let c = 0; source && c < source.length; c += 1) {
      const cell = source[c];
      if (!cell) continue;
      const value = cellValue(cell, formatter);
      if (value) rowContent = c;
      if (c >= SHEET_COLUMN_LIMIT) continue;
      const style = fills.indexOf(cell.s);
      if (!value && style === -1) continue;
      if (value) rowGridContent = c;
      const out: SheetCell = { col: c, text: value?.text ?? "", kind: value?.kind ?? "string" };
      if (style !== -1) out.style = style;
      cells.push(out);
    }
    if (rowContent >= 0) {
      allMaxRow = r;
      allMaxCol = Math.max(allMaxCol, rowContent);
    }
    if (r >= cutRow) continue;
    if (emitted + cells.length > SHEET_CELL_LIMIT) {
      cutRow = r;
      continue;
    }
    emitted += cells.length;
    if (rowGridContent >= 0) {
      gridMaxRow = r;
      gridMaxCol = Math.max(gridMaxCol, rowGridContent);
    }
    const row: SheetRow = { row: r, cells };
    const height = info?.hpx ?? (info?.hpt !== undefined ? (info.hpt * 4) / 3 : undefined);
    if (height !== undefined && Number.isFinite(height) && height > 0) row.height = Math.round(height);
    if (info?.hidden) row.hidden = true;
    if (cells.length > 0 || row.height !== undefined || row.hidden) rows.push(row);
    if (r % 256 === 255) await pacer.pace();
  }

  const merges = (sheet["!merges"] ?? []).map((range) => ({
    top: range.s.r,
    left: range.s.c,
    bottom: range.e.r,
    right: range.e.c,
  }));
  let mergeRows = 0;
  let mergeCols = 0;
  for (const merge of merges) {
    if (merge.top >= cutRow || merge.left >= SHEET_COLUMN_LIMIT) continue;
    mergeRows = Math.max(mergeRows, Math.min(merge.bottom + 1, cutRow));
    mergeCols = Math.max(mergeCols, Math.min(merge.right + 1, SHEET_COLUMN_LIMIT));
  }
  const gridRows = Math.min(cutRow, Math.max(gridMaxRow + 1, mergeRows));
  const gridCols = Math.min(SHEET_COLUMN_LIMIT, Math.max(gridMaxCol + 1, mergeCols));

  // With sheetRows SheetJS stops early and keeps the declared range in !fullref.
  const full = sheet["!fullref"] ? XLSX.utils.decode_range(sheet["!fullref"]) : null;
  const cut = full !== null && full.e.r + 1 > data.length;
  const totalRows = Math.max(allMaxRow + 1, gridRows, cut && full ? full.e.r + 1 : 0);
  const totalCols = Math.max(allMaxCol + 1, gridCols, cut && full ? full.e.c + 1 : 0);

  const colInfo = sheet["!cols"] ?? [];
  const colWidths: (number | null)[] = [];
  const hiddenCols: number[] = [];
  for (let c = 0; c < gridCols; c += 1) {
    colWidths.push(columnPx(colInfo[c]));
    if (colInfo[c]?.hidden) hiddenCols.push(c);
  }

  const gridRowsList: SheetRow[] = [];
  for (const row of rows) {
    if (row.row >= gridRows) break;
    const cells = row.cells.filter((cell) => cell.col < gridCols);
    if (cells.length === 0 && row.height === undefined && !row.hidden) continue;
    gridRowsList.push({ ...row, cells });
  }

  return {
    index,
    name,
    rowCount: gridRows,
    colCount: gridCols,
    totalRows,
    totalCols,
    truncated: cut || totalRows > gridRows || totalCols > gridCols,
    defaultRowHeight: DEFAULT_ROW_HEIGHT_PX,
    defaultColWidth: DEFAULT_COL_WIDTH_PX,
    colWidths,
    hiddenCols,
    rows: gridRowsList,
    merges: clip(merges, gridRows, gridCols),
    frozenRows: 0,
    frozenCols: 0,
    showGridLines: true,
    styles: fills.styles,
  };
}

function cellValue(cell: SheetJsCell, formatter: CellFormatter): { text: string; kind: CellKind } | null {
  switch (cell.t) {
    case "n": {
      if (typeof cell.v !== "number" || !Number.isFinite(cell.v)) return null;
      const format = formatOf(cell, formatter);
      return { text: formatter.number(cell.v, format), kind: isDate(format) ? "date" : "number" };
    }
    case "s": {
      const text = cell.v === undefined ? "" : String(cell.v);
      return text === "" ? null : { text: formatter.text(text, formatOf(cell, formatter)), kind: "string" };
    }
    case "b":
      return { text: formatter.boolean(cell.v === true), kind: "boolean" };
    case "e":
      return {
        text: typeof cell.v === "number" ? (ERROR_TEXT[cell.v] ?? "#N/A") : String(cell.w ?? cell.v ?? "#N/A"),
        kind: "error",
      };
    case "d": {
      const serial = cell.v instanceof Date ? dateToSerial(cell.v) : isoToSerial(String(cell.v ?? ""), false);
      if (!Number.isFinite(serial)) return null;
      const format = formatOf(cell, formatter);
      return { text: formatter.number(serial, isDate(format) ? format : formatter.dateFormatFor(serial)), kind: "date" };
    }
    default:
      return null;
  }
}

function formatOf(cell: SheetJsCell, formatter: CellFormatter): PreparedFormat {
  if (typeof cell.z === "string") return formatter.prepare(cell.z);
  if (typeof cell.z === "number") return formatter.formatForId(cell.z, NO_CUSTOM_FORMATS);
  return formatter.general;
}

function isDate(format: PreparedFormat): boolean {
  return format.kind === "date" || format.kind === "long-date" || format.kind === "long-time";
}

/** SheetJS builds dates from local wall-clock parts; count days the same way. */
function dateToSerial(date: Date): number {
  const time = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
  const serial = (time - Date.UTC(1899, 11, 30)) / 86_400_000;
  return serial < 61 ? serial - 1 : serial;
}

function columnPx(info: XLSX.ColInfo | undefined): number | null {
  if (!info) return null;
  if (info.wpx !== undefined && Number.isFinite(info.wpx)) return Math.round(info.wpx);
  if (info.width !== undefined && Number.isFinite(info.width)) return columnWidthToPx(info.width);
  if (info.wch !== undefined && Number.isFinite(info.wch)) return Math.round(info.wch * 7 + 5);
  return null;
}

function clip(
  merges: readonly { top: number; left: number; bottom: number; right: number }[],
  rowCount: number,
  colCount: number,
): SheetMerge[] {
  const clipped: SheetMerge[] = [];
  for (const merge of merges) {
    if (merge.top >= rowCount || merge.left >= colCount) continue;
    const bottom = Math.min(merge.bottom, rowCount - 1);
    const right = Math.min(merge.right, colCount - 1);
    if (bottom === merge.top && right === merge.left) continue;
    clipped.push({ row: merge.top, col: merge.left, rowSpan: bottom - merge.top + 1, colSpan: right - merge.left + 1 });
  }
  return clipped;
}

/** Background fills, the one style SheetJS Community reads, as a deduplicated table. */
class FillTable {
  readonly styles: CellStyle[] = [];
  readonly #byColor = new Map<string, number>();

  indexOf(style: unknown): number {
    const color = fillColor(style);
    if (!color) return -1;
    let index = this.#byColor.get(color);
    if (index === undefined) {
      index = this.styles.length;
      this.styles.push({ background: color });
      this.#byColor.set(color, index);
    }
    return index;
  }
}

function fillColor(style: unknown): string | undefined {
  if (!style || typeof style !== "object") return undefined;
  const { patternType, fgColor } = style as { patternType?: string; fgColor?: { rgb?: string } };
  if (!patternType || patternType === "none" || patternType === "gray125") return undefined;
  const rgb = fgColor?.rgb;
  if (typeof rgb !== "string") return undefined;
  const hex = rgb.length === 8 ? rgb.slice(2) : rgb;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : undefined;
}
