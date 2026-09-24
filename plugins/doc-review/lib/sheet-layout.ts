// Pure layout of the spreadsheet grid: which rows and columns are drawn and
// where, how merged ranges and overflowing text land among them, and which
// cell edges carry borders. No DOM and no React, so it runs in node tests; the
// view in components/spreadsheet turns the result into a table.
//
// Positions: hidden rows and columns are dropped, and the remaining ones are
// numbered 0..n-1 top to bottom and left to right. Everything below speaks in
// those drawn positions unless a name says "sheet".
import type {
  CellKind,
  CellStyle,
  SheetCell,
  SheetData,
  SheetRow,
} from "./sheet-model";

/** Excel's default row height, 15pt, when a sheet does not say. */
export const DEFAULT_ROW_HEIGHT = 20;
/** Excel's default column width, 8.43 characters of Calibri 11. */
export const DEFAULT_COL_WIDTH = 64;
/** Excel's default font size, pt. */
const DEFAULT_FONT_SIZE_PT = 11;
/** Row height Excel fits to a font, relative to the font's size in px. */
const AUTO_ROW_HEIGHT_RATIO = 1.31;
/**
 * How far left-aligned text may run past the last column into the empty
 * grid beyond it, px; the edge of the grid clips it.
 */
export const OPEN_SPILL = 4096;

/** Key of a sheet cell in lookup maps; Excel has at most 16,384 columns. */
const COLUMN_STRIDE = 16_384;

export function cellKey(row: number, col: number): number {
  return row * COLUMN_STRIDE + col;
}

/** Excel's name of a 0-based column: 0 → A, 25 → Z, 26 → AA, 702 → AAA. */
export function columnLetter(index: number): string {
  let rest = Math.floor(index);
  if (!(rest >= 0)) return "";
  let name = "";
  while (rest >= 0) {
    name = String.fromCharCode(65 + (rest % 26)) + name;
    rest = Math.floor(rest / 26) - 1;
  }
  return name;
}

export type HorizontalAlign = "left" | "center" | "right" | "justify";

/** Excel's "general" alignment: numbers and dates right, text left, the rest centered. */
export function defaultAlignment(kind: CellKind): "left" | "center" | "right" {
  switch (kind) {
    case "number":
    case "date":
      return "right";
    case "string":
      return "left";
    default:
      return "center";
  }
}

export function cellAlignment(
  kind: CellKind,
  style: CellStyle | undefined,
): HorizontalAlign {
  return style?.horizontal ?? defaultAlignment(kind);
}

const BORDER_KEYWORD_WIDTHS: Record<string, number> = {
  thin: 1,
  medium: 3,
  thick: 5,
};

/** Width in px of a CSS border shorthand such as "2px solid #000000"; 0 when there is none. */
export function borderWidth(border: string | undefined): number {
  if (!border) return 0;
  const words = border.trim().toLowerCase().split(/\s+/);
  if (words.includes("none") || words.includes("hidden")) return 0;
  for (const word of words) {
    const px = /^(\d*\.?\d+)px$/.exec(word);
    if (px) return Number(px[1]);
    const keyword = BORDER_KEYWORD_WIDTHS[word];
    if (keyword !== undefined) return keyword;
  }
  // A bare style such as "solid" takes CSS's initial width, medium.
  return 3;
}

/** Width of the row-number column for a sheet whose last row is `lastRowNumber`. */
export function rowHeaderWidth(lastRowNumber: number): number {
  const digits = String(Math.max(1, Math.floor(lastRowNumber))).length;
  return Math.max(34, 12 + digits * 7);
}

export interface SheetLayout {
  sheet: SheetData;
  /** Sheet row index of each drawn row, top to bottom. */
  rows: number[];
  /** Sheet column index of each drawn column, left to right. */
  cols: number[];
  rowHeights: number[];
  colWidths: number[];
  /** rowTops[i] is the top of drawn row i; the last entry is the total height. */
  rowTops: number[];
  /** colLefts[i] is the left of drawn column i; the last entry is the total width. */
  colLefts: number[];
  /** Drawn position of each sheet row, -1 when it is hidden. */
  rowPosition: Int32Array;
  /** Drawn position of each sheet column, -1 when it is hidden. */
  colPosition: Int32Array;
  /** Drawn rows and columns inside the sheet's frozen pane. */
  frozenRows: number;
  frozenCols: number;
  defaultRowHeight: number;
  defaultColWidth: number;
  /** Cells by `cellKey`, hidden rows and columns included. */
  cells: Map<number, SheetCell>;
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * A row without a height of its own grows to fit its largest font, as Excel
 * fits such rows when it opens the file. Wrapped text is not measured.
 */
function autoRowHeight(
  row: SheetRow | undefined,
  styles: SheetData["styles"],
  fallback: number,
): number {
  let height = fallback;
  for (const cell of row?.cells ?? []) {
    if (cell.text === "" || cell.style === undefined) continue;
    const size = styles[cell.style]?.fontSize;
    if (size !== undefined && size > DEFAULT_FONT_SIZE_PT) {
      height = Math.max(
        height,
        Math.round(((size * 4) / 3) * AUTO_ROW_HEIGHT_RATIO),
      );
    }
  }
  return height;
}

/**
 * Rounds a size down to 1/64 px, the unit browsers lay tables out in, so the
 * spacers that stand in for unrendered rows add up exactly like the rows.
 */
function layoutUnits(size: number): number {
  return Math.floor(size * 64) / 64;
}

function prefixSums(sizes: number[]): number[] {
  const sums = new Array<number>(sizes.length + 1);
  sums[0] = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    sums[index + 1] = sums[index] + sizes[index];
  }
  return sums;
}

/** Resolves sizes, hidden rows and columns, and the frozen pane once per sheet. */
export function buildSheetLayout(sheet: SheetData): SheetLayout {
  const rowCount = Math.max(0, Math.floor(sheet.rowCount));
  const colCount = Math.max(0, Math.floor(sheet.colCount));
  const defaultRowHeight = positiveOr(
    sheet.defaultRowHeight,
    DEFAULT_ROW_HEIGHT,
  );
  const defaultColWidth = positiveOr(sheet.defaultColWidth, DEFAULT_COL_WIDTH);

  const rowInfo = new Map<number, SheetRow>();
  const cells = new Map<number, SheetCell>();
  for (const row of sheet.rows) {
    if (row.row < 0 || row.row >= rowCount) continue;
    rowInfo.set(row.row, row);
    for (const cell of row.cells) {
      if (cell.col < 0 || cell.col >= colCount) continue;
      cells.set(cellKey(row.row, cell.col), cell);
    }
  }

  const hiddenCols = new Set(sheet.hiddenCols);
  const cols: number[] = [];
  const colWidths: number[] = [];
  const colPosition = new Int32Array(colCount).fill(-1);
  for (let col = 0; col < colCount; col += 1) {
    const width = layoutUnits(sheet.colWidths[col] ?? defaultColWidth);
    // Excel also hides a column by giving it no width.
    if (hiddenCols.has(col) || !(width > 0)) continue;
    colPosition[col] = cols.length;
    cols.push(col);
    colWidths.push(width);
  }

  const rows: number[] = [];
  const rowHeights: number[] = [];
  const rowPosition = new Int32Array(rowCount).fill(-1);
  for (let row = 0; row < rowCount; row += 1) {
    const info = rowInfo.get(row);
    const height = layoutUnits(
      info?.height ?? autoRowHeight(info, sheet.styles, defaultRowHeight),
    );
    if (info?.hidden || !(height > 0)) continue;
    rowPosition[row] = rows.length;
    rows.push(row);
    rowHeights.push(height);
  }

  return {
    sheet,
    rows,
    cols,
    rowHeights,
    colWidths,
    rowTops: prefixSums(rowHeights),
    colLefts: prefixSums(colWidths),
    rowPosition,
    colPosition,
    frozenRows: countBelow(rows, sheet.frozenRows),
    frozenCols: countBelow(cols, sheet.frozenCols),
    defaultRowHeight,
    defaultColWidth,
    cells,
  };
}

/** How many of the ascending `indexes` fall below `limit`. */
function countBelow(indexes: number[], limit: number): number {
  let count = 0;
  while (count < indexes.length && indexes[count] < limit) count += 1;
  return count;
}

export function styleOf(
  layout: SheetLayout,
  cell: SheetCell | undefined,
): CellStyle | undefined {
  return cell?.style === undefined
    ? undefined
    : layout.sheet.styles[cell.style];
}

/** The cell at a drawn position. */
export function cellAt(
  layout: SheetLayout,
  rowPos: number,
  colPos: number,
): SheetCell | undefined {
  const row = layout.rows[rowPos];
  const col = layout.cols[colPos];
  if (row === undefined || col === undefined) return undefined;
  return layout.cells.get(cellKey(row, col));
}

function styleAt(
  layout: SheetLayout,
  rowPos: number,
  colPos: number,
): CellStyle | undefined {
  return styleOf(layout, cellAt(layout, rowPos, colPos));
}

/** Drawn position of the last entry of `offsets` (prefix sums) at or above `y`. */
export function positionAt(offsets: number[], y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle] <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Sticky offsets of the first `count` entries: each starts where the
 * previous ones end, after a `lead` such as the header row.
 */
export function frozenOffsets(
  sizes: number[],
  count: number,
  lead: number,
): number[] {
  const offsets: number[] = [];
  let offset = lead;
  for (let index = 0; index < count && index < sizes.length; index += 1) {
    offsets.push(offset);
    offset += sizes[index];
  }
  return offsets;
}

/**
 * Keeps a frozen pane only while it leaves most of the viewport scrolling —
 * a pane wider than a narrow panel would leave nothing else to see. `offsets`
 * are prefix sums, `lead` the header in front of the pane, all unzoomed px.
 * An unmeasured viewport (0) keeps the pane.
 */
export function fitFrozen(
  offsets: number[],
  count: number,
  lead: number,
  viewport: number,
  zoom: number,
  maxShare = 0.6,
): number {
  if (count <= 0) return 0;
  if (!(viewport > 0)) return count;
  const size = (lead + (offsets[count] ?? 0)) * zoom;
  return size <= viewport * maxShare ? count : 0;
}

/** Zoom levels the view steps through, as fractions. */
export const ZOOM_LEVELS = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
] as const;

/** The next zoom level in `direction` (1 in, -1 out), clamped to the range. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    return (
      ZOOM_LEVELS.find((level) => level > zoom + 1e-6) ??
      ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
    );
  }
  for (let index = ZOOM_LEVELS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_LEVELS[index] < zoom - 1e-6) return ZOOM_LEVELS[index];
  }
  return ZOOM_LEVELS[0];
}

// --- Merged ranges ---------------------------------------------------------

/**
 * One drawn piece of a merged range. A range crossing the freeze line is cut
 * in up to four parts, so the frozen part stays put and the rest scrolls;
 * every part shows the same content, offset to where it sits in the range.
 */
export interface MergePart {
  /** Top-left drawn position of this part. */
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  /** The whole range in drawn positions, inclusive. */
  top: number;
  left: number;
  bottom: number;
  right: number;
  /** This part's offset inside the whole range, px. */
  offsetX: number;
  offsetY: number;
  /** Size of the whole range, px. */
  width: number;
  height: number;
  /** Sheet position of the cell holding the range's content and style. */
  sourceRow: number;
  sourceCol: number;
}

/** Drawn columns `from..to` of one row covered by a merge part. */
export interface MergeRun {
  from: number;
  to: number;
  part: MergePart;
  /** This row is the part's first: the part is drawn here. */
  anchor: boolean;
}

export interface MergeIndex {
  /** Merge runs per drawn row, ascending by column. */
  byRow: Map<number, MergeRun[]>;
  parts: MergePart[];
}

/** First and last drawn positions among sheet indexes `from..to`, or null when all are hidden. */
function drawnRange(
  positions: Int32Array,
  from: number,
  to: number,
): [number, number] | null {
  let first = -1;
  let last = -1;
  const end = Math.min(to, positions.length - 1);
  for (let index = Math.max(0, from); index <= end; index += 1) {
    const position = positions[index];
    if (position < 0) continue;
    if (first < 0) first = position;
    last = position;
  }
  return first < 0 ? null : [first, last];
}

/** Splits `start..end` at `cut` when the range crosses it. */
function splitAt(start: number, end: number, cut: number): [number, number][] {
  return start < cut && cut <= end
    ? [
        [start, cut - 1],
        [cut, end],
      ]
    : [[start, end]];
}

function overlapsRuns(
  byRow: Map<number, MergeRun[]>,
  top: number,
  bottom: number,
  left: number,
  right: number,
): boolean {
  for (let row = top; row <= bottom; row += 1) {
    for (const run of byRow.get(row) ?? []) {
      if (run.from <= right && left <= run.to) return true;
    }
  }
  return false;
}

/**
 * Maps merged ranges onto drawn positions: spans shrink by the hidden rows and
 * columns they cover, and ranges crossing the freeze line are cut there.
 * Overlapping ranges, which Excel refuses to write, keep the first one.
 */
export function buildMergeIndex(
  layout: SheetLayout,
  frozenRows: number,
  frozenCols: number,
): MergeIndex {
  const byRow = new Map<number, MergeRun[]>();
  const parts: MergePart[] = [];
  for (const merge of layout.sheet.merges) {
    if (merge.rowSpan < 1 || merge.colSpan < 1) continue;
    const rowRange = drawnRange(
      layout.rowPosition,
      merge.row,
      merge.row + merge.rowSpan - 1,
    );
    const colRange = drawnRange(
      layout.colPosition,
      merge.col,
      merge.col + merge.colSpan - 1,
    );
    if (!rowRange || !colRange) continue;
    const [top, bottom] = rowRange;
    const [left, right] = colRange;
    // A single visible cell left of a range still shows the range's content.
    if (
      top === bottom &&
      left === right &&
      merge.rowSpan * merge.colSpan === 1
    ) {
      continue;
    }
    if (overlapsRuns(byRow, top, bottom, left, right)) continue;

    const width = layout.colLefts[right + 1] - layout.colLefts[left];
    const height = layout.rowTops[bottom + 1] - layout.rowTops[top];
    for (const [rowStart, rowEnd] of splitAt(top, bottom, frozenRows)) {
      for (const [colStart, colEnd] of splitAt(left, right, frozenCols)) {
        const part: MergePart = {
          row: rowStart,
          col: colStart,
          rowSpan: rowEnd - rowStart + 1,
          colSpan: colEnd - colStart + 1,
          top,
          left,
          bottom,
          right,
          offsetX: layout.colLefts[colStart] - layout.colLefts[left],
          offsetY: layout.rowTops[rowStart] - layout.rowTops[top],
          width,
          height,
          sourceRow: merge.row,
          sourceCol: merge.col,
        };
        parts.push(part);
        for (let row = rowStart; row <= rowEnd; row += 1) {
          let runs = byRow.get(row);
          if (!runs) {
            runs = [];
            byRow.set(row, runs);
          }
          runs.push({
            from: colStart,
            to: colEnd,
            part,
            anchor: row === rowStart,
          });
        }
      }
    }
  }
  for (const runs of byRow.values()) runs.sort((a, b) => a.from - b.from);
  return { byRow, parts };
}

/** The merge run covering drawn position (row, col), if any. */
export function mergeRunAt(
  index: MergeIndex,
  row: number,
  col: number,
): MergeRun | undefined {
  for (const run of index.byRow.get(row) ?? []) {
    if (run.from <= col && col <= run.to) return run;
    if (run.from > col) break;
  }
  return undefined;
}

/**
 * The smallest row count at or above `count` that cuts no merged part in
 * two, so rendered rows never end inside a row span.
 */
export function safeRowCount(
  index: MergeIndex,
  count: number,
  total: number,
): number {
  let end = Math.min(Math.max(0, count), total);
  for (;;) {
    let reach = end;
    for (const run of index.byRow.get(end - 1) ?? []) {
      reach = Math.max(reach, run.part.row + run.part.rowSpan);
    }
    if (reach <= end) return end;
    end = Math.min(reach, total);
  }
}

/**
 * The largest row at or below `start` where no merged part begins above
 * and continues below, so rendered rows never start inside a row span.
 */
export function safeRowStart(index: MergeIndex, start: number): number {
  let begin = Math.max(0, start);
  for (;;) {
    let reach = begin;
    for (const run of index.byRow.get(begin) ?? []) {
      reach = Math.min(reach, run.part.row);
    }
    if (reach >= begin) return begin;
    begin = reach;
  }
}

/** Drawn rows `start..end-1` kept in the DOM. */
export interface RowWindow {
  start: number;
  end: number;
}

/**
 * Which rows to render for a viewport showing sheet offsets `top..bottom`
 * (unzoomed px below the header). The window reaches `overscan` px past both
 * edges, snapped to `chunk` rows, and only moves once the viewport comes
 * within `margin` rows of its edges, so small scrolls re-render nothing.
 */
export function nextRowWindow(
  current: RowWindow,
  rowTops: number[],
  top: number,
  bottom: number,
  options: { overscan: number; margin: number; chunk: number },
): RowWindow {
  const total = rowTops.length - 1;
  if (total <= 0)
    return current.start === 0 && current.end === 0
      ? current
      : { start: 0, end: 0 };
  const first = positionAt(rowTops, top);
  const last = positionAt(rowTops, bottom);
  const covered =
    (current.start === 0 || current.start <= first - options.margin) &&
    (current.end >= total || current.end > last + options.margin) &&
    current.start <= first &&
    current.end > last;
  if (covered) return current;
  const chunk = Math.max(1, Math.floor(options.chunk));
  const start =
    Math.floor(positionAt(rowTops, top - options.overscan) / chunk) * chunk;
  const end = Math.min(
    total,
    Math.ceil((positionAt(rowTops, bottom + options.overscan) + 1) / chunk) *
      chunk,
  );
  return start === current.start && end === current.end
    ? current
    : { start, end };
}

// --- Rows ------------------------------------------------------------------

/** What a drawn cell shows. */
export interface PieceContent {
  /** The cell whose text is shown: the cell itself, a merge's first cell, or a frozen neighbour whose text continues here. */
  cell: SheetCell;
  /** Font and alignment of the text. */
  style: CellStyle | undefined;
  align: HorizontalAlign;
  /** px the text may run past the piece on the left and on the right. */
  spillBefore: number;
  spillAfter: number;
  /** The text flows in from a frozen cell on the left, past the freeze line. */
  continued: boolean;
  /**
   * The cells the text runs over have no fill and no vertical borders, so
   * the text may hide the gridlines under it the way Excel does.
   */
  clearSpill: boolean;
}

export interface CellPiece {
  type: "cell";
  /** First drawn column. */
  col: number;
  colSpan: number;
  rowSpan: number;
  /** Fill and borders of the drawn box. */
  style: CellStyle | undefined;
  content: PieceContent | null;
  merge: MergePart | null;
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
}

/** An empty column: only gridlines and borders. */
export interface GapPiece {
  type: "gap";
  col: number;
  borderRight?: string;
  borderBottom?: string;
}

export type RowPiece = CellPiece | GapPiece;

export interface RowLayoutOptions {
  /** Drawn columns left of the freeze line. */
  frozenCols: number;
}

interface Spill {
  before: number;
  after: number;
  clear: boolean;
}

function hasText(cell: SheetCell | undefined): cell is SheetCell {
  return cell !== undefined && cell.text !== "";
}

/** The right border of a merged range, from its top row's last cell. */
function mergeRightBorder(
  layout: SheetLayout,
  part: MergePart,
): string | undefined {
  return styleAt(layout, part.top, part.right)?.borderRight;
}

/** The bottom border of a merged range, from its bottom row's first cell. */
function mergeBottomBorder(
  layout: SheetLayout,
  part: MergePart,
): string | undefined {
  return styleAt(layout, part.bottom, part.left)?.borderBottom;
}

/**
 * Splits one drawn row into the cells to render: plain cells, merge parts
 * and empty columns. Also works out text overflow and borders.
 *
 * Borders: every boundary is drawn once, by the cell on its left or above,
 * as that cell's right or bottom border — its own, else the neighbour's left
 * or top border. A cell draws its own top or left border only at the grid's
 * edge or next to a merged range, which does not draw a neighbour's border.
 */
export function layoutRow(
  layout: SheetLayout,
  merges: MergeIndex,
  pos: number,
  options: RowLayoutOptions,
): RowPiece[] {
  const count = layout.cols.length;
  const sheetRow = layout.rows[pos];
  if (sheetRow === undefined || count === 0) return [];
  const frozen = Math.min(Math.max(0, options.frozenCols), count);
  const lefts = layout.colLefts;

  const here = new Array<SheetCell | undefined>(count);
  for (let col = 0; col < count; col += 1) {
    here[col] = layout.cells.get(cellKey(sheetRow, layout.cols[col]));
  }
  const runs = merges.byRow.get(pos) ?? [];
  const merged = new Uint8Array(count);
  for (const run of runs) merged.fill(1, run.from, run.to + 1);

  const free = (col: number) => merged[col] === 0 && !hasText(here[col]);
  /** Columns `from..to` hold no fill and no vertical border. */
  const plain = (from: number, to: number) => {
    for (let col = from; col <= to; col += 1) {
      const style = styleOf(layout, here[col]);
      if (style?.background || style?.borderLeft || style?.borderRight)
        return false;
    }
    return true;
  };

  // Overflowing text, like Excel: strings that do not wrap run over empty
  // neighbours — right when left-aligned, left when right-aligned, both ways
  // when centered — up to the next cell with text or a merged range. Text in
  // a frozen column stops at the freeze line and continues past it in the
  // first scrolling column, so it scrolls away there like in Excel's panes.
  const spills = new Map<number, Spill>();
  let continuation: { at: number; origin: number; spill: Spill } | null = null;
  for (let col = 0; col < count; col += 1) {
    const cell = here[col];
    if (!hasText(cell) || merged[col] || cell.kind !== "string") continue;
    const style = styleOf(layout, cell);
    if (style?.wrap) continue;
    const align = cellAlignment(cell.kind, style);
    if (align === "justify") continue;
    const isFrozen = col < frozen;

    let rightEnd = col;
    while (rightEnd + 1 < count && free(rightEnd + 1)) rightEnd += 1;
    const open = rightEnd === count - 1;
    let leftEnd = col;
    const leftLimit = isFrozen ? 0 : frozen;
    while (leftEnd - 1 >= leftLimit && free(leftEnd - 1)) leftEnd -= 1;

    if (align === "left") {
      if (isFrozen && frozen < count && rightEnd >= frozen) {
        const after = lefts[frozen] - lefts[col + 1];
        const clear = !style?.borderRight && plain(col + 1, rightEnd);
        if (after > 0) spills.set(col, { before: 0, after, clear });
        continuation = {
          at: frozen,
          origin: col,
          spill: {
            before: lefts[frozen] - lefts[col],
            after:
              lefts[rightEnd + 1] - lefts[frozen + 1] + (open ? OPEN_SPILL : 0),
            clear,
          },
        };
      } else {
        const limit = isFrozen ? Math.min(rightEnd, frozen - 1) : rightEnd;
        const after =
          lefts[limit + 1] -
          lefts[col + 1] +
          (open && !isFrozen ? OPEN_SPILL : 0);
        if (after > 0) {
          spills.set(col, {
            before: 0,
            after,
            clear: !style?.borderRight && plain(col + 1, limit),
          });
        }
      }
    } else if (align === "right") {
      const before = lefts[col] - lefts[leftEnd];
      if (before > 0) {
        spills.set(col, {
          before,
          after: 0,
          clear: !style?.borderLeft && plain(leftEnd, col - 1),
        });
      }
    } else {
      const limit = isFrozen ? Math.min(rightEnd, frozen - 1) : rightEnd;
      const after =
        lefts[limit + 1] -
        lefts[col + 1] +
        (open && !isFrozen ? OPEN_SPILL : 0);
      const side = Math.min(lefts[col] - lefts[leftEnd], after);
      if (side > 0) {
        spills.set(col, {
          before: side,
          after: side,
          clear:
            !style?.background &&
            !style?.borderLeft &&
            !style?.borderRight &&
            plain(leftEnd, col - 1) &&
            plain(col + 1, limit),
        });
      }
    }
  }

  const nextRow = pos + 1 < layout.rows.length ? pos + 1 : -1;
  const rightOf = (col: number, own: CellStyle | undefined) =>
    own?.borderRight ??
    (col + 1 < count ? styleOf(layout, here[col + 1])?.borderLeft : undefined);
  const bottomOf = (col: number, own: CellStyle | undefined) =>
    own?.borderBottom ??
    (nextRow >= 0 ? styleAt(layout, nextRow, col)?.borderTop : undefined);
  /** Own top border, drawn only where no cell above draws it. */
  const topOf = (col: number, own: CellStyle | undefined) => {
    if (!own?.borderTop) return undefined;
    if (pos === 0) return own.borderTop;
    const above = mergeRunAt(merges, pos - 1, col);
    return above && !mergeBottomBorder(layout, above.part)
      ? own.borderTop
      : undefined;
  };
  /** Own left border, drawn only where no cell on the left draws it. */
  const leftOf = (col: number, own: CellStyle | undefined) => {
    if (!own?.borderLeft) return undefined;
    if (col === 0) return own.borderLeft;
    const run = mergeRunAt(merges, pos, col - 1);
    return run && !mergeRightBorder(layout, run.part)
      ? own.borderLeft
      : undefined;
  };

  const pieces: RowPiece[] = [];
  let runIndex = 0;
  let col = 0;
  while (col < count) {
    if (merged[col]) {
      while (runIndex < runs.length && runs[runIndex].to < col) runIndex += 1;
      const run = runs[runIndex];
      if (run && run.from <= col) {
        if (run.anchor && run.from === col) pieces.push(mergePiece(run.part));
        col = run.to + 1;
        continue;
      }
    }
    const cell = here[col];
    const own = styleOf(layout, cell);
    if (continuation && continuation.at === col) {
      const origin = here[continuation.origin] as SheetCell;
      const originStyle = styleOf(layout, origin);
      pieces.push({
        type: "cell",
        col,
        colSpan: 1,
        rowSpan: 1,
        style: own,
        content: {
          cell: origin,
          style: originStyle,
          align: "left",
          spillBefore: continuation.spill.before,
          spillAfter: continuation.spill.after,
          continued: true,
          clearSpill: continuation.spill.clear && !own?.background,
        },
        merge: null,
        borderTop: topOf(col, own),
        borderRight: rightOf(col, own),
        borderBottom: bottomOf(col, own),
      });
      col += 1;
      continue;
    }
    if (cell) {
      const spill = spills.get(col);
      pieces.push({
        type: "cell",
        col,
        colSpan: 1,
        rowSpan: 1,
        style: own,
        content: hasText(cell)
          ? {
              cell,
              style: own,
              align: cellAlignment(cell.kind, own),
              spillBefore: spill?.before ?? 0,
              spillAfter: spill?.after ?? 0,
              continued: false,
              clearSpill: spill?.clear ?? false,
            }
          : null,
        merge: null,
        borderTop: topOf(col, own),
        borderRight: rightOf(col, own),
        borderBottom: bottomOf(col, own),
        borderLeft: leftOf(col, own),
      });
      col += 1;
      continue;
    }

    pieces.push({
      type: "gap",
      col,
      borderRight: rightOf(col, undefined),
      borderBottom: bottomOf(col, undefined),
    });
    col += 1;
  }
  return pieces;

  function mergePiece(part: MergePart): CellPiece {
    const source = layout.cells.get(cellKey(part.sourceRow, part.sourceCol));
    const style = styleOf(layout, source);
    const lastCol = part.col + part.colSpan - 1;
    const lastRow = part.row + part.rowSpan - 1;
    const atTop = part.row === part.top;
    const atLeft = part.col === part.left;
    let borderTop: string | undefined;
    if (atTop && style?.borderTop) {
      const above = pos > 0 ? mergeRunAt(merges, pos - 1, part.col) : undefined;
      if (pos === 0 || (above && !mergeBottomBorder(layout, above.part))) {
        borderTop = style.borderTop;
      }
    }
    let borderLeft: string | undefined;
    if (atLeft && style?.borderLeft) {
      const beside =
        part.col > 0 ? mergeRunAt(merges, pos, part.col - 1) : undefined;
      if (
        part.col === 0 ||
        (beside && !mergeRightBorder(layout, beside.part))
      ) {
        borderLeft = style.borderLeft;
      }
    }
    return {
      type: "cell",
      col: part.col,
      colSpan: part.colSpan,
      rowSpan: part.rowSpan,
      style,
      content: hasText(source)
        ? {
            cell: source,
            style,
            align: cellAlignment(source.kind, style),
            spillBefore: 0,
            spillAfter: 0,
            continued: false,
            clearSpill: false,
          }
        : null,
      merge: part,
      borderTop,
      borderLeft,
      borderRight:
        lastCol === part.right ? mergeRightBorder(layout, part) : undefined,
      borderBottom:
        lastRow === part.bottom ? mergeBottomBorder(layout, part) : undefined,
    };
  }
}
