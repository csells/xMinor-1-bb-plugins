// The scrolling cell grid of one sheet: an HTML table with sticky headers
// and frozen panes. Only a window of rows around the viewport is in the DOM
// (frozen rows always are); spacers stand in for the rest, so the scrollbar
// covers the whole sheet and a jump anywhere renders only what is in view.
//
// Gridlines are the cells' right and bottom borders; a fill replaces them,
// as in Excel. Overflowing text is painted after all cell backgrounds, so it
// runs over empty neighbours; sticky frozen cells and headers cover the rest.
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  buildMergeIndex,
  buildSheetLayout,
  columnLetter,
  fitFrozen,
  nextRowWindow,
  rowHeaderWidth,
  safeRowCount,
  safeRowStart,
  type RowWindow,
  type SheetLayout,
} from "@/lib/sheet-layout";
import type { SheetData } from "@/lib/sheet-model";
import { GRIDLINE, HEADER_HEIGHT, Z } from "./paper";
import { PaddingRow, SheetRow, type GridContext } from "./SheetRow";

/** Rows rendered when a sheet opens, before the viewport is known. */
const INITIAL_ROWS = 150;
/** Rows kept rendered past each edge of the viewport, in screen px. */
const OVERSCAN_PX = 900;
/** The window moves once the viewport gets this many rows from its edge. */
const WINDOW_MARGIN = 8;
/** Window edges snap to multiples of this many rows. */
const WINDOW_CHUNK = 32;
/** Ctrl+wheel zoom takes one step per this many ms at most. */
const WHEEL_ZOOM_INTERVAL_MS = 120;

const layouts = new WeakMap<SheetData, SheetLayout>();

/** The sheet's layout, built once per sheet object and kept while it lives. */
export function layoutFor(sheet: SheetData): SheetLayout {
  let layout = layouts.get(sheet);
  if (!layout) {
    layout = buildSheetLayout(sheet);
    layouts.set(sheet, layout);
  }
  return layout;
}

function useViewportSize(ref: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

const HeaderRow = memo(function HeaderRow({
  ctx,
  restWidth,
}: {
  ctx: GridContext;
  restWidth: number;
}) {
  const { layout } = ctx;
  const restLetters: string[] = [];
  const firstRest = layout.sheet.colCount;
  for (let index = 0; index * layout.defaultColWidth < restWidth; index += 1) {
    restLetters.push(columnLetter(firstRest + index));
  }
  return (
    <tr style={{ height: HEADER_HEIGHT }}>
      <th scope="col" className="ssv-corner" aria-label="Row" />
      {layout.cols.map((col, pos) => {
        const frozen = pos < ctx.frozenCols;
        const previous = pos > 0 ? layout.cols[pos - 1] : -1;
        return (
          <th
            key={col}
            scope="col"
            className={
              col - previous > 1 ? "ssv-ch ssv-after-hidden" : "ssv-ch"
            }
            style={
              frozen
                ? {
                    left: ctx.headerWidth + layout.colLefts[pos],
                    zIndex: Z.frozenColHeader,
                  }
                : undefined
            }
          >
            {columnLetter(col)}
          </th>
        );
      })}
      <th className="ssv-ch ssv-rest" aria-hidden="true">
        <div className="ssv-rest-letters">
          {restLetters.map((letter) => (
            <span key={letter} style={{ width: layout.defaultColWidth }}>
              {letter}
            </span>
          ))}
        </div>
      </th>
    </tr>
  );
});

export interface SheetGridProps {
  sheet: SheetData;
  zoom: number;
  /** Ctrl/Cmd + wheel over the grid: 1 zooms in, -1 out. */
  onZoomStep: (direction: 1 | -1) => void;
}

export function SheetGrid({ sheet, zoom, onZoomStep }: SheetGridProps) {
  const layout = layoutFor(sheet);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewport = useViewportSize(scrollerRef);

  const headerWidth = rowHeaderWidth(Math.max(sheet.rowCount, 999));
  const frozenRows = fitFrozen(
    layout.rowTops,
    layout.frozenRows,
    HEADER_HEIGHT,
    viewport.height,
    zoom,
  );
  const frozenCols = fitFrozen(
    layout.colLefts,
    layout.frozenCols,
    headerWidth,
    viewport.width,
    zoom,
  );
  const merges = useMemo(
    () => buildMergeIndex(layout, frozenRows, frozenCols),
    [layout, frozenRows, frozenCols],
  );
  const gridColor = sheet.showGridLines ? GRIDLINE : "transparent";
  const ctx = useMemo<GridContext>(
    () => ({ layout, merges, frozenRows, frozenCols, headerWidth, gridColor }),
    [layout, merges, frozenRows, frozenCols, headerWidth, gridColor],
  );

  // The row window follows the scroll position; memoized rows that stay in
  // it do not re-render, and its edges never cut a merged range.
  const total = layout.rows.length;
  const [range, setRange] = useState<RowWindow>({
    start: 0,
    end: INITIAL_ROWS,
  });
  const start = Math.max(
    frozenRows,
    safeRowStart(merges, Math.min(range.start, total)),
  );
  const end = safeRowCount(merges, Math.max(range.end, start), total);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const scale = zoomRef.current;
      const top = root.scrollTop / scale - HEADER_HEIGHT;
      const bottom =
        (root.scrollTop + root.clientHeight) / scale - HEADER_HEIGHT;
      setRange((current) =>
        nextRowWindow(current, layout.rowTops, top, bottom, {
          overscan: OVERSCAN_PX / scale,
          margin: WINDOW_MARGIN,
          chunk: WINDOW_CHUNK,
        }),
      );
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [layout, zoom, viewport.height]);

  // Zooming keeps the same cells at the top-left of the viewport.
  const scroll = useRef({ left: 0, top: 0, zoom });
  useLayoutEffect(() => {
    const root = scrollerRef.current;
    const before = scroll.current;
    if (!root || before.zoom === zoom) return;
    const ratio = zoom / before.zoom;
    root.scrollLeft = before.left * ratio;
    root.scrollTop = before.top * ratio;
    scroll.current = { left: root.scrollLeft, top: root.scrollTop, zoom };
  }, [zoom]);

  const zoomStepRef = useRef(onZoomStep);
  zoomStepRef.current = onZoomStep;
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const onScroll = () => {
      scroll.current = {
        ...scroll.current,
        left: root.scrollLeft,
        top: root.scrollTop,
      };
    };
    let lastStep = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const now = performance.now();
      if (event.deltaY === 0 || now - lastStep < WHEEL_ZOOM_INTERVAL_MS) return;
      lastStep = now;
      zoomStepRef.current(event.deltaY < 0 ? 1 : -1);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", onWheel);
    };
  }, []);

  // The paper fills the viewport: an empty grid continues past the last
  // column and row, like Excel's, unless the sheet was cut there.
  const dataWidth = layout.colLefts[layout.cols.length];
  const dataHeight = layout.rowTops[total];
  const viewWidth = viewport.width / zoom;
  const viewHeight = viewport.height / zoom;
  const restWidth =
    sheet.colCount < sheet.totalCols
      ? 0
      : Math.max(0, Math.floor(viewWidth - headerWidth - dataWidth));
  const paddingRows =
    sheet.rowCount < sheet.totalRows || end < total
      ? 0
      : Math.max(
          0,
          Math.floor(
            (viewHeight - HEADER_HEIGHT - dataHeight) / layout.defaultRowHeight,
          ),
        );
  const tableWidth = headerWidth + dataWidth + restWidth;

  const rows = [];
  for (let pos = 0; pos < frozenRows; pos += 1) {
    rows.push(<SheetRow key={layout.rows[pos]} ctx={ctx} pos={pos} />);
  }
  if (start > frozenRows) {
    rows.push(
      <tr
        key="above"
        aria-hidden="true"
        style={{ height: layout.rowTops[start] - layout.rowTops[frozenRows] }}
      >
        <td className="ssv-spacer" colSpan={layout.cols.length + 2} />
      </tr>,
    );
  }
  for (let pos = start; pos < end; pos += 1) {
    rows.push(<SheetRow key={layout.rows[pos]} ctx={ctx} pos={pos} />);
  }
  for (let index = 0; index < paddingRows; index += 1) {
    rows.push(
      <PaddingRow
        key={`padding-${index}`}
        ctx={ctx}
        number={sheet.rowCount + index + 1}
      />,
    );
  }

  const zoomCss = {
    zoom,
    width: tableWidth,
    minHeight: Math.max(0, Math.floor(viewHeight) - 1),
    "--ssv-grid": gridColor,
  } as CSSProperties;

  return (
    <>
      <div
        ref={scrollerRef}
        className="ssv-scroller peer absolute inset-0 overflow-auto outline-none"
        tabIndex={0}
        role="region"
        aria-label={`Sheet ${sheet.name}`}
      >
        <div className="ssv-zoom" style={zoomCss}>
          <table
            className="ssv-table"
            style={{ width: tableWidth }}
            aria-label={sheet.name}
            aria-rowcount={sheet.rowCount + 1}
            aria-colcount={sheet.colCount + 1}
          >
            <colgroup>
              <col style={{ width: headerWidth }} />
              {layout.colWidths.map((width, pos) => (
                <col key={layout.cols[pos]} style={{ width }} />
              ))}
              <col style={{ width: restWidth }} />
            </colgroup>
            <thead>
              <HeaderRow ctx={ctx} restWidth={restWidth} />
            </thead>
            <tbody>{rows}</tbody>
          </table>
          <div
            aria-hidden="true"
            style={{ height: dataHeight - layout.rowTops[end] }}
          />
        </div>
      </div>
      {/* Focus ring above the cells, which would cover the scroller's own outline. */}
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-0 ring-2 ring-inset ring-ring peer-focus-visible:visible"
      />
    </>
  );
}
