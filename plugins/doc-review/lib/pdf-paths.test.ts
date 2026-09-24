import { describe, expect, it } from "vitest";

import {
  baseName,
  directoryName,
  joinPath,
  pdfNameFor,
  previewUrlFor,
} from "./pdf-paths";

describe("baseName / directoryName", () => {
  it("splits an absolute path", () => {
    expect(baseName("/home/me/docs/a.pdf")).toBe("a.pdf");
    expect(directoryName("/home/me/docs/a.pdf")).toBe("/home/me/docs");
  });

  it("handles a root-level file and a bare name", () => {
    expect(directoryName("/a.pdf")).toBe("/");
    expect(baseName("a.pdf")).toBe("a.pdf");
    expect(directoryName("a.pdf")).toBe(".");
  });
});

describe("joinPath", () => {
  it("joins without doubling separators", () => {
    expect(joinPath("/root", "docs/a.pdf")).toBe("/root/docs/a.pdf");
    expect(joinPath("/root/", "/docs/a.pdf")).toBe("/root/docs/a.pdf");
    expect(joinPath("/root", "")).toBe("/root");
  });
});

describe("previewUrlFor", () => {
  it("encodes the file name as one path segment", () => {
    expect(previewUrlFor("/api/previews/abc", "ЭПД с Х5.pdf")).toBe(
      `/api/previews/abc/${encodeURIComponent("ЭПД с Х5.pdf")}`,
    );
    expect(previewUrlFor("/api/previews/abc/", "a b.pdf")).toBe(
      "/api/previews/abc/a%20b.pdf",
    );
  });
});

describe("pdfNameFor", () => {
  it("keeps the stem and swaps the extension", () => {
    expect(pdfNameFor("Отчёт Q3.docx")).toBe("Отчёт Q3.pdf");
    expect(pdfNameFor("deck.v2.pptx")).toBe("deck.v2.pdf");
    expect(pdfNameFor("README")).toBe("README.pdf");
  });

  it("drops separators and control characters", () => {
    expect(pdfNameFor("a/b\\c\u0001.doc")).toBe("abc.pdf");
    expect(pdfNameFor(".docx")).toBe("document.pdf");
  });

  it("caps a very long name", () => {
    expect(pdfNameFor(`${"я".repeat(300)}.docx`)).toBe(`${"я".repeat(120)}.pdf`);
  });
});
