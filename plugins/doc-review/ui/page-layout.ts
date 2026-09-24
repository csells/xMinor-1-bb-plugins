// Where pages sit in the page view. Every page shares one scale, set so the
// document's typical page fits the panel at 100%; a landscape sheet or a wide
// chart comes out wider than the panel, and the column scrolls sideways. A
// page far wider than the rest (a year-long timeline) is held to a few
// screens across, so it stays one scroll away from the whole picture.
import type { PageInfo } from "../src/types";

/** Space between pages, in CSS pixels. */
export const PAGE_GAP = 16;
/** The widest a page gets at 100%: a comfortable reading width on a big screen. */
export const MAX_FIT_WIDTH = 992;
/** The widest a page gets, in panel widths at 100%. */
export const MAX_OVERSIZE = 2.5;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
/** Stops for the zoom buttons; pinching and the wheel move freely between them. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

export interface PageBox {
  /** Top edge in the column, in CSS pixels. */
  top: number;
  width: number;
  height: number;
  /** Offset from the column's left padding. */
  left: number;
  /**
   * For a page narrower than the panel while the column scrolls sideways: its
   * sticky offset, which keeps it centered on screen as wider pages scroll.
   */
  stickyLeft: number | null;
}

export interface PageLayout {
  pad: number;
  /** CSS pixels per PDF point; pages held to MAX_OVERSIZE get less. */
  scale: number;
  boxes: PageBox[];
  /** Column size, padding included. */
  width: number;
  height: number;
}

/** Where a zoom keeps its place: a point on a page and where it sits on screen. */
export interface ZoomAnchor {
  index: number;
  /** The point as a fraction of the page. */
  fx: number;
  fy: number;
  /** The point in the viewport, in CSS pixels. */
  ax: number;
  ay: number;
}

/** The width most pages share, in points; ties go to the earliest page. */
export function typicalWidth(pages: readonly Pick<PageInfo, "width">[]): number {
  const counts = new Map<number, number>();
  let best = pages[0]?.width ?? 0;
  let bestCount = 0;
  for (const page of pages) {
    const key = Math.round(page.width);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > bestCount) {
      best = page.width;
      bestCount = count;
    }
  }
  return best > 0 ? best : 595;
}

export function computeLayout(
  pages: readonly Pick<PageInfo, "width" | "height">[],
  viewportWidth: number,
  zoom: number,
): PageLayout {
  const pad = viewportWidth < 640 ? 8 : 16;
  const fit = Math.max(160, Math.min(viewportWidth - 2 * pad, MAX_FIT_WIDTH));
  const scale = (zoom * fit) / typicalWidth(pages);
  let top = pad;
  let widest = 0;
  const sized = pages.map((page) => {
    const own = Math.min(scale, (MAX_OVERSIZE * zoom * fit) / Math.max(page.width, 1));
    const width = Math.max(1, Math.round(page.width * own));
    const height = Math.max(1, Math.round(page.height * own));
    const box = { top, width, height };
    top += height + PAGE_GAP;
    widest = Math.max(widest, width);
    return box;
  });
  const width = Math.max(viewportWidth, widest + 2 * pad);
  const scrolls = width > viewportWidth;
  const boxes = sized.map((box): PageBox => {
    const room = viewportWidth - box.width;
    if (room < 2 * pad) return { ...box, left: 0, stickyLeft: null };
    const centered = Math.floor(room / 2);
    return { ...box, left: centered - pad, stickyLeft: scrolls ? centered : null };
  });
  const height = pages.length > 0 ? top - PAGE_GAP + pad : 2 * pad;
  return { pad, scale, boxes, width, height };
}

/** Index of the page at a height in the column: the last one starting above it. */
export function indexAt(boxes: readonly PageBox[], y: number): number {
  if (boxes.length === 0) return -1;
  let low = 0;
  let high = boxes.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (boxes[mid]!.top <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** A page's left edge in the column as drawn, sticky offset included. */
export function pageLeft(layout: PageLayout, box: PageBox, scrollLeft: number): number {
  const natural = layout.pad + box.left;
  if (box.stickyLeft === null) return natural;
  const furthest = layout.width - layout.pad - box.width;
  return Math.min(Math.max(natural, scrollLeft + box.stickyLeft), furthest);
}

/** The point under a viewport position, as a fraction of the page it falls on. */
export function anchorAt(
  layout: PageLayout,
  scroll: { left: number; top: number },
  ax: number,
  ay: number,
): ZoomAnchor | null {
  const index = indexAt(layout.boxes, scroll.top + ay);
  const box = layout.boxes[index];
  if (!box) return null;
  const left = pageLeft(layout, box, scroll.left);
  return {
    index,
    fx: (scroll.left + ax - left) / box.width,
    fy: (scroll.top + ay - box.top) / box.height,
    ax,
    ay,
  };
}

/**
 * Scroll offsets that put an anchor's page point back under its viewport
 * position. `left` is null for a page that stays centered on its own.
 */
export function scrollFor(layout: PageLayout, anchor: ZoomAnchor): { top: number; left: number | null } | null {
  const box = layout.boxes[anchor.index];
  if (!box) return null;
  return {
    top: box.top + anchor.fy * box.height - anchor.ay,
    left: box.stickyLeft === null ? layout.pad + box.left + anchor.fx * box.width - anchor.ax : null,
  };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next button stop from a zoom, in or out. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom * 1.01) ?? MAX_ZOOM;
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_STEPS[index]! < zoom / 1.01) return ZOOM_STEPS[index]!;
  }
  return MIN_ZOOM;
}
