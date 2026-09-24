// The grid's "paper": fixed Excel-like colors that do not follow bb's theme.
// Workbooks set their fills and fonts assuming white cells, so the cell area
// stays light in dark mode too; only the chrome around it uses theme tokens.

export const PAPER = "#ffffff";
export const GRIDLINE = "#dadada";
/** The thin line Excel draws along a frozen pane. */
export const FREEZE_LINE = "#9e9e9e";
export const HEADER_FILL = "#f3f3f3";
export const HEADER_INK = "#555555";
/** Between two header cells. */
export const HEADER_LINE = "#d6d6d6";
/** Where the headers meet the cells. */
export const HEADER_EDGE = "#bdbdbd";
/** Marks a hidden row or column next to a header, like Excel's double line. */
export const HIDDEN_MARK = "#8f8f8f";

/** Excel's default font; Carlito is its metric-compatible stand-in on Linux. */
export const CELL_FONT = 'Calibri, Carlito, "Segoe UI", Arial, sans-serif';
export const CELL_FONT_SIZE_PT = 11;
/** Text inset from the cell's edges. */
export const CELL_PADDING = 2;
/** One indent level, about three spaces of Calibri 11. */
export const INDENT_PX = 10;
/** Height of the column-letter row. */
export const HEADER_HEIGHT = 20;

/** Font stack for a workbook font name, falling back to Excel's default. */
export function fontStack(family: string | undefined): string {
  const name = family?.replace(/["'\\;{}<>]/g, "").trim();
  return name ? `"${name}", ${CELL_FONT}` : CELL_FONT;
}

/**
 * Stacking inside the grid. Frozen cells cover scrolled ones and the headers
 * cover both; a cell whose text overflows sits one above its neighbours in
 * the same band so the text is not painted over.
 */
export const Z = {
  frozenCol: 10,
  frozenRow: 20,
  frozenCorner: 30,
  rowHeader: 40,
  frozenRowHeader: 50,
  colHeader: 60,
  frozenColHeader: 70,
  corner: 80,
} as const;

/**
 * Styles of the grid internals, scoped by the `ssv-` prefix. They live in a
 * style element rather than utility classes: tens of thousands of cells share
 * them, and the palette is deliberately independent of the theme.
 */
export const GRID_CSS = `
.ssv-scroller{background:${PAPER};color-scheme:light;overflow-anchor:none}
.ssv-zoom{position:relative;isolation:isolate;overflow:clip}
.ssv-table{border-collapse:separate;border-spacing:0;table-layout:fixed;font-family:${CELL_FONT};font-size:${CELL_FONT_SIZE_PT}pt;line-height:1.3;color:#000;text-align:left;font-weight:400;font-style:normal;letter-spacing:normal}
.ssv-table td{padding:0;vertical-align:top;overflow:visible;border-right:1px solid var(--ssv-grid);border-bottom:1px solid var(--ssv-grid)}
.ssv-table td.ssv-rest{border-right:0}
.ssv-table td.ssv-spacer{border:0}
.ssv-table th{position:sticky;padding:0 3px;background:${HEADER_FILL};color:${HEADER_INK};font-family:${CELL_FONT};font-size:9.5pt;font-weight:400;line-height:0;text-align:center;vertical-align:middle;white-space:nowrap;overflow:hidden;cursor:default;user-select:none;-webkit-user-select:none}
.ssv-ch{top:0;z-index:${Z.colHeader};border-right:1px solid ${HEADER_LINE};border-bottom:1px solid ${HEADER_EDGE}}
.ssv-rh{left:0;z-index:${Z.rowHeader};border-right:1px solid ${HEADER_EDGE};border-bottom:1px solid ${HEADER_LINE}}
.ssv-table th.ssv-corner{top:0;left:0;z-index:${Z.corner};border-right:1px solid ${HEADER_EDGE};border-bottom:1px solid ${HEADER_EDGE}}
.ssv-corner::after{content:"";position:absolute;right:3px;bottom:3px;border-style:solid;border-width:0 0 9px 9px;border-color:transparent transparent #c3c3c3 transparent}
.ssv-table th.ssv-rest{padding:0;text-align:left;border-right:0}
.ssv-rest-letters{display:flex;line-height:0}
.ssv-rest-letters>span{flex:none;text-align:center;box-sizing:border-box;border-right:1px solid ${HEADER_LINE};line-height:${HEADER_HEIGHT - 1}px}
.ssv-ch.ssv-after-hidden{box-shadow:inset 2px 0 0 ${HIDDEN_MARK}}
.ssv-rh.ssv-after-hidden{box-shadow:inset 0 2px 0 ${HIDDEN_MARK}}
.ssv-s{position:sticky;background:${PAPER}}
.ssv-c{display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;padding:0 ${CELL_PADDING}px;white-space:pre}
.ssv-vt{justify-content:flex-start}
.ssv-vm{justify-content:center}
.ssv-w{white-space:pre-wrap;overflow-wrap:break-word}
.ssv-hc{align-items:center;text-align:center}
.ssv-hr{align-items:flex-end;text-align:right}
.ssv-hj{text-align:justify}
.ssv-clip{overflow:hidden}
.ssv-erase{padding:40px 0}
.ssv-a{color:inherit;text-decoration:inherit;cursor:pointer}
.ssv-a:hover{text-decoration:underline}
`;
