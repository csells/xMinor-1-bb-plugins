import { open, writeFile } from "node:fs/promises";

import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SheetCell, SheetData } from "../../lib/sheet-model";
import { openSpreadsheet, SHEETJS_MAX_BYTES, SpreadsheetError } from "./index";
import { buildZip, temporaryDirectory } from "./test-workbook";

let directory: Awaited<ReturnType<typeof temporaryDirectory>>;

beforeAll(async () => {
  directory = await temporaryDirectory();
});
afterAll(async () => {
  await directory.cleanup();
});

function cellAt(sheet: SheetData, row: number, col: number): SheetCell | undefined {
  return sheet.rows.find((candidate) => candidate.row === row)?.cells.find((cell) => cell.col === col);
}

/** A two-sheet workbook with formats, a merge, column widths and a hidden sheet. */
function sampleWorkbook(): XLSX.WorkBook {
  const data = XLSX.utils.aoa_to_sheet([
    ["Товар", "Сумма", "Дата", "Есть"],
    ["Молоко", 1234.5, 45678, true],
    ["Хлеб", -2, 45679.25, false],
    ["merged"],
  ]);
  (data.B2 as XLSX.CellObject).z = "#,##0.00";
  (data.C2 as XLSX.CellObject).z = "dd.mm.yyyy";
  data["!cols"] = [{ wch: 20 }, { wpx: 100 }, { hidden: true }];
  data["!merges"] = [{ s: { r: 3, c: 0 }, e: { r: 4, c: 1 } }];
  data["!ref"] = "A1:D5";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["secret"]]), "Hidden");
  XLSX.utils.book_append_sheet(workbook, data, "Data");
  workbook.Workbook = { Sheets: [{ Hidden: 1 }, {}] };
  return workbook;
}

async function save(name: string, data: Buffer | string): Promise<string> {
  const path = directory.path(name);
  await writeFile(path, data);
  return path;
}

async function readActive(path: string, locale = "ru-RU") {
  const reader = await openSpreadsheet(path, { locale });
  try {
    return { reader, sheet: await reader.readSheet(reader.summary.activeSheet) };
  } finally {
    reader.close();
  }
}

describe("legacy and foreign formats through SheetJS", () => {
  it("reads BIFF8 .xls: values, formats, merges, widths, hidden sheets", async () => {
    const path = await save("legacy.xls", XLSX.write(sampleWorkbook(), { bookType: "biff8", type: "buffer" }));
    const { reader, sheet } = await readActive(path);
    expect(reader.fidelity).toBe("basic");
    expect(reader.summary).toEqual({
      sheets: [
        { name: "Hidden", hidden: true, kind: "worksheet" },
        { name: "Data", hidden: false, kind: "worksheet" },
      ],
      activeSheet: 1,
    });
    expect(cellAt(sheet, 1, 0)?.text).toBe("Молоко");
    expect(cellAt(sheet, 1, 1)).toMatchObject({ text: "1\u00a0234,50", kind: "number" });
    expect(cellAt(sheet, 1, 2)).toMatchObject({ text: "21.01.2025", kind: "date" });
    expect(cellAt(sheet, 1, 3)).toMatchObject({ text: "TRUE", kind: "boolean" });
    expect(sheet.merges).toEqual([{ row: 3, col: 0, rowSpan: 2, colSpan: 2 }]);
    expect(sheet.rowCount).toBe(5);
    expect(sheet.colCount).toBe(4);
    expect(sheet.colWidths[1]).toBe(100);
    expect(sheet.hiddenCols).toEqual([2]);
  });

  it("reads OpenDocument .ods and binary .xlsb", async () => {
    for (const [name, bookType] of [
      ["sheet.ods", "ods"],
      ["sheet.xlsb", "xlsb"],
    ] as const) {
      const path = await save(name, XLSX.write(sampleWorkbook(), { bookType, type: "buffer" }));
      const reader = await openSpreadsheet(path, { locale: "en-US" });
      expect(reader.fidelity).toBe("basic");
      const index = reader.summary.sheets.findIndex((sheet) => sheet.name === "Data");
      const sheet = await reader.readSheet(index);
      expect(cellAt(sheet, 1, 0)?.text).toBe("Молоко");
      expect(cellAt(sheet, 1, 1)?.text).toBe("1,234.50");
      expect(sheet.merges).toEqual([{ row: 3, col: 0, rowSpan: 2, colSpan: 2 }]);
      reader.close();
    }
  });

  it("reads SpreadsheetML 2003 and HTML saved under an .xls name", async () => {
    const xml = await save("export-2003.xls", XLSX.write(sampleWorkbook(), { bookType: "xlml", type: "buffer" }));
    const fromXml = await readActive(xml);
    expect(cellAt(fromXml.sheet, 2, 0)?.text).toBe("Хлеб");
    expect(cellAt(fromXml.sheet, 1, 2)?.text).toBe("21.01.2025");

    const html = await save(
      "report.xls",
      '<html><head><meta charset="utf-8"></head><body><table>' +
        "<tr><td>Отчёт</td><td>001234</td></tr><tr><td colspan=\"2\">итого 1.5</td></tr></table></body></html>",
    );
    const fromHtml = await readActive(html);
    // Text stays as written: no re-guessing "001234" into 1234.
    expect(cellAt(fromHtml.sheet, 0, 1)?.text).toBe("001234");
    expect(cellAt(fromHtml.sheet, 1, 0)?.text).toBe("итого 1.5");
    expect(fromHtml.sheet.merges).toEqual([{ row: 1, col: 0, rowSpan: 1, colSpan: 2 }]);
  });

  it("returns strict JSON", async () => {
    const path = await save("strict.xls", XLSX.write(sampleWorkbook(), { bookType: "biff8", type: "buffer" }));
    const { sheet } = await readActive(path);
    const walk = (value: unknown): boolean =>
      value === undefined
        ? false
        : typeof value === "number"
          ? Number.isFinite(value)
          : value === null || typeof value !== "object"
            ? true
            : Object.values(value).every(walk);
    expect(walk(sheet)).toBe(true);
  });
});

describe("refusals", () => {
  it("refuses a non-OOXML file over the size cap before parsing it", async () => {
    const path = directory.path("huge.xls");
    const handle = await open(path, "w");
    await handle.truncate(SHEETJS_MAX_BYTES + 1);
    await handle.close();
    const opening = openSpreadsheet(path, { locale: "en-US" });
    await expect(opening).rejects.toBeInstanceOf(SpreadsheetError);
    await expect(opening).rejects.toMatchObject({ code: "too-large", message: expect.stringMatching(/\.xlsx/) });
  });

  it("says when a zip is not a spreadsheet", async () => {
    const path = await save(
      "document.xlsx",
      buildZip([
        { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
        { name: "word/document.xml", data: "<document/>" },
      ]),
    );
    await expect(openSpreadsheet(path, { locale: "en-US" })).rejects.toMatchObject({ code: "unreadable" });
  });
});
