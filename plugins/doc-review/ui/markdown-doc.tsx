// Markdown view: renders the file block by block with bb's own Markdown
// component, turns a text selection into a line-anchored comment, and marks
// existing comments with highlights and numbered pins in the margin.
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
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Anchor, ReviewComment } from "../src/types";
import { narrowLines, rewriteImages, splitBlocks, type MdBlock } from "./md-blocks";
import { isCommentShortcut, SelectionMenu } from "./selection-menu";
import {
  clearHighlights,
  contextAround,
  findQuoteRange,
  setHighlights,
} from "./text-ranges";

export interface Point {
  top: number;
  left: number;
}

interface SelectionCandidate {
  anchor: Anchor;
  point: Point;
  range: Range;
}

interface Pin {
  id: string;
  seq: number;
  top: number;
  status: ReviewComment["status"];
}

const Block = memo(function Block({ block }: { block: MdBlock }) {
  return (
    <div data-block="" data-start={block.start} data-end={block.end} className="doc-review-block">
      <Markdown content={block.markdown} />
    </div>
  );
});

function closestBlock(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest<HTMLElement>("[data-block]") ?? null;
}

function caretRangeAt(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  return range;
}

export function MarkdownDoc({
  instanceId,
  content,
  assetBaseUrl,
  comments,
  activeId,
  scrollRequest,
  scroller,
  coveredBottom,
  pendingRange,
  composer,
  composerPoint,
  onRequestComment,
  onSelectComment,
  onDetached,
}: {
  instanceId: string;
  content: string;
  assetBaseUrl: string | null;
  comments: ReviewComment[];
  activeId: string | null;
  /** Changes when the list asks to scroll to the active comment. */
  scrollRequest: number;
  scroller: RefObject<HTMLElement | null>;
  /** Share of the view's height covered from below (the comment sheet on a phone). */
  coveredBottom: number;
  pendingRange: Range | null;
  composer: ReactNode;
  composerPoint: Point | null;
  onRequestComment: (anchor: Anchor, point: Point, range: Range) => void;
  onSelectComment: (id: string) => void;
  onDetached: (ids: Set<string>) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => {
    return splitBlocks(content).map((block) => ({
      ...block,
      markdown: rewriteImages(block.markdown, assetBaseUrl),
    }));
  }, [content, assetBaseUrl]);
  const sourceLines = useMemo(() => content.replace(/\r\n?/g, "\n").split("\n"), [content]);

  const [selection, setSelection] = useState<SelectionCandidate | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [layoutTick, setLayoutTick] = useState(0);
  const ranges = useRef(new Map<string, Range>());

  // Re-measure when the rendered DOM or the panel width changes.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0;
    const bump = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setLayoutTick((tick) => tick + 1));
    };
    const resize = new ResizeObserver(bump);
    resize.observe(element);
    const mutations = new MutationObserver(bump);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, []);

  useEffect(() => () => clearHighlights(instanceId), [instanceId]);

  // Resolve every comment to a DOM range, then paint highlights and pins.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const blockElements = [...element.querySelectorAll<HTMLElement>("[data-block]")];
    const found = new Map<string, Range>();
    const detached = new Set<string>();
    for (const comment of comments) {
      const anchor = comment.anchor;
      if (anchor.kind !== "md-text") continue;
      const scoped = blockElements.filter(
        (block) =>
          Number(block.dataset.end) >= anchor.startLine &&
          Number(block.dataset.start) <= anchor.endLine,
      );
      const range =
        findQuoteRange(scoped, anchor.quote, anchor.prefix) ??
        findQuoteRange(blockElements, anchor.quote, anchor.prefix);
      if (range) found.set(comment.id, range);
      else detached.add(comment.id);
    }
    ranges.current = found;

    const visible = comments.filter(
      (comment) => found.has(comment.id) && (comment.status !== "resolved" || comment.id === activeId),
    );
    setHighlights(instanceId, {
      comment: visible.filter((comment) => comment.id !== activeId).map((comment) => found.get(comment.id)!),
      active: activeId && found.has(activeId) ? [found.get(activeId)!] : [],
      pending: pendingRange ? [pendingRange] : [],
    });

    const rootTop = element.getBoundingClientRect().top;
    let lastTop = -Infinity;
    const nextPins: Pin[] = visible
      .map((comment) => {
        const range = found.get(comment.id)!;
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        return { id: comment.id, seq: comment.seq, status: comment.status, top: rect.top - rootTop };
      })
      .sort((a, b) => a.top - b.top)
      .map((pin) => {
        const top = Math.max(pin.top, lastTop + 22);
        lastTop = top;
        return { ...pin, top };
      });
    setPins(nextPins);
    onDetached(detached);
  }, [comments, activeId, pendingRange, layoutTick, blocks, instanceId, onDetached]);

  // Scroll the active comment into view when the list asks for it.
  useEffect(() => {
    if (!scrollRequest || !activeId) return;
    const range = ranges.current.get(activeId);
    const container = scroller.current;
    if (!range || !container) return;
    const rect = range.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const visible = box.height * (1 - coveredBottom);
    if (rect.top < box.top + 40 || rect.bottom > box.top + visible - 40) {
      container.scrollTo({
        top: container.scrollTop + rect.top - box.top - visible / 3,
        // Under the comment sheet the list scrolls too, which would cut a smooth scroll short.
        behavior: coveredBottom > 0 ? "auto" : "smooth",
      });
    }
  }, [scrollRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The comment a selection inside this view would create, or null. */
  const computeSelection = useCallback((): SelectionCandidate | null => {
    const element = root.current;
    const current = window.getSelection();
    if (!element || !current || current.rangeCount === 0 || current.isCollapsed) return null;
    const range = current.getRangeAt(0);
    if (!element.contains(range.commonAncestorContainer)) return null;
    const quote = range.toString().trim();
    const startBlock = closestBlock(range.startContainer);
    const endBlock = closestBlock(range.endContainer);
    if (!quote || !startBlock || !endBlock) return null;
    const lines = narrowLines(
      sourceLines,
      { start: Number(startBlock.dataset.start), end: Number(endBlock.dataset.end) },
      quote,
    );
    const { prefix, suffix } = contextAround(range, startBlock, endBlock);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      anchor: {
        kind: "md-text",
        quote: quote.slice(0, 4000),
        prefix,
        suffix,
        startLine: lines.start,
        endLine: Math.max(lines.start, lines.end),
      },
      point: {
        top: last.bottom - box.top + 6,
        left: Math.min(Math.max(last.right - box.left - 40, 8), box.width - 140),
      },
      range: range.cloneRange(),
    };
  }, [sourceLines]);

  const hideButton = useRef(0);
  const readSelection = useCallback(() => {
    const next = computeSelection();
    window.clearTimeout(hideButton.current);
    if (next) setSelection(next);
    // A tap on the button can clear the selection before the tap lands.
    else hideButton.current = window.setTimeout(() => setSelection(null), 350);
  }, [computeSelection]);
  useEffect(() => () => window.clearTimeout(hideButton.current), []);

  // Right-click on a selection offers Comment; elsewhere the usual menu stays.
  const [menu, setMenu] = useState<{ top: number; left: number; candidate: SelectionCandidate } | null>(
    null,
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const candidate = computeSelection();
    const element = root.current;
    if (!candidate || !element) return;
    event.preventDefault();
    const box = element.getBoundingClientRect();
    setMenu({
      top: event.clientY - box.top,
      left: Math.min(event.clientX - box.left, box.width - 190),
      candidate,
    });
  };

  // Cmd+Option+M comments on the current selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCommentShortcut(event)) return;
      const candidate = computeSelection();
      if (!candidate) return;
      event.preventDefault();
      setSelection(null);
      onRequestComment(candidate.anchor, candidate.point, candidate.range);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [computeSelection, onRequestComment]);

  // Mouse, keyboard, and touch selections all end up in selectionchange.
  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(readSelection, 180);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [readSelection]);

  // A click on highlighted text selects its comment.
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const current = window.getSelection();
    if (current && !current.isCollapsed) return;
    const caret = caretRangeAt(event.clientX, event.clientY);
    if (!caret) return;
    for (const [id, range] of ranges.current) {
      try {
        if (range.isPointInRange(caret.startContainer, caret.startOffset)) {
          onSelectComment(id);
          return;
        }
      } catch {
        // Ranges from a previous render can point at detached nodes.
      }
    }
  };

  // Under the comment sheet, room below the text lets its last lines scroll into view.
  const covered = coveredBottom > 0 ? Math.round((scroller.current?.clientHeight ?? 0) * coveredBottom) : 0;

  return (
    <div
      ref={root}
      // While text is selected here, a sideways drag is not bb's sidebar swipe.
      data-sidebar-swipe-selectable=""
      className="doc-review-md relative mx-auto w-full max-w-3xl py-5 pl-10 pr-5"
      style={covered > 0 ? { paddingBottom: covered + 20 } : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {menu ? (
        <SelectionMenu
          top={menu.top}
          left={menu.left}
          quote={menu.candidate.anchor.kind === "md-text" ? menu.candidate.anchor.quote : ""}
          onClose={closeMenu}
          onComment={() => {
            setSelection(null);
            onRequestComment(menu.candidate.anchor, { top: menu.top + 4, left: menu.left }, menu.candidate.range);
          }}
        />
      ) : null}
      {blocks.length === 0 ? (
        <p className="text-sm text-muted-foreground">This file is empty.</p>
      ) : (
        blocks.map((block) => <Block key={`${block.start}:${block.markdown.length}`} block={block} />)
      )}
      {pins.map((pin) => (
        <button
          key={pin.id}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelectComment(pin.id);
          }}
          className={cn(
            "absolute left-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold shadow-sm",
            pin.id === activeId
              ? "bg-primary text-primary-foreground ring-2 ring-primary/40"
              : pin.status === "resolved"
                ? "bg-muted text-muted-foreground"
                : "bg-primary/85 text-primary-foreground",
          )}
          style={{ top: pin.top }}
          aria-label={`Comment ${pin.seq}`}
        >
          {pin.seq}
        </button>
      ))}
      {selection && !composer ? (
        <button
          type="button"
          className="absolute z-10 inline-flex items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent"
          style={{ top: selection.point.top, left: selection.point.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            onRequestComment(selection.anchor, selection.point, selection.range);
            setSelection(null);
          }}
        >
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Comment
        </button>
      ) : null}
      {composer && composerPoint ? (
        <div
          className="absolute z-20 w-[min(22rem,calc(100%-1rem))]"
          style={{
            top: composerPoint.top,
            left: `min(${Math.max(composerPoint.left, 8)}px, calc(100% - min(22rem, calc(100% - 1rem)) - 0.5rem))`,
          }}
        >
          {composer}
        </div>
      ) : null}
    </div>
  );
}
