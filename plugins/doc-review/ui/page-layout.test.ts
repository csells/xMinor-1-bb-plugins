import { describe, expect, it } from "vitest";
import {
  anchorAt,
  computeLayout,
  indexAt,
  PAGE_GAP,
  pageLeft,
  scrollFor,
  stepZoom,
  typicalWidth,
} from "./page-layout";

const A4 = { width: 595, height: 842 };
const A3_LANDSCAPE = { width: 1191, height: 842 };
const TIMELINE = { width: 3370, height: 842 };

describe("typicalWidth", () => {
  it("picks the width most pages share", () => {
    expect(typicalWidth([A4, A3_LANDSCAPE, A4, TIMELINE, A4])).toBe(595);
  });

  it("falls back to the first page when every width differs", () => {
    expect(typicalWidth([A3_LANDSCAPE, A4, TIMELINE])).toBe(1191);
  });
});

describe("computeLayout", () => {
  it("fits a uniform document to the panel and centers it", () => {
    const layout = computeLayout([A4, A4], 700, 1);
    expect(layout.width).toBe(700);
    expect(layout.boxes[0]!.width).toBe(700 - 2 * layout.pad);
    expect(layout.boxes[1]!.top).toBe(layout.pad + layout.boxes[0]!.height + PAGE_GAP);
    expect(layout.boxes.every((box) => box.stickyLeft === null)).toBe(true);
  });

  it("caps the width at 100% on a wide screen", () => {
    const layout = computeLayout([A4], 1600, 1);
    expect(layout.boxes[0]!.width).toBe(992);
    expect(layout.pad + layout.boxes[0]!.left).toBe((1600 - 992) / 2);
  });

  it("lets a wide page overflow and keeps the others centered on screen", () => {
    const layout = computeLayout([A4, A3_LANDSCAPE, A4], 700, 1);
    const [page, wide] = layout.boxes;
    // Same scale: the A3 sheet is twice as wide as the A4 page.
    expect(wide!.width).toBeCloseTo(page!.width * 2, -1);
    expect(layout.width).toBe(wide!.width + 2 * layout.pad);
    expect(wide!.stickyLeft).toBeNull();
    expect(page!.stickyLeft).toBe(Math.floor((700 - page!.width) / 2));
  });

  it("holds a very wide page to a few panel widths", () => {
    const layout = computeLayout([A4, TIMELINE], 700, 1);
    const [page, wide] = layout.boxes;
    expect(wide!.width).toBe(Math.round(page!.width * 2.5));
    expect(wide!.height / wide!.width).toBeCloseTo(TIMELINE.height / TIMELINE.width, 2);
    // Zooming still scales it with the rest.
    expect(computeLayout([A4, TIMELINE], 700, 2).boxes[1]!.width).toBe(wide!.width * 2);
  });

  it("scales every page by the zoom", () => {
    const fit = computeLayout([A4], 700, 1).boxes[0]!;
    const zoomed = computeLayout([A4], 700, 2).boxes[0]!;
    expect(zoomed.width).toBe(fit.width * 2);
  });
});

describe("indexAt", () => {
  const layout = computeLayout([A4, A4, A4, A4], 700, 1);

  it("finds the page under a height", () => {
    expect(indexAt(layout.boxes, 0)).toBe(0);
    expect(indexAt(layout.boxes, layout.boxes[2]!.top + 5)).toBe(2);
    expect(indexAt(layout.boxes, 1e9)).toBe(3);
  });

  it("returns -1 for no pages", () => {
    expect(indexAt([], 10)).toBe(-1);
  });
});

describe("zoom anchors", () => {
  it("keeps the point under the pointer when zooming", () => {
    const pages = Array.from({ length: 20 }, () => A4);
    const before = computeLayout(pages, 700, 1);
    const scroll = { left: 0, top: before.boxes[7]!.top + 300 };
    const anchor = anchorAt(before, scroll, 250, 200)!;
    expect(anchor.index).toBe(7);
    const after = computeLayout(pages, 700, 3);
    const next = scrollFor(after, anchor)!;
    const box = after.boxes[7]!;
    // The same page point lands under the pointer again.
    expect(next.top + anchor.ay).toBeCloseTo(box.top + anchor.fy * box.height, 5);
    expect(next.left! + anchor.ax).toBeCloseTo(after.pad + box.left + anchor.fx * box.width, 5);
  });

  it("measures a centered page where it is drawn while the column scrolls", () => {
    const layout = computeLayout([A4, TIMELINE], 700, 1);
    const box = layout.boxes[0]!;
    expect(pageLeft(layout, box, 0)).toBe(box.stickyLeft);
    expect(pageLeft(layout, box, 500)).toBe(500 + box.stickyLeft!);
  });
});

describe("stepZoom", () => {
  it("moves between button stops", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.1, -1)).toBe(1);
  });

  it("stops at the ends", () => {
    expect(stepZoom(8, 1)).toBe(8);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });
});
