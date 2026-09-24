import { describe, expect, it } from "vitest";
import { renderWidth } from "./render";
import { PAGE_WIDTHS, pageImageWidth } from "./types";

const A4 = { width: 595, height: 842 };
const A1_LANDSCAPE = { width: 2384, height: 1684 };

describe("renderWidth", () => {
  it("keeps the old width when the panel asks for none", () => {
    expect(renderWidth(A4, null)).toBe(1600);
  });

  it("rounds a request up to the next step", () => {
    expect(renderWidth(A4, 1000)).toBe(1200);
    expect(renderWidth(A4, 1600)).toBe(1600);
  });

  it("caps a zoomed page at the pixel budget", () => {
    const width = renderWidth(A4, 6400);
    expect(width).toBeLessThan(6400);
    expect(width * (width * 842) / 595).toBeLessThanOrEqual(16_000_000);
  });

  it("lets a landscape sheet go wider than a portrait page", () => {
    expect(renderWidth(A1_LANDSCAPE, 6400)).toBeGreaterThan(renderWidth(A4, 6400));
  });

  it("keeps a very tall page within the budget", () => {
    const tall = { width: 10, height: 20_000 };
    const width = renderWidth(tall, 600);
    expect(width * (width * 20_000) / 10).toBeLessThanOrEqual(16_000_000);
  });
});

describe("pageImageWidth", () => {
  it("covers the page on the screen's pixel density", () => {
    expect(pageImageWidth(700, 2)).toBe(1600);
    expect(pageImageWidth(390, 3)).toBe(1200);
    expect(pageImageWidth(300, 1)).toBe(600);
  });

  it("stops at the largest step", () => {
    expect(pageImageWidth(8000, 2)).toBe(PAGE_WIDTHS[PAGE_WIDTHS.length - 1]);
  });
});
