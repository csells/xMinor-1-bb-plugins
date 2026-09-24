import { describe, expect, it } from "vitest";

import {
  contentTypeFor,
  documentFamily,
  extensionOf,
  isOoxmlSpreadsheetPath,
  isSupportedPath,
} from "./formats";

describe("extensionOf", () => {
  it("reads the last extension, lowercased", () => {
    expect(extensionOf("/a/Report.DOCX")).toBe("docx");
    expect(extensionOf("deck.v2.pptx")).toBe("pptx");
    expect(extensionOf("C:\\Docs\\sheet.xlsx")).toBe("xlsx");
  });

  it("has none for dotfiles, bare names and dotted folders", () => {
    expect(extensionOf("/home/me/.xlsx")).toBe("");
    expect(extensionOf("README")).toBe("");
    expect(extensionOf("/a.pdf/notes")).toBe("");
  });
});

describe("documentFamily", () => {
  it("sorts every supported extension into its family", () => {
    expect(documentFamily("a.pdf")).toBe("pdf");
    expect(documentFamily("a.docx")).toBe("text");
    expect(documentFamily("a.rtf")).toBe("text");
    expect(documentFamily("a.odt")).toBe("text");
    expect(documentFamily("a.pptx")).toBe("presentation");
    expect(documentFamily("a.ppsx")).toBe("presentation");
    expect(documentFamily("a.odp")).toBe("presentation");
    expect(documentFamily("a.xlsx")).toBe("spreadsheet");
    expect(documentFamily("a.xls")).toBe("spreadsheet");
    expect(documentFamily("a.ods")).toBe("spreadsheet");
  });

  it("leaves everything else alone", () => {
    expect(documentFamily("a.csv")).toBeNull();
    expect(documentFamily("a.zip")).toBeNull();
    expect(isSupportedPath("a.md")).toBe(false);
    expect(isSupportedPath("a.XLSM")).toBe(true);
  });
});

describe("isOoxmlSpreadsheetPath", () => {
  it("is true only for the zip-of-XML Excel formats", () => {
    expect(isOoxmlSpreadsheetPath("a.xlsx")).toBe(true);
    expect(isOoxmlSpreadsheetPath("a.xltm")).toBe(true);
    expect(isOoxmlSpreadsheetPath("a.xls")).toBe(false);
    expect(isOoxmlSpreadsheetPath("a.xlsb")).toBe(false);
    expect(isOoxmlSpreadsheetPath("a.ods")).toBe(false);
  });
});

describe("contentTypeFor", () => {
  it("names office types and falls back to bytes", () => {
    expect(contentTypeFor("a.pdf")).toBe("application/pdf");
    expect(contentTypeFor("a.docx")).toContain("wordprocessingml");
    expect(contentTypeFor("a.unknown")).toBe("application/octet-stream");
  });
});
