// Streams one worksheet part into the grid model.
//
// A sheet part can be hundreds of megabytes — Excel happily saves a million
// styled rows — so it is read in one pass with bounded state:
// 1. Inside the row, column and cell limits every `<c>` becomes a cell.
// 2. Past the limits, a skim searches the raw text for value tags only, to
//    learn how far real content goes (no tokenizing, no cell objects).
// 3. After `</sheetData>` the tokenizer resumes for merges and hyperlinks.
// The skim is capped in time and size; when the cap hits, the totals fall
// back to the sheet's `<dimension>`.
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
} from "../../lib/sheet-model.js";
import { type CellRange, columnOf, parseRange, rowOf } from "./cell-ref.js";
import { type CellFormatter, isoToSerial, type PreparedFormat } from "./format.js";
import type { Relationship } from "./package.js";
import type { Pacer } from "./pacer.js";
import { joinLineBreaks, type SharedStrings, textRun } from "./shared-strings.js";
import type { StyleSheet } from "./styles.js";
import {
  decodeOoxmlEscapes,
  isTrue,
  numberAttribute,
  type XmlAttributes,
  type XmlHandler,
  writePaced,
  XmlTextDecoder,
  XmlTokenizer,
} from "./xml.js";
import type { ZipArchive, ZipEntry } from "./zip.js";

/** How long the skim past the limits may run before the totals fall back to `<dimension>`. */
const SKIM_TIME_LIMIT_MS = 4_000;
/** How many bytes of XML the skim may read. */
const SKIM_BYTE_LIMIT = 768 * 1024 * 1024;
/** Bytes kept between skim chunks: covers a tag split by a chunk boundary and a formula between `<c>` and `<v>`. */
const SKIM_CARRY_BYTES = 16 * 1024;
/** Excel's defaults: 15 pt rows, 8-character columns. */
const DEFAULT_ROW_HEIGHT_PT = 15;
const DEFAULT_BASE_COL_WIDTH = 8;
/** Maximum digit width of the default font (Calibri 11) in px. */
const MAX_DIGIT_WIDTH = 7;

export interface WorksheetSource {
  zip: ZipArchive;
  /** The sheet part; undefined for a sheet whose part is missing. */
  entry: ZipEntry | undefined;
  index: number;
  name: string;
  styles: StyleSheet;
  sharedStrings: SharedStrings;
  formatter: CellFormatter;
  date1904: boolean;
  /** The sheet's relationships, loaded only when it has hyperlinks. */
  relationships(): Promise<readonly Relationship[]>;
}

/** `<col width>` (characters of the maximum digit width) to px, as Excel computes it. */
export function columnWidthToPx(width: number): number {
  return Math.trunc(((256 * width + Math.trunc(128 / MAX_DIGIT_WIDTH)) / 256) * MAX_DIGIT_WIDTH);
}

/** Default width from `baseColWidth`: characters plus 5 px of padding, rounded up to a multiple of 8 px. */
function baseColumnWidthToPx(characters: number): number {
  return Math.ceil((characters * MAX_DIGIT_WIDTH + 5) / 8) * 8;
}

function pointsToPx(points: number): number {
  return Math.round((points * 4) / 3);
}

export async function readWorksheet(source: WorksheetSource, pacer: Pacer): Promise<SheetData> {
  const parser = new SheetParser(source);
  if (source.entry) await scanSheet(source.zip, source.entry, parser, pacer);
  return assembleSheet(source, parser, pacer);
}

/** An empty grid, for chart sheets and missing parts. */
export function emptySheet(index: number, name: string): SheetData {
  return {
    index,
    name,
    rowCount: 0,
    colCount: 0,
    totalRows: 0,
    totalCols: 0,
    truncated: false,
    defaultRowHeight: pointsToPx(DEFAULT_ROW_HEIGHT_PT),
    defaultColWidth: baseColumnWidthToPx(DEFAULT_BASE_COL_WIDTH),
    colWidths: [],
    hiddenCols: [],
    rows: [],
    merges: [],
    frozenRows: 0,
    frozenCols: 0,
    showGridLines: true,
    styles: [],
  };
}

/**
 * Feeds the part through the tokenizer; once the grid is full the raw bytes
 * go to the skim instead, and after `</sheetData>` back to a tokenizer.
 */
async function scanSheet(zip: ZipArchive, entry: ZipEntry, parser: SheetParser, pacer: Pacer): Promise<void> {
  let decoder = new XmlTextDecoder();
  let tokenizer: XmlTokenizer | null = new XmlTokenizer(parser);
  let skimmer: ContentSkimmer | null = null;
  let skimStart = 0;
  let skimBytes = 0;
  parser.onLimit = () => {
    skimStart = performance.now();
    // The skim needs explicit cell references and UTF-8 bytes; otherwise the
    // tokenizer goes on in counting mode.
    if (!parser.implicitReferences && decoder.isUtf8) tokenizer?.stop();
  };

  /** Tokenizes text; hands over to the skim when the parser stops the tokenizer. */
  const tokenize = async (current: XmlTokenizer, text: string): Promise<boolean> => {
    const rest = await writePaced(current, text, pacer);
    if (!current.stopped) return true;
    tokenizer = null;
    skimmer = new ContentSkimmer(parser.prefix);
    return skim(skimmer, Buffer.from(rest, "utf8"));
  };
  /** Skims bytes; hands the part after `</sheetData>` to a fresh tokenizer. */
  const skim = async (current: ContentSkimmer, bytes: Buffer): Promise<boolean> => {
    const rest = current.feed(bytes);
    if (current.failed) return false;
    if (rest === null) return true;
    parser.absorbSkim(current);
    skimmer = null;
    // `</sheetData>` starts on a character boundary, so decoding restarts cleanly there.
    decoder = new XmlTextDecoder("utf-8");
    tokenizer = new XmlTokenizer(parser);
    return tokenize(tokenizer, decoder.decode(rest));
  };

  for await (const chunk of zip.read(entry, pacer.signal)) {
    let ok = true;
    if (skimmer) {
      skimBytes += chunk.length;
      ok = await skim(skimmer, chunk);
    } else if (tokenizer) {
      ok = await tokenize(tokenizer, decoder.decode(chunk));
    }
    if (!ok) {
      parser.extentCut = true;
      return;
    }
    if (!parser.materialize && (performance.now() - skimStart > SKIM_TIME_LIMIT_MS || skimBytes > SKIM_BYTE_LIMIT)) {
      parser.extentCut = true;
      return;
    }
    await pacer.pace();
  }
  if (tokenizer && !(await tokenize(tokenizer, decoder.end()))) parser.extentCut = true;
}

interface ScannedCell {
  col: number;
  /** Index into the workbook's cellXfs. */
  xf: number;
  kind: CellKind;
  text: string;
  /** A shared string still to load; -1 once `text` is final. */
  sst: number;
}

interface ScannedRow {
  row: number;
  /** Px; 0 means the sheet sets no height. */
  height: number;
  hidden: boolean;
  /** Row style that paints the row's blank cells; -1 for none. */
  xf: number;
  cells: ScannedCell[];
}

interface ColumnDefinition {
  first: number;
  last: number;
  width: number | undefined;
  hidden: boolean;
}

interface Hyperlink {
  range: CellRange;
  id: string;
  location: string | undefined;
}

/** SAX handler for a worksheet part. */
class SheetParser implements XmlHandler {
  readonly #styles: StyleSheet;
  readonly #strings: SharedStrings;
  readonly #formatter: CellFormatter;
  readonly #date1904: boolean;

  // What the sheet declares.
  dimension: CellRange | null = null;
  frozenRows = 0;
  frozenCols = 0;
  showGridLines = true;
  defaultRowHeightPt = DEFAULT_ROW_HEIGHT_PT;
  defaultColWidth: number | undefined;
  baseColWidth = DEFAULT_BASE_COL_WIDTH;
  readonly columns: ColumnDefinition[] = [];
  readonly rows: ScannedRow[] = [];
  readonly merges: CellRange[] = [];
  readonly hyperlinks: Hyperlink[] = [];
  /** Namespace prefix of the cell elements (`x:` from .NET writers). */
  prefix = "";

  // Where content is: inside the grid's limits, and anywhere in the sheet.
  gridMaxRow = -1;
  gridMaxCol = -1;
  allMaxRow = -1;
  allMaxCol = -1;

  /** Cells become objects only until a limit hits. */
  materialize = true;
  /** First row left out of the grid. */
  cutRow = SHEET_ROW_LIMIT;
  /** Content past the limits was not fully scanned; totals fall back to `<dimension>`. */
  extentCut = false;
  /** A row or cell without `r` was seen; the skim cannot place cells then. */
  implicitReferences = false;
  /** Rows and cells arrived in ascending order (every writer we know). */
  ordered = true;
  onLimit: (() => void) | null = null;

  #emitted = 0;
  #phase: "before" | "data" | "after" = "before";
  #sheetViews = 0;
  #inFirstView = false;

  #row: ScannedRow | null = null;
  #rowIndex = -1;
  #rowContentCol = -1;
  #rowGridContentCol = -1;
  #column = -1;

  #inCell = false;
  #cellCol = 0;
  #cellXf = 0;
  #cellType = "n";
  #value: string | undefined;
  #inline: string[] | null = null;
  #inInline = false;
  #inPhonetic = false;
  #preserve = false;
  #capture: "v" | "t" | null = null;

  constructor(source: WorksheetSource) {
    this.#styles = source.styles;
    this.#strings = source.sharedStrings;
    this.#formatter = source.formatter;
    this.#date1904 = source.date1904;
  }

  open(name: string, attributes: XmlAttributes, prefix: string): boolean {
    if (this.#phase === "data") return this.#openInData(name, attributes);
    if (this.#phase === "before") this.#openBeforeData(name, attributes, prefix);
    else this.#openAfterData(name, attributes);
    return false;
  }

  text(text: string): void {
    if (this.#capture === "v") this.#value = (this.#value ?? "") + text;
    else if (this.#capture === "t") this.#inline?.push(textRun(text, this.#preserve));
    this.#capture = null;
  }

  close(name: string): void {
    if (this.#phase === "data") {
      switch (name) {
        case "c":
          this.#finishCell();
          break;
        case "row":
          this.#finishRow();
          break;
        case "is":
          this.#inInline = false;
          break;
        case "rPh":
          this.#inPhonetic = false;
          break;
        case "sheetData":
          this.#phase = "after";
          break;
        default:
          break;
      }
    } else if (name === "sheetView") {
      this.#inFirstView = false;
    }
  }

  /** Content the skim found past the limits. */
  absorbSkim(skimmer: ContentSkimmer): void {
    this.allMaxRow = Math.max(this.allMaxRow, skimmer.maxRow);
    this.allMaxCol = Math.max(this.allMaxCol, skimmer.maxCol);
  }

  #openBeforeData(name: string, attributes: XmlAttributes, prefix: string): void {
    switch (name) {
      case "dimension":
        this.dimension = parseRange(attributes.ref);
        break;
      case "sheetView":
        // Only the first view is the one Excel opens with.
        this.#sheetViews += 1;
        this.#inFirstView = this.#sheetViews === 1;
        if (this.#inFirstView && attributes.showGridLines !== undefined) {
          this.showGridLines = isTrue(attributes.showGridLines);
        }
        break;
      case "pane":
        if (this.#inFirstView && (attributes.state === "frozen" || attributes.state === "frozenSplit")) {
          this.frozenCols = paneCount(attributes.xSplit);
          this.frozenRows = paneCount(attributes.ySplit);
        }
        break;
      case "sheetFormatPr": {
        const height = numberAttribute(attributes.defaultRowHeight);
        if (height !== undefined && height > 0) this.defaultRowHeightPt = height;
        const width = numberAttribute(attributes.defaultColWidth);
        if (width !== undefined && width > 0) this.defaultColWidth = width;
        const base = numberAttribute(attributes.baseColWidth);
        if (base !== undefined && base > 0) this.baseColWidth = base;
        break;
      }
      case "col": {
        const first = numberAttribute(attributes.min);
        const last = numberAttribute(attributes.max) ?? first;
        if (first === undefined || last === undefined || first < 1) break;
        const width = numberAttribute(attributes.width);
        this.columns.push({
          first: first - 1,
          last: last - 1,
          width: width !== undefined && width > 0 ? width : undefined,
          hidden: isTrue(attributes.hidden) || width === 0,
        });
        break;
      }
      case "sheetData":
        this.#phase = "data";
        this.prefix = prefix;
        break;
      default:
        break;
    }
  }

  #openInData(name: string, attributes: XmlAttributes): boolean {
    switch (name) {
      case "row":
        this.#startRow(attributes);
        return false;
      case "c":
        this.#startCell(attributes);
        return false;
      case "v":
        if (!this.#inCell) return false;
        this.#capture = "v";
        return true;
      case "is":
        if (this.#inCell) {
          this.#inInline = true;
          this.#inline = [];
        }
        return false;
      case "t":
        if (!this.#inInline || this.#inPhonetic) return false;
        this.#capture = "t";
        this.#preserve = attributes.space === "preserve";
        return true;
      case "rPh":
        this.#inPhonetic = true;
        return false;
      default:
        return false;
    }
  }

  #openAfterData(name: string, attributes: XmlAttributes): void {
    if (name === "mergeCell") {
      const range = parseRange(attributes.ref);
      // Merges wholly past the limits can never reach the grid.
      if (range && range.top < SHEET_ROW_LIMIT && range.left < SHEET_COLUMN_LIMIT) this.merges.push(range);
    } else if (name === "hyperlink") {
      const range = parseRange(attributes.ref);
      if (range && attributes.id && range.top < SHEET_ROW_LIMIT && range.left < SHEET_COLUMN_LIMIT) {
        this.hyperlinks.push({ range, id: attributes.id, location: attributes.location });
      }
    }
  }

  #startRow(attributes: XmlAttributes): void {
    const r = numberAttribute(attributes.r);
    let index: number;
    if (r !== undefined && Number.isInteger(r) && r >= 1) {
      index = r - 1;
    } else {
      index = this.#rowIndex + 1;
      if (attributes.r === undefined) this.implicitReferences = true;
    }
    if (index <= this.#rowIndex) this.ordered = false;
    this.#rowIndex = index;
    this.#column = -1;
    this.#rowContentCol = -1;
    this.#rowGridContentCol = -1;
    this.#row = null;
    if (this.materialize && index >= this.cutRow) this.#stopMaterializing(index);
    if (!this.materialize) return;
    const height = numberAttribute(attributes.ht);
    this.#row = {
      row: index,
      height: height !== undefined && height > 0 ? pointsToPx(height) : 0,
      hidden: isTrue(attributes.hidden) || height === 0,
      xf: isTrue(attributes.customFormat) ? (numberAttribute(attributes.s) ?? -1) : -1,
      cells: [],
    };
  }

  #startCell(attributes: XmlAttributes): void {
    this.#inCell = true;
    const reference = attributes.r;
    let col = reference ? columnOf(reference) : -1;
    if (col < 0) {
      col = this.#column + 1;
      if (!reference) this.implicitReferences = true;
    }
    if (col <= this.#column) this.ordered = false;
    this.#column = col;
    this.#cellCol = col;
    this.#cellXf = numberAttribute(attributes.s) ?? 0;
    this.#cellType = attributes.t ?? "n";
    this.#value = undefined;
    this.#inline = null;
    this.#inInline = false;
    this.#inPhonetic = false;
  }

  #finishCell(): void {
    this.#inCell = false;
    const col = this.#cellCol;
    const inline = this.#inline;
    const raw = inline !== null ? inline.join("") : this.#value;
    const hasValue = raw !== undefined && raw !== "";
    if (hasValue && col > this.#rowContentCol) this.#rowContentCol = col;
    const row = this.#row;
    if (!this.materialize || row === null || col >= SHEET_COLUMN_LIMIT) return;
    if (!hasValue) {
      // Blank cells matter only when their fill or borders show.
      if (this.#styles.xf(this.#cellXf).visibleWhenBlank) {
        row.cells.push({ col, xf: this.#cellXf, kind: "string", text: "", sst: -1 });
      }
      return;
    }
    if (col > this.#rowGridContentCol) this.#rowGridContentCol = col;
    row.cells.push(this.#valueCell(col, raw));
  }

  #valueCell(col: number, raw: string): ScannedCell {
    const xf = this.#cellXf;
    const format = this.#styles.xf(xf).format;
    switch (this.#cellType) {
      case "s": {
        const index = Number(raw);
        if (!Number.isInteger(index) || index < 0) return { col, xf, kind: "string", text: "", sst: -1 };
        const text = this.#strings.get(index);
        if (text === undefined) return { col, xf, kind: "string", text: "", sst: index };
        return { col, xf, kind: "string", text: this.#formatter.text(text, format), sst: -1 };
      }
      case "inlineStr":
        return { col, xf, kind: "string", text: this.#formatter.text(raw, format), sst: -1 };
      case "str":
        return { col, xf, kind: "string", text: this.#formatter.text(joinLineBreaks(decodeOoxmlEscapes(raw)), format), sst: -1 };
      case "b":
        return { col, xf, kind: "boolean", text: this.#formatter.boolean(raw === "1" || raw === "true"), sst: -1 };
      case "e":
        return { col, xf, kind: "error", text: raw.trim(), sst: -1 };
      case "d": {
        const serial = isoToSerial(raw, this.#date1904);
        if (!Number.isFinite(serial)) return { col, xf, kind: "string", text: raw, sst: -1 };
        const dateFormat = isDateFormat(format) ? format : this.#formatter.dateFormatFor(serial);
        return { col, xf, kind: "date", text: this.#formatter.number(serial, dateFormat), sst: -1 };
      }
      case "n": {
        const number = Number(raw);
        if (!Number.isFinite(number)) return { col, xf, kind: "string", text: raw, sst: -1 };
        return {
          col,
          xf,
          kind: isDateFormat(format) ? "date" : "number",
          text: this.#formatter.number(number, format),
          sst: -1,
        };
      }
      default:
        return { col, xf, kind: "string", text: joinLineBreaks(decodeOoxmlEscapes(raw)), sst: -1 };
    }
  }

  #finishRow(): void {
    const index = this.#rowIndex;
    if (this.#rowContentCol >= 0) {
      this.allMaxRow = Math.max(this.allMaxRow, index);
      this.allMaxCol = Math.max(this.allMaxCol, this.#rowContentCol);
    }
    const row = this.#row;
    this.#row = null;
    if (!row) return;
    // Rows are cut whole: the one that would overflow the cell budget starts the part left out.
    if (this.#emitted + row.cells.length > SHEET_CELL_LIMIT) {
      this.#stopMaterializing(index);
      return;
    }
    this.#emitted += row.cells.length;
    if (this.#rowGridContentCol >= 0) {
      this.gridMaxRow = Math.max(this.gridMaxRow, index);
      this.gridMaxCol = Math.max(this.gridMaxCol, this.#rowGridContentCol);
    }
    if (row.cells.length > 0 || row.height > 0 || row.hidden || row.xf >= 0) this.rows.push(row);
  }

  #stopMaterializing(index: number): void {
    this.materialize = false;
    this.cutRow = Math.min(this.cutRow, index);
    this.#row = null;
    this.onLimit?.();
  }
}

function isDateFormat(format: PreparedFormat): boolean {
  return format.kind === "date" || format.kind === "long-date" || format.kind === "long-time";
}

/** Frozen panes count whole rows and columns. */
function paneCount(value: string | undefined): number {
  const count = numberAttribute(value);
  return count !== undefined && count > 0 ? Math.min(Math.round(count), SHEET_ROW_LIMIT) : 0;
}

const REFERENCE_ATTRIBUTE = /\sr\s*=\s*["']([^"']*)["']/;
const NO_BYTES = Buffer.alloc(0);

/**
 * Finds the extent of cells with values without tokenizing or even decoding:
 * it searches the raw UTF-8 bytes for value tags (`<v>`, `<is>`) and reads
 * the reference of the `<c>` around them. Every pattern is ASCII, and UTF-8
 * never puts ASCII bytes inside a multi-byte character.
 *
 * Cells in a row come in column order, so only the last value of each row
 * is looked at: rows without values are skipped in one native search, and a
 * row with values costs a few searches however many cells it has. Only rows
 * and columns come out of it, so seeing a row twice (bytes are carried over
 * between chunks) does no harm.
 */
export class ContentSkimmer {
  maxRow = -1;
  maxCol = -1;
  /** A value whose cell has no reference: the extent cannot be known this way. */
  failed = false;
  readonly #valueTag: Buffer;
  readonly #inlineTag: Buffer;
  readonly #cellTag: Buffer;
  readonly #rowEndTag: Buffer;
  readonly #endTag: Buffer;
  #carry: Buffer = NO_BYTES;

  constructor(prefix: string) {
    this.#valueTag = Buffer.from(`<${prefix}v`);
    this.#inlineTag = Buffer.from(`<${prefix}is`);
    this.#cellTag = Buffer.from(`<${prefix}c`);
    this.#rowEndTag = Buffer.from(`</${prefix}row>`);
    this.#endTag = Buffer.from(`</${prefix}sheetData`);
  }

  /** Scans more bytes; once `</sheetData>` shows up, returns the bytes from there on. */
  feed(bytes: Buffer): Buffer | null {
    const buffer = this.#carry.length > 0 ? Buffer.concat([this.#carry, bytes]) : bytes;
    const end = buffer.indexOf(this.#endTag);
    this.#scan(buffer, end === -1 ? buffer.length : end);
    if (end !== -1) {
      this.#carry = NO_BYTES;
      return buffer.subarray(end);
    }
    this.#carry = Buffer.from(buffer.subarray(Math.max(0, buffer.length - SKIM_CARRY_BYTES)));
    return null;
  }

  #scan(buffer: Buffer, limit: number): void {
    let value = findTag(buffer, this.#valueTag, 0, limit);
    let inline = findTag(buffer, this.#inlineTag, 0, limit);
    while (value !== -1 || inline !== -1) {
      const first = inline === -1 || (value !== -1 && value < inline) ? value : inline;
      const rowEnd = buffer.indexOf(this.#rowEndTag, first);
      const segmentEnd = rowEnd === -1 || rowEnd > limit ? limit : rowEnd;
      const last = this.#lastValue(buffer, first, segmentEnd);
      if (last !== -1 && !this.#record(buffer, last)) {
        this.failed = true;
        return;
      }
      if (segmentEnd >= limit) return;
      if (value !== -1 && value < segmentEnd) value = findTag(buffer, this.#valueTag, segmentEnd, limit);
      if (inline !== -1 && inline < segmentEnd) inline = findTag(buffer, this.#inlineTag, segmentEnd, limit);
    }
  }

  /** The last non-empty value tag in [from, to); a short backward walk from the row's end. */
  #lastValue(buffer: Buffer, from: number, to: number): number {
    for (let i = to - 1; i >= from; i -= 1) {
      if (buffer[i] !== 60) continue;
      if (tagAt(buffer, i, this.#valueTag)) {
        if (!isEmptyElement(buffer, i + this.#valueTag.length)) return i;
      } else if (tagAt(buffer, i, this.#inlineTag)) {
        return i;
      }
    }
    return -1;
  }

  /** Reads the reference of the cell holding the value at `at`. */
  #record(buffer: Buffer, at: number): boolean {
    const cell = lastTag(buffer, this.#cellTag, at);
    // The cell tag fell outside the carried bytes; one value does not move the extent much.
    if (cell === -1) return true;
    const nameEnd = cell + this.#cellTag.length;
    let row: number;
    let col: number;
    // Excel writes the reference first: <c r="B12" ...>.
    if (buffer[nameEnd] === 32 && buffer[nameEnd + 1] === 114 && buffer[nameEnd + 2] === 61 && buffer[nameEnd + 3] === 34) {
      let i = nameEnd + 4;
      col = 0;
      for (let code = buffer[i] ?? 0; (code | 0x20) >= 97 && (code | 0x20) <= 122; code = buffer[++i] ?? 0) {
        col = col * 26 + ((code | 0x20) - 96);
      }
      row = 0;
      for (let code = buffer[i] ?? 0; code >= 48 && code <= 57; code = buffer[++i] ?? 0) row = row * 10 + (code - 48);
      row -= 1;
      col -= 1;
    } else {
      const tagEnd = buffer.indexOf(62, nameEnd);
      const reference = REFERENCE_ATTRIBUTE.exec(buffer.toString("latin1", nameEnd, tagEnd === -1 ? at : tagEnd))?.[1];
      if (!reference) return false;
      row = rowOf(reference);
      col = columnOf(reference);
    }
    if (row < 0 || col < 0) return false;
    if (row > this.maxRow) this.maxRow = row;
    if (col > this.maxCol) this.maxCol = col;
    return true;
  }
}

/** Whether a whole element name `tag` starts at `at` (followed by space, `>` or `/`). */
function tagAt(buffer: Buffer, at: number, tag: Buffer): boolean {
  for (let i = 1; i < tag.length; i += 1) if (buffer[at + i] !== tag[i]) return false;
  const next = buffer[at + tag.length];
  return next === 62 || next === 47 || (next !== undefined && next <= 32);
}

/** Next `tag` before `limit` that is a whole element name. */
function findTag(buffer: Buffer, tag: Buffer, from: number, limit: number): number {
  let at = buffer.indexOf(tag, from);
  while (at !== -1 && at < limit) {
    if (tagAt(buffer, at, tag)) return at;
    at = buffer.indexOf(tag, at + 1);
  }
  return -1;
}

function lastTag(buffer: Buffer, tag: Buffer, before: number): number {
  let at = buffer.lastIndexOf(tag, before);
  while (at !== -1) {
    if (tagAt(buffer, at, tag)) return at;
    at = at === 0 ? -1 : buffer.lastIndexOf(tag, at - 1);
  }
  return -1;
}

/** `<v/>` or `<v></v>`: a formula whose cached result is an empty string. */
function isEmptyElement(buffer: Buffer, afterName: number): boolean {
  const next = buffer[afterName];
  if (next === 62) return buffer[afterName + 1] === 60 && buffer[afterName + 2] === 47;
  if (next === 47) return true;
  const gt = buffer.indexOf(62, afterName);
  if (gt === -1) return false;
  return buffer[gt - 1] === 47 || (buffer[gt + 1] === 60 && buffer[gt + 2] === 47);
}

/** Turns the scan into the wire model: extent, totals, styles table, links. */
async function assembleSheet(source: WorksheetSource, parser: SheetParser, pacer: Pacer): Promise<SheetData> {
  const rowCap = Math.min(parser.cutRow, SHEET_ROW_LIMIT);
  let mergeRows = 0;
  let mergeCols = 0;
  for (const merge of parser.merges) {
    if (merge.top >= rowCap) continue;
    mergeRows = Math.max(mergeRows, Math.min(merge.bottom + 1, rowCap));
    mergeCols = Math.max(mergeCols, Math.min(merge.right + 1, SHEET_COLUMN_LIMIT));
  }
  // Content, merges and the frozen pane define the grid; trailing rows and
  // columns that only carry styles do not.
  const rowCount = Math.min(rowCap, Math.max(parser.gridMaxRow + 1, mergeRows, parser.frozenRows));
  const colCount = Math.min(SHEET_COLUMN_LIMIT, Math.max(parser.gridMaxCol + 1, mergeCols, parser.frozenCols));
  let totalRows = Math.max(parser.allMaxRow + 1, rowCount);
  let totalCols = Math.max(parser.allMaxCol + 1, colCount);
  if (parser.extentCut && parser.dimension) {
    totalRows = Math.max(totalRows, parser.dimension.bottom + 1);
    totalCols = Math.max(totalCols, parser.dimension.right + 1);
  }

  const scannedRows = parser.ordered ? parser.rows : normalizeOrder(parser.rows);
  await resolveSharedStrings(source, scannedRows, pacer);

  const table = new StyleTable(source.styles);
  const rows: SheetRow[] = [];
  let kept = 0;
  for (const scanned of scannedRows) {
    if (scanned.row >= rowCount) break;
    for (const cell of scanned.cells) if (cell.col < colCount) kept += 1;
  }
  let fillBudget = SHEET_CELL_LIMIT - kept;
  for (let i = 0; i < scannedRows.length; i += 1) {
    const scanned = scannedRows[i] as ScannedRow;
    if (scanned.row >= rowCount) break;
    const cells: SheetCell[] = [];
    for (const cell of scanned.cells) {
      if (cell.col >= colCount) break;
      cells.push(table.cell(cell.col, cell.text, cell.kind, cell.xf));
    }
    if (scanned.xf >= 0 && fillBudget > 0 && source.styles.xf(scanned.xf).visibleWhenBlank) {
      fillBudget -= fillRowStyle(cells, colCount, table, scanned.xf, fillBudget);
    }
    const row: SheetRow = { row: scanned.row, cells };
    if (scanned.height > 0) row.height = scanned.height;
    if (scanned.hidden) row.hidden = true;
    if (cells.length > 0 || row.height !== undefined || row.hidden) rows.push(row);
    if (i % 512 === 511) await pacer.pace();
  }
  if (parser.hyperlinks.length > 0) await attachLinks(source, parser.hyperlinks, rows);

  const defaultColWidth =
    parser.defaultColWidth !== undefined
      ? columnWidthToPx(parser.defaultColWidth)
      : baseColumnWidthToPx(parser.baseColWidth);
  const colWidths: (number | null)[] = new Array<number | null>(colCount).fill(null);
  const hidden = new Set<number>();
  for (const column of parser.columns) {
    for (let col = Math.max(0, column.first); col <= Math.min(column.last, colCount - 1); col += 1) {
      if (column.width !== undefined) colWidths[col] = columnWidthToPx(column.width);
      if (column.hidden) hidden.add(col);
    }
  }

  return {
    index: source.index,
    name: source.name,
    rowCount,
    colCount,
    totalRows,
    totalCols,
    truncated: parser.extentCut || totalRows > rowCount || totalCols > colCount,
    defaultRowHeight: pointsToPx(parser.defaultRowHeightPt),
    defaultColWidth,
    colWidths,
    hiddenCols: [...hidden].sort((a, b) => a - b),
    rows,
    merges: clipMerges(parser.merges, rowCount, colCount),
    frozenRows: Math.min(parser.frozenRows, rowCount),
    frozenCols: Math.min(parser.frozenCols, colCount),
    showGridLines: parser.showGridLines,
    styles: table.styles,
  };
}

/** Sorts rows and cells and merges duplicates (the later cell wins), for writers that do not keep order. */
function normalizeOrder(rows: readonly ScannedRow[]): ScannedRow[] {
  const byIndex = new Map<number, ScannedRow>();
  for (const row of rows) {
    const existing = byIndex.get(row.row);
    if (existing) existing.cells.push(...row.cells);
    else byIndex.set(row.row, { ...row, cells: [...row.cells] });
  }
  const sorted = [...byIndex.values()].sort((a, b) => a.row - b.row);
  for (const row of sorted) {
    const byColumn = new Map<number, ScannedCell>();
    for (const cell of row.cells) byColumn.set(cell.col, cell);
    row.cells = [...byColumn.values()].sort((a, b) => a.col - b.col);
  }
  return sorted;
}

/** Loads the shared strings a streamed (oversized) table did not have in memory. */
async function resolveSharedStrings(source: WorksheetSource, rows: readonly ScannedRow[], pacer: Pacer): Promise<void> {
  const pending: ScannedCell[] = [];
  for (const row of rows) for (const cell of row.cells) if (cell.sst >= 0) pending.push(cell);
  if (pending.length === 0) return;
  const texts = await source.sharedStrings.fetch([...new Set(pending.map((cell) => cell.sst))], pacer);
  for (const cell of pending) {
    cell.text = source.formatter.text(texts.get(cell.sst) ?? "", source.styles.xf(cell.xf).format);
    cell.sst = -1;
  }
}

/** Paints a row style onto the row's missing cells; returns how many were added. */
function fillRowStyle(cells: SheetCell[], colCount: number, table: StyleTable, xf: number, budget: number): number {
  const present = new Set(cells.map((cell) => cell.col));
  const added: SheetCell[] = [];
  for (let col = 0; col < colCount && added.length < budget; col += 1) {
    if (!present.has(col)) added.push(table.cell(col, "", "string", xf));
  }
  if (added.length > 0) {
    cells.push(...added);
    cells.sort((a, b) => a.col - b.col);
  }
  return added.length;
}

async function attachLinks(source: WorksheetSource, hyperlinks: readonly Hyperlink[], rows: SheetRow[]): Promise<void> {
  const targets = new Map<string, string>();
  for (const relationship of await source.relationships()) {
    if (relationship.external && relationship.kind === "hyperlink") targets.set(relationship.id, relationship.target);
  }
  for (const hyperlink of hyperlinks) {
    const target = targets.get(hyperlink.id);
    if (!target) continue;
    const url = safeUrl(hyperlink.location ? `${target}#${hyperlink.location}` : target);
    if (!url) continue;
    const { top, bottom, left, right } = hyperlink.range;
    for (let i = firstRowAtOrAfter(rows, top); i < rows.length; i += 1) {
      const row = rows[i] as SheetRow;
      if (row.row > bottom) break;
      for (const cell of row.cells) {
        if (cell.col > right) break;
        if (cell.col >= left && cell.text !== "") cell.link = url;
      }
    }
  }
}

/** Only web and mail links survive; `javascript:`, `file:` and friends are dropped. */
function safeUrl(target: string): string | undefined {
  const url = target.trim();
  return /^(?:https?:\/\/|mailto:)/i.test(url) ? url : undefined;
}

function firstRowAtOrAfter(rows: readonly SheetRow[], row: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows[middle] as SheetRow).row < row) low = middle + 1;
    else high = middle;
  }
  return low;
}

function clipMerges(merges: readonly CellRange[], rowCount: number, colCount: number): SheetMerge[] {
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

/** The sheet's own style table: each distinct look once, the default look never. */
class StyleTable {
  readonly styles: CellStyle[] = [];
  readonly #workbook: StyleSheet;
  readonly #byXf = new Map<number, number>();
  readonly #byKey = new Map<string, number>();

  constructor(workbook: StyleSheet) {
    this.#workbook = workbook;
  }

  cell(col: number, text: string, kind: CellKind, xf: number): SheetCell {
    const cell: SheetCell = { col, text, kind };
    const style = this.#indexOf(xf);
    if (style !== -1) cell.style = style;
    return cell;
  }

  #indexOf(xf: number): number {
    const known = this.#byXf.get(xf);
    if (known !== undefined) return known;
    const resolved = this.#workbook.xf(xf);
    let index = -1;
    if (resolved.key !== "") {
      index = this.#byKey.get(resolved.key) ?? -1;
      if (index === -1) {
        index = this.styles.length;
        this.styles.push({ ...resolved.style });
        this.#byKey.set(resolved.key, index);
      }
    }
    this.#byXf.set(xf, index);
    return index;
  }
}
