// One table row of the grid. Rows are memoized: a row renders once per sheet
// and freeze state, so moving the row window renders only the rows entering it.
import { memo, type CSSProperties, type ReactNode } from "react";
import {
  borderWidth,
  layoutRow,
  type CellPiece,
  type GapPiece,
  type MergeIndex,
  type PieceContent,
  type SheetLayout,
} from "@/lib/sheet-layout";
import { fitNumber } from "./measure";
import {
  CELL_FONT_SIZE_PT,
  CELL_PADDING,
  FREEZE_LINE,
  HEADER_HEIGHT,
  INDENT_PX,
  PAPER,
  Z,
  fontStack,
} from "./paper";

/** Everything rows need that stays the same while the sheet is on screen. */
export interface GridContext {
  layout: SheetLayout;
  merges: MergeIndex;
  /** Frozen rows and columns in effect; a pane too big for the viewport is dropped. */
  frozenRows: number;
  frozenCols: number;
  /** Width of the row-number column. */
  headerWidth: number;
  /** Gridline color; transparent when the sheet hides gridlines. */
  gridColor: string;
}

interface RowFrame {
  pos: number;
  /** Sticky offset when the row is frozen. */
  top: number | undefined;
  lastFrozen: boolean;
}

const SAFE_LINK = /^(https?:|mailto:)/i;
const LINE_BREAKS = /\r\n|\r|\n/g;

/** Background past a filled cell's own box, where overflowing text hides the gridlines. */
function eraser(
  content: PieceContent,
  fill: string | undefined,
  width: number,
): string {
  if (!fill || content.continued) return PAPER;
  if (content.spillBefore === 0) {
    return `linear-gradient(to right, transparent ${width}px, ${PAPER} ${width}px)`;
  }
  if (content.spillAfter === 0) {
    return `linear-gradient(to left, transparent ${width}px, ${PAPER} ${width}px)`;
  }
  return "transparent";
}

function Content({
  content,
  width,
  height,
  fill,
}: {
  content: PieceContent;
  /** Content box of the drawn cell, px. */
  width: number;
  height: number;
  fill: string | undefined;
}) {
  const { cell, style, align } = content;
  // Excel wraps text only; a number that does not fit turns to "###".
  const wrap = style?.wrap === true && cell.kind === "string";
  let className = "ssv-c";
  if (style?.vertical === "top") className += " ssv-vt";
  else if (style?.vertical === "middle") className += " ssv-vm";
  if (wrap) className += " ssv-w";
  if (align === "center") className += " ssv-hc";
  else if (align === "right") className += " ssv-hr";
  else if (align === "justify") className += " ssv-hj";

  const css: CSSProperties = { height };
  const fontSize = style?.fontSize ?? CELL_FONT_SIZE_PT;
  if (style?.fontSize) css.fontSize = `${style.fontSize}pt`;
  if (style?.fontFamily) css.fontFamily = fontStack(style.fontFamily);
  if (style?.bold) css.fontWeight = 700;
  if (style?.italic) css.fontStyle = "italic";
  if (style?.underline || style?.strike) {
    css.textDecorationLine = [
      style.underline ? "underline" : "",
      style.strike ? "line-through" : "",
    ]
      .join(" ")
      .trim();
  }
  if (style?.color) css.color = style.color;

  let padLeft = CELL_PADDING;
  let padRight = CELL_PADDING;
  if (style?.indent && style.indent > 0) {
    const indent = CELL_PADDING + style.indent * INDENT_PX;
    if (align === "right") padRight = indent;
    else if (align !== "center") padLeft = indent;
    css.paddingLeft = padLeft;
    css.paddingRight = padRight;
  }

  const { spillBefore, spillAfter } = content;
  if (spillBefore > 0 || spillAfter > 0) {
    css.width = width + spillBefore + spillAfter;
    if (spillBefore > 0) css.marginLeft = -spillBefore;
  }

  let value = cell.text;
  if (cell.kind === "number" || cell.kind === "date") {
    const font = `${style?.italic ? "italic " : ""}${style?.bold ? "700 " : ""}${
      (fontSize * 4) / 3
    }px ${fontStack(style?.fontFamily)}`;
    value = fitNumber(
      value,
      font,
      (fontSize * 4) / 3,
      width - padLeft - padRight,
    );
  } else {
    // Line breaks show only in wrapped cells, as in Excel.
    value = value.replace(LINE_BREAKS, wrap ? "\n" : " ");
  }

  let inner: ReactNode = value;
  let wrapped = false;
  if (cell.link && SAFE_LINK.test(cell.link)) {
    inner = (
      <a
        className="ssv-a"
        href={cell.link}
        target="_blank"
        rel="noreferrer noopener"
      >
        {value}
      </a>
    );
    wrapped = true;
  }
  if (content.clearSpill && (spillBefore > 0 || spillAfter > 0)) {
    const own = spillBefore > 0 ? width - padRight : width - padLeft;
    inner = (
      <span
        className="ssv-erase"
        style={{ background: eraser(content, fill, own) }}
      >
        {inner}
      </span>
    );
    wrapped = true;
  }
  // Children of the flex column become blocks; a line box keeps these inline.
  if (wrapped) inner = <div>{inner}</div>;
  return (
    <div className={className} style={css}>
      {inner}
    </div>
  );
}

function Cell({
  piece,
  ctx,
  row,
}: {
  piece: CellPiece;
  ctx: GridContext;
  row: RowFrame;
}) {
  const { layout } = ctx;
  const { merge, content } = piece;
  const lastCol = piece.col + piece.colSpan - 1;
  const lastRow = row.pos + piece.rowSpan - 1;
  // Merge parts never straddle the freeze line, so the first column decides.
  const frozenCol = piece.col < ctx.frozenCols;
  const frozenRow = row.top !== undefined;
  const sticky = frozenCol || frozenRow;
  const fill = piece.style?.background;
  const innerRight = merge !== null && lastCol < merge.right;
  const innerBottom = merge !== null && lastRow < merge.bottom;
  const lastFrozenCol = frozenCol && lastCol === ctx.frozenCols - 1;
  const lastFrozenRow = frozenRow && lastRow === ctx.frozenRows - 1;

  // Without a border of its own a cell shows the 1px gridline from the grid's
  // stylesheet; a fill or the inside of a merged range hides it, as in Excel.
  let right = piece.borderRight;
  if (!right) {
    if (lastFrozenCol) right = `1px solid ${FREEZE_LINE}`;
    else if (innerRight) right = `1px solid ${fill ?? PAPER}`;
    else if (fill) right = `1px solid ${fill}`;
  }
  let bottom = piece.borderBottom;
  if (!bottom) {
    if (lastFrozenRow) bottom = `1px solid ${FREEZE_LINE}`;
    else if (innerBottom) bottom = `1px solid ${fill ?? PAPER}`;
    else if (fill) bottom = `1px solid ${fill}`;
  }

  const css: CSSProperties = {};
  if (fill) css.background = fill;
  if (piece.borderTop) css.borderTop = piece.borderTop;
  if (piece.borderLeft) css.borderLeft = piece.borderLeft;
  if (right) css.borderRight = right;
  if (bottom) css.borderBottom = bottom;
  if (sticky) {
    if (frozenRow) css.top = row.top;
    if (frozenCol) css.left = ctx.headerWidth + layout.colLefts[piece.col];
    const overflows =
      content !== null && (content.spillBefore > 0 || content.spillAfter > 0);
    css.zIndex =
      (frozenCol ? (frozenRow ? Z.frozenCorner : Z.frozenCol) : Z.frozenRow) +
      (overflows ? 1 : 0);
  }

  const width =
    layout.colLefts[piece.col + piece.colSpan] - layout.colLefts[piece.col];
  const height =
    layout.rowTops[row.pos + piece.rowSpan] - layout.rowTops[row.pos];
  const topWidth = borderWidth(piece.borderTop);
  const leftWidth = borderWidth(piece.borderLeft);
  const rightWidth = right ? borderWidth(right) : 1;
  const bottomWidth = bottom ? borderWidth(bottom) : 1;
  const contentWidth = Math.max(0, width - leftWidth - rightWidth);
  const contentHeight = Math.max(0, height - topWidth - bottomWidth);

  let body: ReactNode = null;
  if (content) {
    const split =
      merge !== null &&
      (merge.offsetX > 0 || merge.offsetY > 0 || innerRight || innerBottom);
    if (split) {
      // Part of a range cut at the freeze line: draw the whole range's content
      // and show this part's window of it.
      const fullWidth = Math.max(0, merge.width - leftWidth - 1);
      const fullHeight = Math.max(0, merge.height - topWidth - 1);
      body = (
        <div
          className="ssv-clip"
          style={{ width: contentWidth, height: contentHeight }}
        >
          <div
            style={{
              width: fullWidth,
              marginLeft: -merge.offsetX,
              marginTop: -merge.offsetY,
            }}
          >
            <Content
              content={content}
              width={fullWidth}
              height={fullHeight}
              fill={fill}
            />
          </div>
        </div>
      );
    } else {
      body = (
        <Content
          content={content}
          width={contentWidth}
          height={contentHeight}
          fill={fill}
        />
      );
    }
  }
  // Sheet coordinates of the drawn box, so a click can name the cell (Doc Review comments).
  return (
    <td
      colSpan={piece.colSpan > 1 ? piece.colSpan : undefined}
      rowSpan={piece.rowSpan > 1 ? piece.rowSpan : undefined}
      className={sticky ? "ssv-s" : undefined}
      style={css}
      data-r={layout.rows[row.pos]}
      data-c={layout.cols[piece.col]}
      data-r2={layout.rows[lastRow]}
      data-c2={layout.cols[lastCol]}
    >
      {body}
    </td>
  );
}

function Gap({
  piece,
  ctx,
  row,
}: {
  piece: GapPiece;
  ctx: GridContext;
  row: RowFrame;
}) {
  const frozenCol = piece.col < ctx.frozenCols;
  const frozenRow = row.top !== undefined;
  const css: CSSProperties = {};
  if (piece.borderRight) css.borderRight = piece.borderRight;
  else if (frozenCol && piece.col === ctx.frozenCols - 1) {
    css.borderRight = `1px solid ${FREEZE_LINE}`;
  }
  if (piece.borderBottom) css.borderBottom = piece.borderBottom;
  else if (row.lastFrozen) css.borderBottom = `1px solid ${FREEZE_LINE}`;
  const sticky = frozenCol || frozenRow;
  if (sticky) {
    if (frozenRow) css.top = row.top;
    if (frozenCol) css.left = ctx.headerWidth + ctx.layout.colLefts[piece.col];
    css.zIndex = frozenCol
      ? frozenRow
        ? Z.frozenCorner
        : Z.frozenCol
      : Z.frozenRow;
  }
  return (
    <td
      className={sticky ? "ssv-s" : undefined}
      style={css}
      data-r={ctx.layout.rows[row.pos]}
      data-c={ctx.layout.cols[piece.col]}
    />
  );
}

/** Gridlines of the empty grid past the last column, where every column has the default width. */
function restLines(ctx: GridContext): string {
  const width = ctx.layout.defaultColWidth;
  return `repeating-linear-gradient(to right, transparent 0 ${width - 1}px, ${ctx.gridColor} ${width - 1}px ${width}px)`;
}

/** The row-number cell, marked when hidden rows sit right above it. */
function RowHeader({
  number,
  afterHidden,
  top,
}: {
  number: number;
  afterHidden: boolean;
  top: number | undefined;
}) {
  return (
    <th
      scope="row"
      className={afterHidden ? "ssv-rh ssv-after-hidden" : "ssv-rh"}
      style={top === undefined ? undefined : { top, zIndex: Z.frozenRowHeader }}
    >
      {number}
    </th>
  );
}

export const SheetRow = memo(function SheetRow({
  ctx,
  pos,
}: {
  ctx: GridContext;
  pos: number;
}) {
  const { layout } = ctx;
  const frozen = pos < ctx.frozenRows;
  const row: RowFrame = {
    pos,
    top: frozen ? HEADER_HEIGHT + layout.rowTops[pos] : undefined,
    lastFrozen: frozen && pos === ctx.frozenRows - 1,
  };
  const pieces = layoutRow(layout, ctx.merges, pos, {
    frozenCols: ctx.frozenCols,
  });
  const sheetRow = layout.rows[pos];
  const previous = pos > 0 ? layout.rows[pos - 1] : -1;
  const restCss: CSSProperties = { backgroundImage: restLines(ctx) };
  if (frozen) {
    restCss.top = row.top;
    restCss.zIndex = Z.frozenRow;
    if (row.lastFrozen) restCss.borderBottom = `1px solid ${FREEZE_LINE}`;
  }
  return (
    <tr style={{ height: layout.rowHeights[pos] }} aria-rowindex={sheetRow + 2}>
      <RowHeader
        number={sheetRow + 1}
        afterHidden={sheetRow - previous > 1}
        top={row.top}
      />
      {pieces.map((piece) =>
        piece.type === "gap" ? (
          <Gap key={piece.col} piece={piece} ctx={ctx} row={row} />
        ) : (
          <Cell key={piece.col} piece={piece} ctx={ctx} row={row} />
        ),
      )}
      <td
        aria-hidden="true"
        className={frozen ? "ssv-rest ssv-s" : "ssv-rest"}
        style={restCss}
      />
    </tr>
  );
});

/** An empty row past the sheet's last one, filling the viewport like Excel's endless grid. */
export const PaddingRow = memo(function PaddingRow({
  ctx,
  number,
}: {
  ctx: GridContext;
  number: number;
}) {
  const cells: ReactNode[] = [];
  for (let col = 0; col < ctx.layout.cols.length; col += 1) {
    if (col < ctx.frozenCols) {
      const last = col === ctx.frozenCols - 1;
      cells.push(
        <td
          key={col}
          className="ssv-s"
          style={{
            left: ctx.headerWidth + ctx.layout.colLefts[col],
            zIndex: Z.frozenCol,
            borderRight: last ? `1px solid ${FREEZE_LINE}` : undefined,
          }}
        />,
      );
    } else {
      cells.push(<td key={col} />);
    }
  }
  return (
    <tr style={{ height: ctx.layout.defaultRowHeight }} aria-hidden="true">
      <RowHeader number={number} afterHidden={false} top={undefined} />
      {cells}
      <td className="ssv-rest" style={{ backgroundImage: restLines(ctx) }} />
    </tr>
  );
});
