// Wire model of the spreadsheet view: what the backend sends for one sheet
// and what the grid renders. Shared by both sides, so it holds only types and
// constants — no Node or DOM imports.

/** Rows past this are cut; the view says how many the sheet really has. */
export const SHEET_ROW_LIMIT = 5000;
/** Columns past this are cut. */
export const SHEET_COLUMN_LIMIT = 200;
/** Non-empty cells per sheet; bounds one response and the grid's DOM. */
export const SHEET_CELL_LIMIT = 100_000;

export interface WorkbookSummary {
  sheets: SheetSummary[];
  /** The sheet Excel opens on; a visible worksheet whenever one exists. */
  activeSheet: number;
}

export interface SheetSummary {
  name: string;
  /** Hidden and very-hidden sheets are listed but not offered as tabs. */
  hidden: boolean;
  /** Chart and dialog sheets carry no cells to show. */
  kind: "worksheet" | "chartsheet" | "other";
}

/** A resolved cell style. Colors are CSS hex (`#rrggbb`); absent = default. */
export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Font color. */
  color?: string;
  /** Fill color. */
  background?: string;
  /** Points. */
  fontSize?: number;
  fontFamily?: string;
  /**
   * Absent means Excel's "general" alignment: numbers and dates right, text
   * left, booleans and errors centered.
   */
  horizontal?: "left" | "center" | "right" | "justify";
  vertical?: "top" | "middle" | "bottom";
  wrap?: boolean;
  /** Indent levels; Excel draws one level as about three characters. */
  indent?: number;
  /** CSS `border` shorthand per side, e.g. "1px solid #000000". */
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
}

export type CellKind = "string" | "number" | "boolean" | "error" | "date";

export interface SheetCell {
  /** 0-based column. */
  col: number;
  /** Text as Excel displays it, number format applied. Empty for a styled blank. */
  text: string;
  kind: CellKind;
  /** Index into `SheetData.styles`; absent for the default style. */
  style?: number;
  /** External link target; only http, https and mailto survive. */
  link?: string;
}

export interface SheetRow {
  /** 0-based row. */
  row: number;
  /** CSS px, when the sheet sets a height for this row. */
  height?: number;
  hidden?: boolean;
  /** Ascending by column; blanks without a style are omitted. */
  cells: SheetCell[];
}

export interface SheetMerge {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

export interface SheetData {
  index: number;
  name: string;
  /** The grid covers rows 0..rowCount-1 and columns 0..colCount-1. */
  rowCount: number;
  colCount: number;
  /** Rows and columns with content in the whole sheet, past the limits too. */
  totalRows: number;
  totalCols: number;
  /** True when rows, columns or cells were cut to the limits. */
  truncated: boolean;
  /** CSS px. */
  defaultRowHeight: number;
  defaultColWidth: number;
  /** CSS px per column, length colCount; null means defaultColWidth. */
  colWidths: (number | null)[];
  /** Ascending indexes of columns the sheet hides. */
  hiddenCols: number[];
  /** Sparse and ascending by row; a row absent here is empty at default height. */
  rows: SheetRow[];
  /** Merged ranges, clipped to the grid. */
  merges: SheetMerge[];
  /** Frozen pane: rows at the top and columns at the left that stay in place. */
  frozenRows: number;
  frozenCols: number;
  showGridLines: boolean;
  /** Style table referenced by `SheetCell.style`. */
  styles: CellStyle[];
}
