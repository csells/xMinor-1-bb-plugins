// Page view for PDF, Word, and PowerPoint: server-rendered page images with an
// invisible, selectable word layer on top. Text selections become `page-text`
// comments; in Area mode a dragged box becomes a `page-area` comment (on a
// touch screen: hold, then drag).
//
// Every page shares one scale (see page-layout.ts), so a landscape or
// large-format page comes out wider than the panel and scrolls sideways. Zoom
// comes from the floating bar, Ctrl or Cmd with the wheel, and pinching; the
// image is re-rendered at the resolution the zoom needs. Only the pages near
// the viewport mount their image and words, so a long document stays light.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  pageImageWidth,
  pageNoun,
  type Anchor,
  type DocKind,
  type PageInfo,
  type PageWord,
  type Rect,
  type ReviewComment,
} from "../src/types";
import type { Point } from "./markdown-doc";
import {
  anchorAt,
  clampZoom,
  computeLayout,
  indexAt,
  PAGE_GAP,
  scrollFor,
  stepZoom,
  type PageBox,
  type ZoomAnchor,
} from "./page-layout";
import { isCommentShortcut, SelectionMenu } from "./selection-menu";
import { errorText, useReviewRpc } from "./use-review";
import { ZoomBar } from "./zoom-bar";

export type PageMode = "text" | "area";

interface LiveSelection {
  page: number;
  rects: Rect[];
  quote: string;
}

const MIN_AREA = 0.012;
/** How long a finger rests in Area mode before it draws instead of scrolling. */
const HOLD_MS = 300;
/** A page stays near the viewport this long before its image and words load. */
const SETTLE_MS = 120;
/** A new zoom waits this long before asking for sharper images. */
const RESOLUTION_DELAY_MS = 200;
/** Room under the last page, so the zoom bar never covers it. */
const BOTTOM_ROOM = 56;
const NO_COMMENTS: readonly ReviewComment[] = [];
const COARSE_POINTER = "(hover: none) and (pointer: coarse)";

function unionRect(words: PageWord[]): Rect {
  const x0 = Math.min(...words.map((word) => word[0]));
  const y0 = Math.min(...words.map((word) => word[1]));
  const x1 = Math.max(...words.map((word) => word[2]));
  const y1 = Math.max(...words.map((word) => word[3]));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function inside(rect: Rect, word: PageWord): boolean {
  const cx = (word[0] + word[2]) / 2;
  const cy = (word[1] + word[3]) / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function boxStyle(rect: Rect) {
  return { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) };
}

/** A box around a spot, for a finger that held and let go without dragging. */
function boxAround(x: number, y: number): Rect {
  const w = 0.3;
  const h = 0.2;
  return { x: Math.min(Math.max(x - w / 2, 0), 1 - w), y: Math.min(Math.max(y - h / 2, 0), 1 - h), w, h };
}

/** The invisible word layer that makes page text selectable. */
const TextLayer = memo(function TextLayer({
  lines,
  aspect,
}: {
  lines: PageWord[][];
  /** Page height / width. */
  aspect: number;
}) {
  return (
    <div className="doc-review-textlayer absolute inset-0" data-textlayer="">
      {lines.map((line, li) =>
        line.map((word, wi) => (
          <span
            key={`${li}:${wi}`}
            data-li={li}
            data-wi={wi}
            style={{
              left: pct(word[0]),
              top: pct(word[1]),
              width: pct(word[2] - word[0]),
              height: pct(word[3] - word[1]),
              fontSize: `${((word[3] - word[1]) * aspect * 100 * 0.85).toFixed(3)}cqw`,
            }}
          >
            {word[4]}
          </span>
        )),
      )}
    </div>
  );
});

function Pin({
  seq,
  rect,
  active,
  resolved,
  onClick,
}: {
  seq: number;
  rect: Rect;
  active: boolean;
  resolved: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "pointer-events-auto absolute z-30 inline-flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-1 text-[11px] font-semibold shadow",
        active
          ? "bg-primary text-primary-foreground ring-2 ring-primary/40"
          : resolved
            ? "bg-muted text-muted-foreground"
            : "bg-primary/90 text-primary-foreground",
      )}
      style={{ left: `max(10px, ${pct(rect.x)})`, top: `max(10px, ${pct(rect.y)})` }}
      aria-label={`Comment ${seq}`}
    >
      {seq}
    </button>
  );
}

const IMAGE_CLASS = "pointer-events-none absolute inset-0 size-full select-none";

/**
 * The page image at the resolution the zoom needs. It is fetched rather than
 * set as a src, so a page scrolled past cancels its download instead of
 * holding one of the browser's few connections. The image on screen stays
 * until a sharper one arrives, so a zoom never flashes an empty page.
 */
function PageImage({ url, alt, onError }: { url: string; alt: string; onError: () => void }) {
  const [wanted, setWanted] = useState(url);
  const [shown, setShown] = useState<string | null>(null);

  // Zoom steps come in bursts; ask for the new resolution once they stop.
  useEffect(() => {
    if (url === wanted) return;
    const timer = window.setTimeout(() => setWanted(url), RESOLUTION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [url, wanted]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(wanted, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (!controller.signal.aborted) setShown(URL.createObjectURL(blob));
      })
      .catch(() => {
        if (!controller.signal.aborted) onError();
      });
    return () => controller.abort();
  }, [wanted, onError]);

  // An object URL lives while its image is on screen.
  useEffect(() => {
    if (!shown) return;
    return () => URL.revokeObjectURL(shown);
  }, [shown]);

  return shown ? <img src={shown} alt={alt} decoding="async" draggable={false} className={IMAGE_CLASS} /> : null;
}

/**
 * Area mode's drawing surface. A mouse or pen draws at once; a finger scrolls
 * as usual and draws after resting for a moment, and a rest without a drag
 * marks a box around that spot.
 */
function AreaLayer({
  page,
  pageElement,
  onArea,
}: {
  page: number;
  pageElement: RefObject<HTMLDivElement | null>;
  onArea: (page: number, rect: Rect, element: HTMLElement) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const drawing = useRef<{ pointerId: number; touch: boolean } | null>(null);
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);

  const pointAt = (clientX: number, clientY: number) => {
    const box = pageElement.current!.getBoundingClientRect();
    return { x: clamp01((clientX - box.left) / box.width), y: clamp01((clientY - box.top) / box.height) };
  };

  // While a finger draws, keep the panel from scrolling under it.
  useEffect(() => {
    const target = layer.current;
    if (!target) return;
    const onTouchMove = (event: TouchEvent) => {
      if (drawing.current) event.preventDefault();
    };
    target.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => target.removeEventListener("touchmove", onTouchMove);
  }, []);

  useEffect(
    () => () => {
      if (hold.current) window.clearTimeout(hold.current.timer);
    },
    [],
  );

  const cancel = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
    drawing.current = null;
    setDraft(null);
  };

  const rect: Rect | null = draft
    ? {
        x: Math.min(draft.x0, draft.x1),
        y: Math.min(draft.y0, draft.y1),
        w: Math.abs(draft.x1 - draft.x0),
        h: Math.abs(draft.y1 - draft.y0),
      }
    : null;

  return (
    <>
      {rect ? (
        <div
          className="pointer-events-none absolute z-10 min-h-1.5 min-w-1.5 border-2 border-dashed border-primary bg-primary/10"
          style={boxStyle(rect)}
        />
      ) : null}
      <div
        ref={layer}
        // bb's swipe gestures (open the sidebar, close the panel) stay off while drawing.
        data-no-sidebar-swipe=""
        data-no-secondary-panel-swipe=""
        className="absolute inset-0 z-20 cursor-crosshair [-webkit-touch-callout:none]"
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          // A second finger means a pinch, not a box.
          if (hold.current || drawing.current) {
            cancel();
            return;
          }
          if (event.button !== 0 || !pageElement.current) return;
          const start = pointAt(event.clientX, event.clientY);
          if (event.pointerType === "touch") {
            const pointerId = event.pointerId;
            const timer = window.setTimeout(() => {
              hold.current = null;
              drawing.current = { pointerId, touch: true };
              setDraft({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
              navigator.vibrate?.(10);
            }, HOLD_MS);
            hold.current = { timer, x: event.clientX, y: event.clientY };
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          drawing.current = { pointerId: event.pointerId, touch: false };
          setDraft({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
        }}
        onPointerMove={(event) => {
          const pending = hold.current;
          if (pending) {
            // Moving before the hold ends is a scroll.
            if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8) cancel();
            return;
          }
          if (drawing.current?.pointerId !== event.pointerId) return;
          const point = pointAt(event.clientX, event.clientY);
          setDraft((current) => (current ? { ...current, x1: point.x, y1: point.y } : current));
        }}
        onPointerUp={(event) => {
          if (hold.current) {
            cancel();
            return;
          }
          const active = drawing.current;
          if (active?.pointerId !== event.pointerId) return;
          drawing.current = null;
          setDraft(null);
          const element = pageElement.current;
          if (!rect || !element) return;
          if (rect.w >= MIN_AREA && rect.h >= MIN_AREA) onArea(page, rect, element);
          else if (active.touch) onArea(page, boxAround(rect.x, rect.y), element);
        }}
        onPointerCancel={cancel}
      />
    </>
  );
}

interface PageViewProps {
  page: PageInfo;
  kind: DocKind;
  box: PageBox;
  /** Near the viewport: the page shows its image, words, and comments. */
  mounted: boolean;
  imageUrl: string;
  lines: PageWord[][] | undefined;
  mode: PageMode;
  /** Comments anchored on this page. */
  comments: readonly ReviewComment[];
  /** The active comment when it is on this page. */
  activeId: string | null;
  live: LiveSelection | null;
  pending: Anchor | null;
  onStale: () => void;
  onSelectComment: (id: string) => void;
  onArea: (page: number, rect: Rect, element: HTMLElement) => void;
}

const PageView = memo(function PageView({
  page,
  kind,
  box,
  mounted,
  imageUrl,
  lines,
  mode,
  comments,
  activeId,
  live,
  pending,
  onStale,
  onSelectComment,
  onArea,
}: PageViewProps) {
  const element = useRef<HTMLDivElement>(null);
  // Pages flown past while scrolling never start loading.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!mounted) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [mounted]);

  // Clicking highlighted text (with no selection) opens its comment.
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (mode !== "text") return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const rect = element.current!.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const hit = comments.find((comment) => {
      const anchor = comment.anchor;
      if (anchor.kind === "page-text") return anchor.rects.some((part) => contains(part, x, y));
      if (anchor.kind === "page-area") return contains(anchor.rect, x, y);
      return false;
    });
    if (hit) onSelectComment(hit.id);
  };

  const shown = comments.filter((comment) => comment.status !== "resolved" || comment.id === activeId);

  return (
    <div
      ref={element}
      data-page={page.n}
      className={cn(
        "@container shrink-0 overflow-hidden rounded-md border border-border bg-muted shadow-sm",
        box.stickyLeft === null ? "relative" : "sticky",
      )}
      style={{ width: box.width, height: box.height, marginLeft: box.left, left: box.stickyLeft ?? undefined }}
      onClick={onClick}
    >
      {mounted ? (
        <>
          {settled ? <PageImage url={imageUrl} alt={`${pageNoun(kind)} ${page.n}`} onError={onStale} /> : null}

          {/* Existing comments, the live selection, and the comment being written. */}
          <div className="pointer-events-none absolute inset-0 z-10">
            {shown.map((comment) => {
              const anchor = comment.anchor;
              if (anchor.kind !== "page-text" && anchor.kind !== "page-area") return null;
              const active = comment.id === activeId;
              const rects = anchor.kind === "page-text" ? anchor.rects : [anchor.rect];
              return rects.map((rect, index) => (
                <div
                  key={`${comment.id}:${index}`}
                  className={cn(
                    "absolute rounded-[2px]",
                    anchor.kind === "page-area"
                      ? active
                        ? "border-2 border-primary bg-primary/15"
                        : "border-2 border-primary/70 bg-primary/5"
                      : active
                        ? "bg-primary/35"
                        : "bg-primary/20",
                  )}
                  style={boxStyle(rect)}
                />
              ));
            })}
            {live
              ? live.rects.map((rect, index) => (
                  <div key={`live:${index}`} className="absolute rounded-[2px] bg-primary/30" style={boxStyle(rect)} />
                ))
              : null}
            {pending && (pending.kind === "page-text" || pending.kind === "page-area")
              ? (pending.kind === "page-text" ? pending.rects : [pending.rect]).map((rect, index) => (
                  <div
                    key={`pending:${index}`}
                    className={cn(
                      "absolute rounded-[2px]",
                      pending.kind === "page-area" ? "border-2 border-dashed border-primary bg-primary/10" : "bg-primary/35",
                    )}
                    style={boxStyle(rect)}
                  />
                ))
              : null}
          </div>

          {lines ? <TextLayer lines={lines} aspect={page.height / page.width} /> : null}

          <div className="pointer-events-none absolute inset-0 z-30">
            {shown.map((comment) => {
              const anchor = comment.anchor;
              if (anchor.kind !== "page-text" && anchor.kind !== "page-area") return null;
              const first = anchor.kind === "page-text" ? anchor.rects[0]! : anchor.rect;
              return (
                <Pin
                  key={comment.id}
                  seq={comment.seq}
                  rect={first}
                  active={comment.id === activeId}
                  resolved={comment.status === "resolved"}
                  onClick={() => onSelectComment(comment.id)}
                />
              );
            })}
          </div>

          {mode === "area" ? <AreaLayer page={page.n} pageElement={element} onArea={onArea} /> : null}
        </>
      ) : null}

      <div className="pointer-events-none absolute bottom-1.5 right-2 z-30 rounded bg-background/80 px-1.5 text-[10px] tabular-nums text-muted-foreground">
        {page.n}
      </div>
    </div>
  );
});

interface Gesture {
  source: "wheel" | "safari" | "touch";
  zoom0: number;
  /** Scale relative to zoom0, kept within the zoom limits. */
  scale: number;
  /** Where the gesture started and where it is now, in viewport pixels. */
  x0: number;
  y0: number;
  x: number;
  y: number;
  anchor: ZoomAnchor | null;
  /** Finger distance at the start of a pinch. */
  spread0: number;
  timer: number;
}

export function PagesDoc({
  docId,
  kind,
  version,
  pages,
  mode,
  comments,
  activeId,
  scrollRequest,
  scroller,
  overlay,
  coveredBottom,
  pendingAnchor,
  composer,
  composerPoint,
  onStale,
  onRequestComment,
  onSelectComment,
}: {
  docId: string;
  kind: DocKind;
  version: string;
  pages: PageInfo[];
  mode: PageMode;
  comments: ReviewComment[];
  activeId: string | null;
  scrollRequest: number;
  scroller: RefObject<HTMLElement | null>;
  /** Layer over the view for the zoom bar; it stays put while pages scroll. */
  overlay: HTMLElement | null;
  /** Share of the view's height covered from below (the comment sheet on a phone). */
  coveredBottom: number;
  pendingAnchor: Anchor | null;
  composer: ReactNode;
  composerPoint: Point | null;
  onStale: () => void;
  onRequestComment: (anchor: Anchor, point: Point) => void;
  onSelectComment: (id: string) => void;
}) {
  const rpc = useReviewRpc();
  const root = useRef<HTMLDivElement>(null);
  const [texts, setTexts] = useState<Map<number, PageWord[][]>>(new Map());
  const textsRef = useRef(texts);
  textsRef.current = texts;
  const requested = useRef(new Set<number>());
  const [live, setLive] = useState<LiveSelection | null>(null);
  const [button, setButton] = useState<{ point: Point; anchor: Anchor } | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [range, setRange] = useState({ first: 0, last: -1 });
  const [current, setCurrent] = useState(1);
  const [coarse] = useState(() => window.matchMedia?.(COARSE_POINTER).matches ?? false);

  const layout = useMemo(() => computeLayout(pages, viewportWidth, zoom), [pages, viewportWidth, zoom]);
  const layoutRef = useRef(layout);
  /** Where to put the view after the next layout: set by zooms and resizes. */
  const pendingScroll = useRef<ZoomAnchor | null>(null);

  // Page text belongs to one file version.
  useEffect(() => {
    requested.current = new Set();
    setTexts(new Map());
  }, [docId, version]);

  const loadText = useCallback(
    (n: number) => {
      if (requested.current.has(n)) return;
      requested.current.add(n);
      rpc.call("doc.pageText", { docId, version, n }).then(
        (result) => setTexts((current) => new Map(current).set(n, result.lines)),
        (cause: unknown) => {
          requested.current.delete(n);
          if (/changed/i.test(errorText(cause))) onStale();
        },
      );
    },
    [rpc, docId, version, onStale],
  );

  /** Which pages are near the viewport, and which one is being read. */
  const updateView = useCallback(() => {
    const element = scroller.current;
    const { boxes } = layoutRef.current;
    if (!element || boxes.length === 0) return;
    const top = element.scrollTop;
    const height = element.clientHeight;
    const buffer = Math.max(height, 600);
    const first = indexAt(boxes, top - buffer);
    const last = indexAt(boxes, top + height + buffer);
    setRange((current) => (current.first === first && current.last === last ? current : { first, last }));
    setCurrent(indexAt(boxes, top + height * 0.3) + 1);
  }, [scroller]);

  // Lay pages out for the panel's width; a new width keeps the reading place.
  const widthRef = useRef(0);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      if (width === widthRef.current) {
        updateView();
        return;
      }
      if (widthRef.current > 0 && !pendingScroll.current) {
        pendingScroll.current = anchorAt(
          layoutRef.current,
          { left: element.scrollLeft, top: element.scrollTop },
          width / 2,
          0,
        );
      }
      widthRef.current = width;
      setViewportWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller, updateView]);

  // After a new layout, put the anchored point back where it was on screen.
  useLayoutEffect(() => {
    layoutRef.current = layout;
    const element = scroller.current;
    const anchor = pendingScroll.current;
    pendingScroll.current = null;
    if (element && anchor) {
      const next = scrollFor(layout, anchor);
      if (next) {
        element.scrollTop = next.top;
        if (next.left !== null) element.scrollLeft = next.left;
      }
    }
    updateView();
  }, [layout, scroller, updateView]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const onScroll = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          updateView();
        });
      }
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scroller, updateView]);

  // Words for the pages that stay near the viewport.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (let index = range.first; index <= range.last; index += 1) loadText(index + 1);
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [range, loadText]);

  const zoomTo = useCallback(
    (next: number, at?: { x: number; y: number }) => {
      const element = scroller.current;
      if (!element) return;
      const target = clampZoom(next);
      if (Math.abs(target - zoomRef.current) < 1e-3) return;
      pendingScroll.current = anchorAt(
        layoutRef.current,
        { left: element.scrollLeft, top: element.scrollTop },
        at?.x ?? element.clientWidth / 2,
        at?.y ?? element.clientHeight / 2,
      );
      setZoom(target);
    },
    [scroller],
  );

  // Pinch and Ctrl-wheel zoom: the column scales as a picture while the
  // gesture runs, then lays out once at the new zoom.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let gesture: Gesture | null = null;

    const local = (clientX: number, clientY: number) => {
      const box = element.getBoundingClientRect();
      return { x: clientX - box.left, y: clientY - box.top };
    };
    const begin = (source: Gesture["source"], x: number, y: number): Gesture => ({
      source,
      zoom0: zoomRef.current,
      scale: 1,
      x0: x,
      y0: y,
      x,
      y,
      anchor: anchorAt(layoutRef.current, { left: element.scrollLeft, top: element.scrollTop }, x, y),
      spread0: 1,
      timer: 0,
    });
    const setScale = (active: Gesture, scale: number) => {
      active.scale = clampZoom(active.zoom0 * scale) / active.zoom0;
    };
    const preview = (active: Gesture) => {
      const content = root.current;
      if (!content) return;
      content.style.transformOrigin = `${element.scrollLeft + active.x0}px ${element.scrollTop + active.y0}px`;
      content.style.transform = `translate(${active.x - active.x0}px, ${active.y - active.y0}px) scale(${active.scale})`;
    };
    const finish = () => {
      const done = gesture;
      gesture = null;
      const content = root.current;
      if (content) {
        content.style.transform = "";
        content.style.transformOrigin = "";
      }
      if (!done) return;
      window.clearTimeout(done.timer);
      const anchor = done.anchor ? { ...done.anchor, ax: done.x, ay: done.y } : null;
      const next = clampZoom(done.zoom0 * done.scale);
      if (Math.abs(next - zoomRef.current) < 1e-3) {
        // Two fingers moved without pinching: scroll by the distance they went.
        const target = anchor ? scrollFor(layoutRef.current, anchor) : null;
        if (target) {
          element.scrollTop = target.top;
          if (target.left !== null) element.scrollLeft = target.left;
        }
        return;
      }
      pendingScroll.current = anchor;
      setZoom(next);
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (gesture && gesture.source !== "wheel") return;
      const { x, y } = local(event.clientX, event.clientY);
      const active = gesture ?? (gesture = begin("wheel", x, y));
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const delta = Math.max(-25, Math.min(25, event.deltaY * unit));
      setScale(active, active.scale * Math.exp(-delta / 100));
      preview(active);
      window.clearTimeout(active.timer);
      active.timer = window.setTimeout(finish, 180);
    };

    // Safari reports trackpad pinches as gesture events with a scale.
    type SafariGesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      if (gesture) return;
      const { clientX, clientY } = event as SafariGesture;
      const { x, y } = local(clientX, clientY);
      gesture = begin("safari", x, y);
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (gesture?.source !== "safari") return;
      setScale(gesture, (event as SafariGesture).scale);
      preview(gesture);
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      if (gesture?.source === "safari") finish();
    };

    const spread = (touches: TouchList) => {
      const a = touches[0]!;
      const b = touches[1]!;
      return {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        ...local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2),
      };
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      if (gesture) finish();
      const start = spread(event.touches);
      gesture = begin("touch", start.x, start.y);
      gesture.spread0 = Math.max(start.distance, 1);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (gesture?.source !== "touch" || event.touches.length !== 2) return;
      event.preventDefault();
      const now = spread(event.touches);
      gesture.x = now.x;
      gesture.y = now.y;
      setScale(gesture, now.distance / gesture.spread0);
      preview(gesture);
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (gesture?.source === "touch" && event.touches.length < 2) finish();
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("gesturestart", onGestureStart);
    element.addEventListener("gesturechange", onGestureChange);
    element.addEventListener("gestureend", onGestureEnd);
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
      if (gesture) window.clearTimeout(gesture.timer);
      const content = root.current;
      if (content) {
        content.style.transform = "";
        content.style.transformOrigin = "";
      }
    };
  }, [scroller]);

  /** Keeps a floating control inside the visible part of the column. */
  const clampToView = useCallback(
    (point: Point, width: number): Point => {
      const element = scroller.current;
      if (!element) return point;
      const min = element.scrollLeft + 8;
      const max = element.scrollLeft + element.clientWidth - width - 8;
      return { top: point.top, left: Math.max(min, Math.min(point.left, max)) };
    },
    [scroller],
  );

  /** Converts a point on a page element to coordinates inside the root. */
  const toRoot = useCallback(
    (pageElement: HTMLElement, x: number, y: number): Point => {
      const rootBox = root.current!.getBoundingClientRect();
      const box = pageElement.getBoundingClientRect();
      return clampToView(
        {
          top: box.top - rootBox.top + y * box.height + 8,
          left: box.left - rootBox.left + x * box.width - 40,
        },
        110,
      );
    },
    [clampToView],
  );

  // Text selections: read the selected words from the word layer.
  const computeSelection = useCallback((): (LiveSelection & { point: Point; anchor: Anchor }) | null => {
    const element = root.current;
    const selection = window.getSelection();
    if (!element || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.commonAncestorContainer)) return null;
    const startNode = range.startContainer;
    const startElement = startNode instanceof Element ? startNode : startNode.parentElement;
    const pageElement = startElement?.closest<HTMLElement>("[data-page]");
    const n = Number(pageElement?.dataset.page);
    const lines = texts.get(n);
    if (!pageElement || !lines) return null;
    const spans = pageElement.querySelectorAll<HTMLElement>("[data-textlayer] > span");
    const picked = new Map<number, PageWord[]>();
    for (const span of spans) {
      if (!range.intersectsNode(span)) continue;
      const li = Number(span.dataset.li);
      const word = lines[li]?.[Number(span.dataset.wi)];
      if (!word) continue;
      picked.set(li, [...(picked.get(li) ?? []), word]);
    }
    if (picked.size === 0) return null;
    const ordered = [...picked.entries()].sort(([a], [b]) => a - b);
    const rects = ordered.map(([, words]) => unionRect(words));
    const quote = ordered.map(([, words]) => words.map((word) => word[4]).join(" ")).join("\n");
    const last = rects[rects.length - 1]!;
    return {
      page: n,
      rects,
      quote,
      point: toRoot(pageElement, last.x + last.w, last.y + last.h),
      anchor: { kind: "page-text", page: n, quote: quote.slice(0, 4000), rects: rects.slice(0, 200) },
    };
  }, [texts, toRoot]);

  const hideButton = useRef(0);
  const readSelection = useCallback(() => {
    const candidate = computeSelection();
    window.clearTimeout(hideButton.current);
    if (candidate) {
      setLive({ page: candidate.page, rects: candidate.rects, quote: candidate.quote });
      setButton({ point: candidate.point, anchor: candidate.anchor });
      return;
    }
    setLive(null);
    // A tap on the button can clear the selection before the tap lands.
    hideButton.current = window.setTimeout(() => setButton(null), 350);
  }, [computeSelection]);
  useEffect(() => () => window.clearTimeout(hideButton.current), []);

  const commentOn = useCallback(
    (anchor: Anchor, point: Point) => {
      window.clearTimeout(hideButton.current);
      setButton(null);
      setLive(null);
      window.getSelection()?.removeAllRanges();
      onRequestComment(anchor, point);
    },
    [onRequestComment],
  );

  // Right-click on selected words offers Comment; elsewhere the usual menu stays.
  const [menu, setMenu] = useState<{ top: number; left: number; anchor: Anchor; quote: string } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (mode !== "text") return;
    const candidate = computeSelection();
    const element = root.current;
    if (!candidate || !element) return;
    event.preventDefault();
    const box = element.getBoundingClientRect();
    const point = clampToView({ top: event.clientY - box.top, left: event.clientX - box.left }, 190);
    setMenu({ ...point, anchor: candidate.anchor, quote: candidate.quote });
  };

  // Cmd+Option+M comments on the current selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCommentShortcut(event) || mode !== "text") return;
      const candidate = computeSelection();
      if (!candidate) return;
      event.preventDefault();
      commentOn(candidate.anchor, candidate.point);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [computeSelection, commentOn, mode]);

  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(readSelection, 120);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [readSelection]);

  // Switching modes drops a half-made selection.
  useEffect(() => {
    setLive(null);
    setButton(null);
    window.getSelection()?.removeAllRanges();
  }, [mode]);

  const onArea = useCallback(
    (n: number, rect: Rect, pageElement: HTMLElement) => {
      const words = (textsRef.current.get(n) ?? []).flat().filter((word) => inside(rect, word));
      const text = words.map((word) => word[4]).join(" ").slice(0, 4000);
      onRequestComment(
        { kind: "page-area", page: n, rect, text },
        toRoot(pageElement, rect.x + rect.w, rect.y + rect.h),
      );
    },
    [toRoot, onRequestComment],
  );

  // Scroll the active comment's region into view when the list asks.
  useEffect(() => {
    if (!scrollRequest || !activeId) return;
    const anchor = comments.find((candidate) => candidate.id === activeId)?.anchor;
    if (!anchor || (anchor.kind !== "page-text" && anchor.kind !== "page-area")) return;
    const element = scroller.current;
    const current = layoutRef.current;
    const box = current.boxes[anchor.page - 1];
    if (!element || !box) return;
    const rect = anchor.kind === "page-text" ? anchor.rects[0]! : anchor.rect;
    const visible = element.clientHeight * (1 - coveredBottom);
    const y = box.top + rect.y * box.height;
    const top = element.scrollTop;
    const needsY = y < top + 40 || y > top + visible - 60;
    // Sideways, bring the whole region in, its start first when it is wider than the view.
    let left = element.scrollLeft;
    if (box.stickyLeft === null) {
      const start = current.pad + box.left + rect.x * box.width;
      const end = start + rect.w * box.width;
      if (end > left + element.clientWidth - 24) left = end - element.clientWidth + 24;
      if (start < left + 24) left = start - 24;
    }
    const needsX = Math.abs(left - element.scrollLeft) > 1;
    if (!needsY && !needsX) return;
    element.scrollTo({
      top: needsY ? y - visible / 3 : top,
      left,
      // A jump across many pages goes straight there; so does one under the
      // comment sheet, whose own scrolling would cut a smooth one short.
      behavior: coveredBottom > 0 || Math.abs(y - top) > element.clientHeight * 3 ? "auto" : "smooth",
    });
  }, [scrollRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpTo = useCallback(
    (n: number) => {
      const element = scroller.current;
      const box = layoutRef.current.boxes[n - 1];
      if (element && box) element.scrollTop = box.top - layoutRef.current.pad;
    },
    [scroller],
  );

  // Per-page props that stay the same object while nothing on the page changes.
  const byPage = useMemo(() => {
    const map = new Map<number, ReviewComment[]>();
    for (const comment of comments) {
      const anchor = comment.anchor;
      if (anchor.kind !== "page-text" && anchor.kind !== "page-area") continue;
      map.set(anchor.page, [...(map.get(anchor.page) ?? []), comment]);
    }
    return map;
  }, [comments]);
  const activePage = useMemo(() => {
    const anchor = comments.find((comment) => comment.id === activeId)?.anchor;
    return anchor && (anchor.kind === "page-text" || anchor.kind === "page-area") ? anchor.page : null;
  }, [comments, activeId]);
  const pendingPage =
    pendingAnchor && (pendingAnchor.kind === "page-text" || pendingAnchor.kind === "page-area")
      ? pendingAnchor.page
      : null;

  const ratio = window.devicePixelRatio || 1;
  // Under the comment sheet, room below the last page lets it scroll into view.
  const covered = coveredBottom > 0 ? Math.round((scroller.current?.clientHeight ?? 0) * coveredBottom) : 0;
  const composerWidth = Math.max(200, Math.min(352, (scroller.current?.clientWidth ?? 368) - 16));
  const noun = pageNoun(kind);

  return (
    <div
      ref={root}
      // While words are selected here, a sideways drag is not bb's sidebar swipe.
      data-sidebar-swipe-selectable=""
      className={cn("doc-review-pages relative flex flex-col items-start", mode === "area" && "select-none")}
      style={{
        width: layout.width,
        padding: layout.pad,
        paddingBottom: layout.pad + Math.max(BOTTOM_ROOM, covered),
        gap: PAGE_GAP,
      }}
      onContextMenu={onContextMenu}
    >
      {menu ? (
        <SelectionMenu
          top={menu.top}
          left={menu.left}
          quote={menu.quote}
          onClose={closeMenu}
          onComment={() => commentOn(menu.anchor, { top: menu.top + 4, left: menu.left })}
        />
      ) : null}
      {viewportWidth > 0
        ? pages.map((page, index) => {
            const box = layout.boxes[index]!;
            return (
              <PageView
                key={`${version}:${page.n}`}
                page={page}
                kind={kind}
                box={box}
                mounted={index >= range.first && index <= range.last}
                imageUrl={`${page.url}&w=${pageImageWidth(box.width, ratio)}`}
                lines={texts.get(page.n)}
                mode={mode}
                comments={byPage.get(page.n) ?? NO_COMMENTS}
                activeId={activePage === page.n ? activeId : null}
                live={live && live.page === page.n ? live : null}
                pending={pendingPage === page.n ? pendingAnchor : null}
                onStale={onStale}
                onSelectComment={onSelectComment}
                onArea={onArea}
              />
            );
          })
        : null}
      {button && !composer && mode === "text" ? (
        <button
          type="button"
          className="absolute z-40 inline-flex items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent"
          style={{ top: button.point.top, left: button.point.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            commentOn(button.anchor, button.point);
          }}
        >
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Comment
        </button>
      ) : null}
      {composer && composerPoint ? (
        <div
          className="absolute z-50"
          style={{
            top: composerPoint.top,
            left: clampToView(composerPoint, composerWidth).left,
            width: composerWidth,
          }}
        >
          {composer}
        </div>
      ) : null}
      {overlay
        ? createPortal(
            <>
              {mode === "area" && coarse ? (
                <div className="absolute inset-x-0 top-2 flex justify-center">
                  <span className="rounded-full border border-border bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                    Hold, then drag to mark an area
                  </span>
                </div>
              ) : null}
              <div className="absolute bottom-3 right-3">
                <ZoomBar
                  zoom={zoom}
                  page={current}
                  count={pages.length}
                  noun={noun}
                  onStep={(direction) => zoomTo(stepZoom(zoomRef.current, direction))}
                  onFit={() => zoomTo(1)}
                  onJump={jumpTo}
                />
              </div>
            </>,
            overlay,
          )
        : null}
    </div>
  );
}
