import { writeFile } from "node:fs/promises";

import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SHEET_CELL_LIMIT,
  SHEET_COLUMN_LIMIT,
  SHEET_ROW_LIMIT,
  type SheetCell,
  type SheetData,
} from "../../lib/sheet-model";
import { applyTint } from "./colors";
import { openSpreadsheet, type SpreadsheetReader } from "./index";
import { buildWorkbook, temporaryDirectory, type WorkbookInput } from "./test-workbook";
import { columnWidthToPx } from "./worksheet";

let directory: Awaited<ReturnType<typeof temporaryDirectory>>;
let fileCount = 0;

beforeAll(async () => {
  directory = await temporaryDirectory();
});
afterAll(async () => {
  await directory.cleanup();
});

async function saveExcel(workbook: ExcelJS.Workbook, options?: { useSharedStrings?: boolean }): Promise<string> {
  const path = directory.path(`exceljs-${(fileCount += 1)}.xlsx`);
  await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer(options)));
  return path;
}

async function saveRaw(input: WorkbookInput): Promise<string> {
  const path = directory.path(`raw-${(fileCount += 1)}.xlsx`);
  await writeFile(path, buildWorkbook(input));
  return path;
}

async function readFirst(path: string, locale = "en-US"): Promise<SheetData> {
  const reader = await openSpreadsheet(path, { locale });
  try {
    return await reader.readSheet(reader.summary.activeSheet);
  } finally {
    reader.close();
  }
}

/** The cell at a 0-based position, or undefined. */
function cellAt(sheet: SheetData, row: number, col: number): SheetCell | undefined {
  return sheet.rows.find((candidate) => candidate.row === row)?.cells.find((cell) => cell.col === col);
}

function styleOf(sheet: SheetData, cell: SheetCell | undefined) {
  return cell?.style === undefined ? undefined : sheet.styles[cell.style];
}

/** Everything the bb RPC layer rejects: undefined values and non-finite numbers. */
function strictJsonProblems(value: unknown, path = "$"): string[] {
  if (value === undefined) return [`${path} is undefined`];
  if (typeof value === "number") return Number.isFinite(value) ? [] : [`${path} is ${value}`];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => strictJsonProblems(item, `${path}[${index}]`));
  return Object.entries(value).flatMap(([key, item]) => strictJsonProblems(item, `${path}.${key}`));
}

describe("styles from an Excel-style workbook", () => {
  let sheet: SheetData;

  beforeAll(async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Styled", {
      views: [{ state: "frozen", xSplit: 1, ySplit: 2, showGridLines: false }],
    });
    ws.getColumn(2).width = 20;
    ws.getColumn(3).hidden = true;
    ws.getRow(2).height = 30;
    ws.getRow(4).hidden = true;

    const header = ws.getCell("A1");
    header.value = "Header";
    header.font = { bold: true, italic: true, underline: true, strike: true, color: { argb: "FFFF0000" }, size: 14, name: "Arial" };

    const amount = ws.getCell("B1");
    amount.value = 1234.5;
    amount.numFmt = "#,##0.00";
    amount.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    amount.alignment = { horizontal: "center", vertical: "middle", wrapText: true };

    const tinted = ws.getCell("A2");
    tinted.value = "tinted";
    // exceljs writes `tint` but its Color type does not declare it.
    const accentLighter = { theme: 4, tint: 0.3999755851924192 } as Partial<ExcelJS.Color>;
    tinted.fill = { type: "pattern", pattern: "solid", fgColor: accentLighter };
    tinted.border = {
      top: { style: "thin", color: { argb: "FF00FF00" } },
      bottom: { style: "double" },
      left: { style: "medium" },
      right: { style: "dashed", color: { theme: 1 } },
    };

    const indented = ws.getCell("A3");
    indented.value = "indented";
    indented.alignment = { horizontal: "right", indent: 2 };

    ws.getCell("A4").value = "in a hidden row";
    ws.getCell("D5").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00B0F0" } };
    ws.getCell("E6").value = "edge";
    ws.getCell("A7").value = "merged";
    ws.mergeCells("A7:B8");
    // Styled, but past the last content: must not stretch the grid.
    ws.getCell("F10").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00B0F0" } };
    ws.getCell("A20").border = { top: { style: "thick" } };

    sheet = await readFirst(await saveExcel(workbook));
  });

  it("sizes the grid by content and merges, not by styled blanks", () => {
    expect(sheet.rowCount).toBe(8);
    expect(sheet.colCount).toBe(5);
    expect(sheet.totalRows).toBe(8);
    expect(sheet.totalCols).toBe(5);
    expect(sheet.truncated).toBe(false);
  });

  it("resolves fonts relative to the workbook's normal font", () => {
    const header = cellAt(sheet, 0, 0);
    expect(header?.text).toBe("Header");
    expect(styleOf(sheet, header)).toEqual({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      color: "#ff0000",
      fontSize: 14,
      fontFamily: "Arial",
    });
  });

  it("resolves fills, alignment and number formats", () => {
    const amount = cellAt(sheet, 0, 1);
    expect(amount).toMatchObject({ text: "1,234.50", kind: "number" });
    expect(styleOf(sheet, amount)).toEqual({ background: "#ffff00", horizontal: "center", vertical: "middle", wrap: true });
    expect(styleOf(sheet, cellAt(sheet, 2, 0))).toEqual({ horizontal: "right", indent: 2 });
  });

  it("applies theme colors with tint and draws borders per side", () => {
    expect(styleOf(sheet, cellAt(sheet, 1, 0))).toEqual({
      background: `#${applyTint("4F81BD", 0.3999755851924192).toLowerCase()}`,
      borderTop: "1px solid #00ff00",
      borderRight: "1px dashed #000000",
      borderBottom: "3px double #000000",
      borderLeft: "2px solid #000000",
    });
  });

  it("keeps styled blank cells inside the grid and nothing past it", () => {
    expect(cellAt(sheet, 4, 3)).toEqual({ col: 3, text: "", kind: "string", style: expect.any(Number) });
    expect(styleOf(sheet, cellAt(sheet, 4, 3))).toEqual({ background: "#00b0f0" });
    expect(sheet.rows.every((row) => row.row < sheet.rowCount)).toBe(true);
    expect(sheet.rows.flatMap((row) => row.cells).every((cell) => cell.col < sheet.colCount)).toBe(true);
  });

  it("reads frozen panes, gridlines, sizes, hidden rows and columns, merges", () => {
    expect(sheet.frozenRows).toBe(2);
    expect(sheet.frozenCols).toBe(1);
    expect(sheet.showGridLines).toBe(false);
    expect(sheet.colWidths).toHaveLength(5);
    expect(sheet.colWidths[1]).toBe(columnWidthToPx(20));
    expect(sheet.colWidths[0]).toBeNull();
    expect(sheet.hiddenCols).toEqual([2]);
    expect(sheet.rows.find((row) => row.row === 1)?.height).toBe(40);
    expect(sheet.rows.find((row) => row.row === 3)?.hidden).toBe(true);
    expect(sheet.merges).toEqual([{ row: 6, col: 0, rowSpan: 2, colSpan: 2 }]);
    expect(sheet.defaultRowHeight).toBe(20);
    expect(sheet.defaultColWidth).toBeGreaterThan(0);
  });

  it("lists each distinct look once and never the default one", () => {
    const keys = sheet.styles.map((style) => JSON.stringify(style));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("{}");
    expect(cellAt(sheet, 5, 4)).toEqual({ col: 4, text: "edge", kind: "string" });
  });

  it("returns strict JSON: no undefined values, only finite numbers", () => {
    expect(strictJsonProblems(sheet)).toEqual([]);
    expect(JSON.parse(JSON.stringify(sheet))).toEqual(sheet);
  });
});

describe("values", () => {
  async function valuesWorkbook(useSharedStrings: boolean): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Values");
    ws.getCell("A1").value = "plain";
    ws.getCell("A2").value = { richText: [{ text: "rich ", font: { bold: true } }, { text: "text" }] };
    ws.getCell("A3").value = true;
    ws.getCell("A4").value = false;
    ws.getCell("A5").value = { error: "#DIV/0!" };
    ws.getCell("A6").value = 1234567.891;
    ws.getCell("A6").numFmt = "#,##0.00";
    ws.getCell("A7").value = new Date(Date.UTC(2025, 0, 21));
    ws.getCell("A7").numFmt = "mm-dd-yy"; // builtin 14
    ws.getCell("A8").value = new Date(Date.UTC(2025, 0, 21, 18, 30));
    ws.getCell("A8").numFmt = "dd.mm.yyyy hh:mm";
    ws.getCell("A9").value = { formula: 'A1&"!"', result: "plain!" };
    ws.getCell("A10").value = 0.125;
    ws.getCell("A10").numFmt = "0.0%";
    ws.getCell("A11").value = "line one\nline two";
    ws.getCell("A12").value = 42;
    ws.getCell("A12").numFmt = '#,##0" руб."';
    return saveExcel(workbook, { useSharedStrings });
  }

  it("reads shared, rich and formula strings, booleans, errors, numbers and dates", async () => {
    const sheet = await readFirst(await valuesWorkbook(true), "ru-RU");
    const texts = Array.from({ length: 12 }, (_, row) => cellAt(sheet, row, 0));
    expect(texts.map((cell) => cell?.text)).toEqual([
      "plain",
      "rich text",
      "TRUE",
      "FALSE",
      "#DIV/0!",
      "1\u00a0234\u00a0567,89",
      "21.01.2025",
      "21.01.2025 18:30",
      "plain!",
      "12,5%",
      "line one\nline two",
      "42 руб.",
    ]);
    expect(texts.map((cell) => cell?.kind)).toEqual([
      "string",
      "string",
      "boolean",
      "boolean",
      "error",
      "number",
      "date",
      "date",
      "string",
      "number",
      "string",
      "number",
    ]);
  });

  it("reads the same values without a shared-string table", async () => {
    const sheet = await readFirst(await valuesWorkbook(false), "en-US");
    expect(cellAt(sheet, 0, 0)?.text).toBe("plain");
    expect(cellAt(sheet, 1, 0)?.text).toBe("rich text");
    expect(cellAt(sheet, 5, 0)?.text).toBe("1,234,567.89");
    expect(cellAt(sheet, 6, 0)?.text).toBe("1/21/2025");
  });

  it("counts days from 1904 in Mac workbooks", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = true;
    const ws = workbook.addWorksheet("Mac");
    ws.getCell("A1").value = new Date(Date.UTC(2025, 0, 21));
    ws.getCell("A1").numFmt = "yyyy-mm-dd";
    const sheet = await readFirst(await saveExcel(workbook));
    expect(cellAt(sheet, 0, 0)).toMatchObject({ text: "2025-01-21", kind: "date" });
  });

  it("keeps web and mail links only", async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Links");
    ws.getCell("A1").value = { text: "site", hyperlink: "https://example.com/a?b=1" };
    ws.getCell("A2").value = { text: "mail", hyperlink: "mailto:someone@example.com" };
    ws.getCell("A3").value = { text: "script", hyperlink: "javascript:alert(1)" };
    ws.getCell("A4").value = { text: "file", hyperlink: "file:///etc/passwd" };
    ws.getCell("A5").value = { text: "inside", hyperlink: "#Links!A1" };
    const sheet = await readFirst(await saveExcel(workbook));
    expect(sheet.rows.map((row) => row.cells[0]?.link ?? null)).toEqual([
      "https://example.com/a?b=1",
      "mailto:someone@example.com",
      null,
      null,
      null,
    ]);
    expect(strictJsonProblems(sheet)).toEqual([]);
  });
});

describe("workbook summary", () => {
  it("lists hidden sheets and opens on a visible worksheet", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Hidden").state = "hidden";
    workbook.addWorksheet("Visible").getCell("A1").value = "shown";
    workbook.addWorksheet("VeryHidden").state = "veryHidden";
    workbook.views = [{ x: 0, y: 0, width: 100, height: 100, firstSheet: 0, activeTab: 0, visibility: "visible" }];
    const reader = await openSpreadsheet(await saveExcel(workbook), { locale: "en-US" });
    expect(reader.fidelity).toBe("full");
    expect(reader.summary).toEqual({
      sheets: [
        { name: "Hidden", hidden: true, kind: "worksheet" },
        { name: "Visible", hidden: false, kind: "worksheet" },
        { name: "VeryHidden", hidden: true, kind: "worksheet" },
      ],
      activeSheet: 1,
    });
    reader.close();
  });

  it("follows relationships, not part names, and honors activeTab", async () => {
    const reader = await openSpreadsheet(
      await saveRaw({
        shuffleParts: true,
        activeTab: 1,
        sheets: [
          { name: "First", body: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>one</t></is></c></row></sheetData>' },
          { name: "Second", body: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>two</t></is></c></row></sheetData>' },
          { name: "Chart", body: "<drawing/>", kind: "chartsheet" },
        ],
      }),
      { locale: "en-US" },
    );
    expect(reader.summary.activeSheet).toBe(1);
    expect(reader.summary.sheets.map((sheet) => sheet.kind)).toEqual(["worksheet", "worksheet", "chartsheet"]);
    expect(cellAt(await reader.readSheet(0), 0, 0)?.text).toBe("one");
    expect(cellAt(await reader.readSheet(1), 0, 0)?.text).toBe("two");
    const chart = await reader.readSheet(2);
    expect(chart).toMatchObject({ rowCount: 0, colCount: 0, rows: [] });
    await expect(reader.readSheet(3)).rejects.toThrow(RangeError);
    reader.close();
  });
});

describe("hand-written parts", () => {
  const styles =
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF0000FF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC000"/></patternFill></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0"/></cellXfs>';

  it("reads .NET-style x: prefixes", async () => {
    const sheet = await readFirst(
      await saveRaw({
        prefix: "x:",
        styles,
        sharedStrings: '<si><t>shared</t></si><si><r><t>ri</t></r><r><rPr><b/></rPr><t>ch</t></r></si>',
        sheets: [
          {
            name: "Prefixed",
            body:
              '<sheetViews><sheetView workbookViewId="0"><pane xSplit="0" ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>' +
              '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>1234.5</v></c></row>' +
              '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="2"/></row></sheetData>' +
              '<mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells>',
          },
        ],
      }),
    );
    expect(cellAt(sheet, 0, 0)?.text).toBe("shared");
    expect(cellAt(sheet, 0, 1)).toMatchObject({ text: "1,234.50", kind: "number" });
    expect(styleOf(sheet, cellAt(sheet, 0, 1))).toEqual({ bold: true, color: "#0000ff" });
    expect(cellAt(sheet, 1, 0)?.text).toBe("rich");
    expect(styleOf(sheet, cellAt(sheet, 1, 1))).toEqual({ background: "#ffc000" });
    expect(sheet.frozenRows).toBe(1);
    expect(sheet.merges).toEqual([{ row: 2, col: 0, rowSpan: 1, colSpan: 2 }]);
    expect(sheet.rowCount).toBe(3);
  });

  it("reads Strict OOXML namespaces", async () => {
    const sheet = await readFirst(
      await saveRaw({
        strict: true,
        styles,
        sheets: [{ name: "Strict", body: '<sheetData><row r="1"><c r="C1" s="1"><v>2</v></c></row></sheetData>' }],
      }),
    );
    expect(cellAt(sheet, 0, 2)).toMatchObject({ text: "2.00", kind: "number" });
    expect(sheet.colCount).toBe(3);
  });

  it("places cells without references and decodes text the way Excel shows it", async () => {
    const sheet = await readFirst(
      await saveRaw({
        sheets: [
          {
            name: "Implicit",
            body:
              "<sheetData>" +
              '<row><c t="inlineStr"><is><t xml:space="preserve">  kept  </t></is></c><c t="inlineStr"><is><t>  trimmed  </t></is></c></row>' +
              '<row><c t="inlineStr"><is><r><t>日本</t></r><rPh sb="0" eb="2"><t>にほん</t></rPh></is></c><c t="str"><v>a_x000D__x000A_b &amp; c</v></c></row>' +
              '<row r="5"><c><v>1</v></c><c r="D5" t="d"><v>2025-01-21T06:00:00</v></c><c t="e"><v>#N/A</v></c></row>' +
              "</sheetData>",
          },
        ],
      }),
      "ru-RU",
    );
    expect(cellAt(sheet, 0, 0)?.text).toBe("  kept  ");
    expect(cellAt(sheet, 0, 1)?.text).toBe("trimmed");
    expect(cellAt(sheet, 1, 0)?.text).toBe("日本");
    // CR LF stored as _x000D_ + newline shows as one line break.
    expect(cellAt(sheet, 1, 1)?.text).toBe("a\nb & c");
    expect(cellAt(sheet, 4, 0)).toMatchObject({ text: "1", kind: "number" });
    expect(cellAt(sheet, 4, 3)).toMatchObject({ text: "21.01.2025 6:00", kind: "date" });
    expect(cellAt(sheet, 4, 4)).toMatchObject({ text: "#N/A", kind: "error" });
    expect(sheet.rowCount).toBe(5);
    expect(sheet.colCount).toBe(5);
  });

  it("paints a row style onto the row's blank cells", async () => {
    const sheet = await readFirst(
      await saveRaw({
        styles,
        sheets: [
          {
            name: "RowStyle",
            body:
              '<sheetData><row r="1"><c r="C1"><v>1</v></c></row>' +
              '<row r="2" s="2" customFormat="1"><c r="B2"><v>2</v></c></row></sheetData>',
          },
        ],
      }),
    );
    const row = sheet.rows.find((candidate) => candidate.row === 1);
    expect(row?.cells.map((cell) => [cell.col, cell.text])).toEqual([
      [0, ""],
      [1, "2"],
      [2, ""],
    ]);
    expect(styleOf(sheet, row?.cells[0])).toEqual({ background: "#ffc000" });
    // A cell written without s has the default style, not the row's.
    expect(row?.cells[1]?.style).toBeUndefined();
  });

  it("puts rows and cells written out of order back in order", async () => {
    const sheet = await readFirst(
      await saveRaw({
        sheets: [
          {
            name: "Unordered",
            body: '<sheetData><row r="3"><c r="B3"><v>3</v></c><c r="A3"><v>2</v></c></row><row r="1"><c r="A1"><v>1</v></c></row></sheetData>',
          },
        ],
      }),
    );
    expect(sheet.rows.map((row) => [row.row, row.cells.map((cell) => cell.text)])).toEqual([
      [0, ["1"]],
      [2, ["2", "3"]],
    ]);
  });
});

/** Rows of numeric cells, `r` written the way Excel does. */
function rowsXml(rows: number, cols: number, first = 1): string {
  const parts: string[] = [];
  for (let r = first; r < first + rows; r += 1) {
    let cells = "";
    for (let c = 0; c < cols; c += 1) cells += `<c r="${columnName(c)}${r}"><v>${r}</v></c>`;
    parts.push(`<row r="${r}">${cells}</row>`);
  }
  return parts.join("");
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

describe("limits", () => {
  it("cuts rows past the row limit and still counts them", async () => {
    const sheet = await readFirst(
      await saveRaw({ sheets: [{ name: "Tall", body: `<sheetData>${rowsXml(SHEET_ROW_LIMIT + 1000, 2)}</sheetData>` }] }),
    );
    expect(sheet.rowCount).toBe(SHEET_ROW_LIMIT);
    expect(sheet.totalRows).toBe(SHEET_ROW_LIMIT + 1000);
    expect(sheet.truncated).toBe(true);
    expect(sheet.rows.at(-1)?.row).toBe(SHEET_ROW_LIMIT - 1);
  });

  it("cuts columns past the column limit and still counts them", async () => {
    const sheet = await readFirst(
      await saveRaw({ sheets: [{ name: "Wide", body: `<sheetData>${rowsXml(2, SHEET_COLUMN_LIMIT + 50)}</sheetData>` }] }),
    );
    expect(sheet.colCount).toBe(SHEET_COLUMN_LIMIT);
    expect(sheet.totalCols).toBe(SHEET_COLUMN_LIMIT + 50);
    expect(sheet.truncated).toBe(true);
    expect(sheet.rows[0]?.cells).toHaveLength(SHEET_COLUMN_LIMIT);
  });

  it("cuts whole rows once the cell limit is reached", async () => {
    const cols = 25;
    const sheet = await readFirst(
      await saveRaw({ sheets: [{ name: "Dense", body: `<sheetData>${rowsXml(5000, cols)}</sheetData>` }] }),
    );
    expect(sheet.rowCount).toBe(SHEET_CELL_LIMIT / cols);
    expect(sheet.totalRows).toBe(5000);
    expect(sheet.truncated).toBe(true);
    expect(sheet.rows.reduce((sum, row) => sum + row.cells.length, 0)).toBeLessThanOrEqual(SHEET_CELL_LIMIT);
  });

  it("ignores a long tail of styled rows and finds content and merges past it", async () => {
    const styledRows: string[] = [];
    for (let r = 3; r <= 60_000; r += 1) styledRows.push(`<row r="${r}"><c r="A${r}" s="2"/><c r="B${r}" s="2"/></row>`);
    const styles =
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC000"/></patternFill></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellXfs count="3"><xf/><xf/><xf fillId="2"/></cellXfs>';
    const tail = await readFirst(
      await saveRaw({
        styles,
        sheets: [
          {
            name: "Tail",
            body:
              '<dimension ref="A1:B1048575"/>' +
              `<sheetData>${rowsXml(2, 2)}${styledRows.join("")}</sheetData>` +
              '<mergeCells count="1"><mergeCell ref="A1:A2"/></mergeCells>',
          },
        ],
      }),
    );
    expect(tail).toMatchObject({ rowCount: 2, colCount: 2, totalRows: 2, totalCols: 2, truncated: false });
    expect(tail.merges).toEqual([{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }]);

    const late = await readFirst(
      await saveRaw({
        styles,
        sheets: [
          {
            name: "Late",
            body:
              `<sheetData>${rowsXml(2, 2)}${styledRows.join("")}` +
              '<row r="100000"><c r="D100000" t="inlineStr"><is><t>far away</t></is></c></row></sheetData>',
          },
        ],
      }),
    );
    expect(late).toMatchObject({ rowCount: 2, colCount: 2, totalRows: 100_000, totalCols: 4, truncated: true });
  });

  it("counts the extent without cell references too", async () => {
    const rows = Array.from({ length: SHEET_ROW_LIMIT + 10 }, (_, i) => `<row><c><v>${i}</v></c><c/><c><v>x</v></c></row>`);
    const sheet = await readFirst(await saveRaw({ sheets: [{ name: "Implicit", body: `<sheetData>${rows.join("")}</sheetData>` }] }));
    expect(sheet).toMatchObject({ rowCount: SHEET_ROW_LIMIT, colCount: 3, totalRows: SHEET_ROW_LIMIT + 10, totalCols: 3 });
  });
});

describe("reader lifecycle", () => {
  let reader: SpreadsheetReader;

  beforeAll(async () => {
    reader = await openSpreadsheet(
      await saveRaw({ sheets: [{ name: "Data", body: `<sheetData>${rowsXml(3000, 10)}</sheetData>` }] }),
      { locale: "en-US" },
    );
  });

  it("reads the same sheet repeatedly and concurrently", async () => {
    const [first, second] = await Promise.all([reader.readSheet(0), reader.readSheet(0)]);
    expect(second).toEqual(first);
    expect(await reader.readSheet(0)).toEqual(first);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(reader.readSheet(0, controller.signal)).rejects.toThrow(/abort/i);
    const aborted = openSpreadsheet(directory.path("never.xlsx"), { locale: "en-US", signal: controller.signal });
    await expect(aborted).rejects.toThrow(/abort/i);
  });

  it("refuses reads after close", async () => {
    reader.close();
    await expect(reader.readSheet(0)).rejects.toThrow(/closed/);
  });
});
