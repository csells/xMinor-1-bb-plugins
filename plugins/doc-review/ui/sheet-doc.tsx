// Spreadsheet view: the workbook grid (components/spreadsheet, from the former
// Document Viewer), plus cell comments. Click or drag over cells to select a
// cell or a range, then comment on it; commented cells carry a mark in the
// corner. On a touch screen a tap picks a cell and a drag scrolls; resting a
// finger on a cell first makes the drag select a range. The grid renders rows lazily while scrolling, so selection and
// comment marks are painted as data attributes on the cells that exist and
// repainted whenever rows mount.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { SpreadsheetView } from "@/components/spreadsheet/SpreadsheetView";
import { Icon } from "@/components/ui/icon";
import type { SheetData } from "@/lib/sheet-model";
import type { WorkbookSummary } from "../src/contract";
import type { Anchor, ReviewComment } from "../src/types";
import type { Point } from "./markdown-doc";
import { isCommentShortcut, SelectionMenu } from "./selection-menu";
import { errorText, useReviewRpc } from "./use-review";

/** Sheets kept in the browser; each can hold up to 100k cells. */
const KEPT_SHEETS = 6;
/** How long a finger rests on a cell before a drag selects a range instead of scrolling. */
const HOLD_MS = 300;

interface CellRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function rangeRef(range: CellRange): string {
  const start = `${columnName(range.c1)}${range.r1 + 1}`;
  const end = `${columnName(range.c2)}${range.r2 + 1}`;
  return start === end ? start : `${start}:${end}`;
}

export function parseRef(ref: string): CellRange | null {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref);
  if (!match) return null;
  const col = (letters: string) => [...letters].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
  const r1 = Number(match[2]) - 1;
  const c1 = col(match[1]!);
  const r2 = match[4] ? Number(match[4]) - 1 : r1;
  const c2 = match[3] ? col(match[3]) : c1;
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
}

function normalize(a: { r: number; c: number }, b: { r: number; c: number }): CellRange {
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}

function cellAt(target: EventTarget | null): { r: number; c: number; r2: number; c2: number } | null {
  const td = (target as Element | null)?.closest?.("td[data-r][data-c]");
  if (!(td instanceof HTMLElement)) return null;
  const r = Number(td.dataset.r);
  const c = Number(td.dataset.c);
  if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
  return { r, c, r2: Number(td.dataset.r2 ?? r), c2: Number(td.dataset.c2 ?? c) };
}

/** Displayed text of a range, row by row, from the sheet model. */
function rangeText(sheet: SheetData, range: CellRange): string {
  const lines: string[] = [];
  for (const row of sheet.rows) {
    if (row.row < range.r1 || row.row > range.r2) continue;
    const values = row.cells
      .filter((cell) => cell.col >= range.c1 && cell.col <= range.c2 && cell.text)
      .map((cell) => cell.text);
    if (values.length > 0) lines.push(values.join(" | "));
  }
  return lines.join("\n").slice(0, 4000);
}

function inRange(range: CellRange, r: number, c: number): boolean {
  return r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
}

export function SheetDoc({
  docId,
  initial,
  comments,
  activeId,
  scrollRequest,
  pendingAnchor,
  composer,
  composerPoint,
  onRequestComment,
  onSelectComment,
}: {
  docId: string;
  initial: { workbook: WorkbookSummary; sheet: SheetData };
  comments: ReviewComment[];
  activeId: string | null;
  scrollRequest: number;
  pendingAnchor: Anchor | null;
  composer: ReactNode;
  composerPoint: Point | null;
  onRequestComment: (anchor: Anchor, point: Point) => void;
  onSelectComment: (id: string) => void;
}) {
  const rpc = useReviewRpc();
  const root = useRef<HTMLDivElement>(null);
  const { workbook } = initial;
  const [sheets, setSheets] = useState<Map<number, SheetData>>(() => new Map([[initial.sheet.index, initial.sheet]]));
  const [selected, setSelected] = useState(initial.sheet.index);
  const [shown, setShown] = useState<SheetData>(initial.sheet);
  const [loadingSheet, setLoadingSheet] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;

  const [selection, setSelection] = useState<CellRange | null>(null);
  const [button, setButton] = useState<Point | null>(null);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const drag = useRef<{ start: { r: number; c: number }; moved: boolean } | null>(null);
  const hold = useRef<{ timer: number; x: number; y: number; cell: NonNullable<ReturnType<typeof cellAt>> } | null>(
    null,
  );
  /** A finger is dragging over cells: the grid must not scroll under it. */
  const touchDrag = useRef(false);

  const cancelHold = useCallback(() => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  }, []);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onTouchMove = (event: TouchEvent) => {
      if (touchDrag.current) event.preventDefault();
    };
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      element.removeEventListener("touchmove", onTouchMove);
      cancelHold();
    };
  }, [cancelHold]);

  const onSelectSheet = useCallback(
    (index: number) => {
      const request = ++latestRequest.current;
      setSelected(index);
      setError(null);
      setSelection(null);
      setButton(null);
      const cached = sheetsRef.current.get(index);
      if (cached) {
        setShown(cached);
        setLoadingSheet(null);
        return;
      }
      setLoadingSheet(index);
      rpc.call("sheet.read", { docId, index, locale: navigator.language || "en-US" }).then(
        ({ sheet }) => {
          setSheets((previous) => {
            const next = new Map(previous).set(index, sheet);
            while (next.size > KEPT_SHEETS) next.delete(next.keys().next().value!);
            return next;
          });
          if (request !== latestRequest.current) return;
          setShown(sheet);
          setLoadingSheet(null);
        },
        (cause: unknown) => {
          if (request !== latestRequest.current) return;
          setLoadingSheet(null);
          setError(errorText(cause));
        },
      );
    },
    [rpc, docId],
  );

  // Comments on the sheet on screen, with their ranges.
  const sheetComments = comments
    .map((comment) => {
      const anchor = comment.anchor;
      if (anchor.kind !== "cell" || anchor.sheetIndex !== shown.index) return null;
      const range = parseRef(anchor.ref);
      return range ? { comment, range } : null;
    })
    .filter((entry): entry is { comment: ReviewComment; range: CellRange } => entry !== null)
    .filter(({ comment }) => comment.status !== "resolved" || comment.id === activeId);
  const pendingRange =
    pendingAnchor?.kind === "cell" && pendingAnchor.sheetIndex === shown.index ? parseRef(pendingAnchor.ref) : null;

  // Paint selection and comment marks onto the cells that exist right now.
  const paintState = useRef({ sheetComments, selection, pendingRange, activeId });
  paintState.current = { sheetComments, selection, pendingRange, activeId };
  const paint = useCallback(() => {
    const element = root.current;
    if (!element) return;
    const state = paintState.current;
    for (const td of element.querySelectorAll<HTMLElement>("td[data-r][data-c]")) {
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      const selectedHere =
        (state.selection && inRange(state.selection, r, c)) || (state.pendingRange && inRange(state.pendingRange, r, c));
      const hits = state.sheetComments.filter(({ range }) => inRange(range, r, c));
      const pin = state.sheetComments.find(({ range }) => range.r1 === r && range.c1 === c);
      const active = hits.some(({ comment }) => comment.id === state.activeId);
      setAttr(td, "data-dr-sel", selectedHere ? "" : null);
      setAttr(td, "data-dr-comment", hits.length > 0 ? "" : null);
      setAttr(td, "data-dr-active", active ? "" : null);
      setAttr(td, "data-dr-pin", pin ? String(pin.comment.seq) : null);
      // The number lives in the tooltip; the corner mark stays small.
      if (pin) {
        setAttr(td, "title", `Comment ${pin.comment.seq}`);
        setAttr(td, "data-dr-title", "");
      } else if (td.hasAttribute("data-dr-title")) {
        td.removeAttribute("title");
        td.removeAttribute("data-dr-title");
      }
    }
  }, []);

  useEffect(paint, [paint, shown, selection, pendingRange?.r1, pendingRange?.c1, pendingRange?.r2, pendingRange?.c2, activeId, comments]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          paint();
        });
      }
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [paint]);

  /** Where the Comment button goes: below the range's last visible cell. */
  const pointFor = useCallback((range: CellRange): Point | null => {
    const element = root.current;
    if (!element) return null;
    let bottom = -Infinity;
    let right = -Infinity;
    for (const td of element.querySelectorAll<HTMLElement>("td[data-r][data-c]")) {
      if (!inRange(range, Number(td.dataset.r), Number(td.dataset.c))) continue;
      const rect = td.getBoundingClientRect();
      bottom = Math.max(bottom, rect.bottom);
      right = Math.max(right, rect.right);
    }
    if (!Number.isFinite(bottom)) return null;
    const box = element.getBoundingClientRect();
    return {
      top: Math.min(bottom - box.top + 6, box.height - 40),
      left: Math.max(8, Math.min(right - box.left - 60, box.width - 180)),
    };
  }, []);

  const anchorFor = useCallback(
    (range: CellRange): Anchor => ({
      kind: "cell",
      sheet: shown.name,
      sheetIndex: shown.index,
      ref: rangeRef(range),
      text: rangeText(shown, range),
    }),
    [shown],
  );

  const commentOnSelection = useCallback(() => {
    if (!selection) return;
    const point = pointFor(selection) ?? { top: 40, left: 40 };
    setButton(null);
    onRequestComment(anchorFor(selection), point);
  }, [selection, pointFor, anchorFor, onRequestComment]);

  // Selecting cells: press, drag, release; Shift extends from the current start.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || composer) return;
    const cell = cellAt(event.target);
    if (!cell) return;
    if (event.pointerType === "touch") {
      cancelHold();
      const timer = window.setTimeout(() => {
        hold.current = null;
        touchDrag.current = true;
        drag.current = { start: { r: cell.r, c: cell.c }, moved: false };
        setSelection(normalize({ r: cell.r, c: cell.c }, { r: cell.r2, c: cell.c2 }));
        setButton(null);
        navigator.vibrate?.(10);
      }, HOLD_MS);
      hold.current = { timer, x: event.clientX, y: event.clientY, cell };
      return;
    }
    const start = event.shiftKey && selection ? { r: selection.r1, c: selection.c1 } : { r: cell.r, c: cell.c };
    drag.current = { start, moved: false };
    setSelection(normalize(start, { r: cell.r2, c: cell.c2 }));
    setButton(null);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = hold.current;
    if (pending) {
      // Moving before the hold ends is a scroll.
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8) cancelHold();
      return;
    }
    const current = drag.current;
    if (!current || (event.buttons & 1) === 0) return;
    const cell = cellAt(document.elementFromPoint(event.clientX, event.clientY));
    if (!cell) return;
    current.moved = true;
    setSelection(normalize(current.start, { r: cell.r2, c: cell.c2 }));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = hold.current;
    if (pending) {
      // A tap picks the cell, and opens its comment when it has one.
      cancelHold();
      const { cell } = pending;
      const range = normalize({ r: cell.r, c: cell.c }, { r: cell.r2, c: cell.c2 });
      setSelection(range);
      const hit = sheetComments.find(({ range: commented }) => inRange(commented, cell.r, cell.c));
      if (hit) onSelectComment(hit.comment.id);
      setButton(pointFor(range));
      return;
    }
    touchDrag.current = false;
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    const cell = cellAt(event.target);
    const range = selectionRef.current;
    if (!range) return;
    // A plain click on a commented cell opens its comment too.
    if (!current.moved && cell) {
      const hit = sheetComments.find(({ range: commented }) => inRange(commented, cell.r, cell.c));
      if (hit) onSelectComment(hit.comment.id);
    }
    setButton(pointFor(range));
  };
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const cell = cellAt(event.target);
    const element = root.current;
    if (!cell || !element) return;
    event.preventDefault();
    if (!selection || !inRange(selection, cell.r, cell.c)) setSelection({ r1: cell.r, c1: cell.c, r2: cell.r2, c2: cell.c2 });
    const box = element.getBoundingClientRect();
    setMenu({ top: event.clientY - box.top, left: Math.min(event.clientX - box.left, box.width - 190) });
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCommentShortcut(event) || !selectionRef.current) return;
      if (!root.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      event.preventDefault();
      commentOnSelection();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [commentOnSelection]);

  // The list asks to show a comment: switch to its sheet, then bring its cell into view.
  useEffect(() => {
    if (!scrollRequest || !activeId) return;
    const anchor = comments.find((comment) => comment.id === activeId)?.anchor;
    if (anchor?.kind !== "cell") return;
    if (anchor.sheetIndex !== selected) {
      onSelectSheet(anchor.sheetIndex);
      return;
    }
    const range = parseRef(anchor.ref);
    if (!range) return;
    let tries = 0;
    const reveal = () => {
      const td = root.current?.querySelector<HTMLElement>(`td[data-r="${range.r1}"][data-c="${range.c1}"]`);
      if (td) {
        td.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
        return;
      }
      // Rows mount lazily: jump near the row, then look again.
      const scroller = root.current?.querySelector<HTMLElement>(".ssv-scroller");
      if (scroller && shown.rowCount > 0) {
        scroller.scrollTop = (scroller.scrollHeight * range.r1) / shown.rowCount;
      }
      if (++tries < 6) requestAnimationFrame(reveal);
    };
    reveal();
  }, [scrollRequest, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={root}
      // Sideways drags belong to the grid, not to bb's sidebar and panel swipes.
      data-no-sidebar-swipe=""
      data-no-secondary-panel-swipe=""
      className="doc-review-sheet relative flex h-full min-h-0 flex-col"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        cancelHold();
        touchDrag.current = false;
        drag.current = null;
      }}
      onContextMenu={onContextMenu}
    >
      <SpreadsheetView
        workbook={workbook}
        selectedSheet={selected}
        sheet={shown}
        loadingSheet={loadingSheet}
        error={error}
        onSelectSheet={onSelectSheet}
      />
      {menu && selection ? (
        <SelectionMenu
          top={menu.top}
          left={menu.left}
          quote={rangeText(shown, selection)}
          onClose={closeMenu}
          onComment={commentOnSelection}
        />
      ) : null}
      {button && selection && !composer ? (
        <button
          type="button"
          className="absolute z-40 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent"
          style={{ top: button.top, left: button.left }}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            commentOnSelection();
          }}
        >
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Comment on {rangeRef(selection)}
        </button>
      ) : null}
      {composer && composerPoint ? (
        <div
          className="absolute z-50 w-[min(22rem,calc(100%-1rem))]"
          style={{
            top: composerPoint.top,
            left: `min(${Math.max(composerPoint.left, 8)}px, calc(100% - min(22rem, calc(100% - 1rem)) - 0.5rem))`,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          {composer}
        </div>
      ) : null}
    </div>
  );
}

function setAttr(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}
