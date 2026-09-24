import { describe, expect, it } from "vitest";

import {
  borderWidth,
  buildMergeIndex,
  buildSheetLayout,
  cellAlignment,
  columnLetter,
  defaultAlignment,
  fitFrozen,
  frozenOffsets,
  layoutRow,
  mergeRunAt,
  nextRowWindow,
  OPEN_SPILL,
  positionAt,
  rowHeaderWidth,
  safeRowCount,
  safeRowStart,
  stepZoom,
  type CellPiece,
  type GapPiece,
  type RowPiece,
} from "./sheet-layout";
import type { CellStyle, SheetCell, SheetData, SheetRow } from "./sheet-model";

function makeSheet(partial: Partial<SheetData>): SheetData {
  return {
    index: 0,
    name: "Sheet1",
    rowCount: 0,
    colCount: 0,
    totalRows: 0,
    totalCols: 0,
    truncated: false,
    defaultRowHeight: 20,
    defaultColWidth: 64,
    colWidths: [],
    hiddenCols: [],
    rows: [],
    merges: [],
    frozenRows: 0,
    frozenCols: 0,
    showGridLines: true,
    styles: [],
    ...partial,
  };
}

function text(
  col: number,
  value: string,
  extra: Partial<SheetCell> = {},
): SheetCell {
  return { col, text: value, kind: "string", ...extra };
}

function num(
  col: number,
  value: string,
  extra: Partial<SheetCell> = {},
): SheetCell {
  return { col, text: value, kind: "number", ...extra };
}

function row(
  index: number,
  cells: SheetCell[],
  extra: Partial<SheetRow> = {},
): SheetRow {
  return { row: index, cells, ...extra };
}

/** Lays out one row, by default with no frozen columns. */
function piecesOf(sheet: SheetData, pos: number, frozenCols = 0): RowPiece[] {
  const layout = buildSheetLayout(sheet);
  const merges = buildMergeIndex(layout, layout.frozenRows, frozenCols);
  return layoutRow(layout, merges, pos, { frozenCols });
}

function cellPiece(pieces: RowPiece[], col: number): CellPiece {
  const piece = pieces.find((candidate) => candidate.col === col);
  if (!piece || piece.type !== "cell")
    throw new Error(`no cell piece at ${col}`);
  return piece;
}

function shape(pieces: RowPiece[]): string[] {
  return pieces.map((piece) =>
    piece.type === "gap"
      ? `gap ${piece.col}`
      : `${piece.merge ? "merge" : "cell"} ${piece.col}+${piece.colSpan}`,
  );
}

describe("columnLetter", () => {
  it("names columns like Excel", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
    expect(columnLetter(51)).toBe("AZ");
    expect(columnLetter(52)).toBe("BA");
    expect(columnLetter(701)).toBe("ZZ");
    expect(columnLetter(702)).toBe("AAA");
    expect(columnLetter(16_383)).toBe("XFD");
  });

  it("returns nothing for a negative index", () => {
    expect(columnLetter(-1)).toBe("");
    expect(columnLetter(Number.NaN)).toBe("");
  });
});

describe("alignment", () => {
  it("follows Excel's general alignment by kind", () => {
    expect(defaultAlignment("number")).toBe("right");
    expect(defaultAlignment("date")).toBe("right");
    expect(defaultAlignment("string")).toBe("left");
    expect(defaultAlignment("boolean")).toBe("center");
    expect(defaultAlignment("error")).toBe("center");
  });

  it("prefers the style's alignment", () => {
    expect(cellAlignment("number", { horizontal: "left" })).toBe("left");
    expect(cellAlignment("string", {})).toBe("left");
    expect(cellAlignment("string", undefined)).toBe("left");
  });
});

describe("borderWidth", () => {
  it("reads the width of a border shorthand", () => {
    expect(borderWidth("1px solid #000000")).toBe(1);
    expect(borderWidth("2px dashed #ff0000")).toBe(2);
    expect(borderWidth("3px double #000000")).toBe(3);
    expect(borderWidth("0.5px solid #000")).toBe(0.5);
    expect(borderWidth("thin solid #000")).toBe(1);
    expect(borderWidth("solid #000")).toBe(3);
  });

  it("is zero without a border", () => {
    expect(borderWidth(undefined)).toBe(0);
    expect(borderWidth("")).toBe(0);
    expect(borderWidth("none")).toBe(0);
    expect(borderWidth("2px hidden #000")).toBe(0);
  });
});

describe("rowHeaderWidth", () => {
  it("grows with the number of digits", () => {
    expect(rowHeaderWidth(9)).toBe(34);
    expect(rowHeaderWidth(5000)).toBe(40);
    expect(rowHeaderWidth(1_048_576)).toBe(61);
  });
});

describe("buildSheetLayout", () => {
  it("drops hidden rows and columns and resolves sizes", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 5,
        colCount: 4,
        colWidths: [100, null, 0, 30],
        hiddenCols: [1],
        rows: [
          row(0, [], { height: 30 }),
          row(2, [], { hidden: true }),
          row(3, [], { height: 0 }),
        ],
      }),
    );
    expect(layout.cols).toEqual([0, 3]);
    expect(layout.colWidths).toEqual([100, 30]);
    expect(layout.colLefts).toEqual([0, 100, 130]);
    expect(layout.rows).toEqual([0, 1, 4]);
    expect(layout.rowHeights).toEqual([30, 20, 20]);
    expect(layout.rowTops).toEqual([0, 30, 50, 70]);
    expect(Array.from(layout.rowPosition)).toEqual([0, 1, -1, -1, 2]);
    expect(Array.from(layout.colPosition)).toEqual([0, -1, -1, 1]);
  });

  it("counts frozen rows and columns among the drawn ones", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 10,
        colCount: 10,
        frozenRows: 3,
        frozenCols: 2,
        hiddenCols: [0],
        rows: [row(1, [], { hidden: true })],
      }),
    );
    expect(layout.frozenRows).toBe(2);
    expect(layout.frozenCols).toBe(1);
  });

  it("rounds sizes down to the browser's 1/64 px layout unit", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 1,
        colCount: 1,
        defaultRowHeight: 19.2,
        colWidths: [64.3],
      }),
    );
    expect(layout.rowHeights).toEqual([19.1875]);
    expect(layout.colWidths).toEqual([64.296875]);
  });

  it("fits a row without a height to its largest font", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 3,
        colCount: 2,
        styles: [{ fontSize: 16 }, { fontSize: 9 }],
        rows: [
          row(0, [
            text(0, "Title", { style: 0 }),
            text(1, "small", { style: 1 }),
          ]),
          row(1, [text(0, "Title", { style: 0 })], { height: 22 }),
          row(2, [text(0, "", { style: 0 })]),
        ],
      }),
    );
    expect(layout.rowHeights).toEqual([28, 22, 20]);
  });

  it("falls back to Excel's defaults for missing sizes", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 1,
        colCount: 1,
        defaultRowHeight: 0,
        defaultColWidth: Number.NaN,
      }),
    );
    expect(layout.rowHeights).toEqual([20]);
    expect(layout.colWidths).toEqual([64]);
  });

  it("keeps cells of hidden rows for merged content", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 2,
        colCount: 1,
        rows: [
          row(0, [text(0, "a")], { hidden: true }),
          row(1, [text(0, "b")]),
        ],
      }),
    );
    expect(layout.cells.size).toBe(2);
  });
});

describe("positionAt", () => {
  it("finds the row under an offset", () => {
    const tops = [0, 20, 50, 70];
    expect(positionAt(tops, -5)).toBe(0);
    expect(positionAt(tops, 0)).toBe(0);
    expect(positionAt(tops, 19.9)).toBe(0);
    expect(positionAt(tops, 20)).toBe(1);
    expect(positionAt(tops, 69)).toBe(2);
    expect(positionAt(tops, 500)).toBe(2);
    expect(positionAt([0], 10)).toBe(0);
  });
});

describe("frozen panes", () => {
  it("stacks sticky offsets after a lead", () => {
    expect(frozenOffsets([20, 30, 40], 2, 20)).toEqual([20, 40]);
    expect(frozenOffsets([20], 3, 0)).toEqual([0]);
  });

  it("drops a pane that would fill the viewport", () => {
    const lefts = [0, 100, 300];
    expect(fitFrozen(lefts, 2, 40, 1000, 1)).toBe(2);
    expect(fitFrozen(lefts, 2, 40, 400, 1)).toBe(0);
    expect(fitFrozen(lefts, 2, 40, 400, 0.5)).toBe(2);
    expect(fitFrozen(lefts, 2, 40, 0, 1)).toBe(2);
    expect(fitFrozen(lefts, 0, 40, 400, 1)).toBe(0);
  });
});

describe("buildMergeIndex", () => {
  it("reduces spans by the hidden rows and columns they cover", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 4,
        colCount: 4,
        hiddenCols: [1],
        rows: [row(1, [], { hidden: true })],
        merges: [{ row: 0, col: 0, rowSpan: 3, colSpan: 3 }],
      }),
    );
    const index = buildMergeIndex(layout, 0, 0);
    expect(index.parts).toHaveLength(1);
    const [part] = index.parts;
    expect(part).toMatchObject({
      row: 0,
      col: 0,
      rowSpan: 2,
      colSpan: 2,
      width: 128,
      height: 40,
    });
    expect(mergeRunAt(index, 1, 1)?.anchor).toBe(false);
    expect(mergeRunAt(index, 2, 0)).toBeUndefined();
  });

  it("anchors a range whose first row is hidden at its first drawn row", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 3,
        colCount: 1,
        rows: [row(0, [text(0, "title")], { hidden: true })],
        merges: [{ row: 0, col: 0, rowSpan: 3, colSpan: 1 }],
      }),
    );
    const [part] = buildMergeIndex(layout, 0, 0).parts;
    expect(part).toMatchObject({
      row: 0,
      rowSpan: 2,
      sourceRow: 0,
      sourceCol: 0,
    });
  });

  it("skips ranges that are entirely hidden and ranges that overlap", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 4,
        colCount: 4,
        hiddenCols: [3],
        merges: [
          { row: 0, col: 3, rowSpan: 2, colSpan: 1 },
          { row: 0, col: 0, rowSpan: 2, colSpan: 2 },
          { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
        ],
      }),
    );
    const index = buildMergeIndex(layout, 0, 0);
    expect(index.parts.map((part) => [part.row, part.col])).toEqual([[0, 0]]);
  });

  it("cuts ranges at the freeze line into offset parts", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 5,
        colCount: 5,
        merges: [{ row: 0, col: 0, rowSpan: 3, colSpan: 3 }],
      }),
    );
    const index = buildMergeIndex(layout, 1, 2);
    expect(
      index.parts.map((part) => [
        part.row,
        part.col,
        part.rowSpan,
        part.colSpan,
        part.offsetX,
        part.offsetY,
      ]),
    ).toEqual([
      [0, 0, 1, 2, 0, 0],
      [0, 2, 1, 1, 128, 0],
      [1, 0, 2, 2, 0, 20],
      [1, 2, 2, 1, 128, 20],
    ]);
    expect(
      index.parts.every((part) => part.width === 192 && part.height === 60),
    ).toBe(true);
    expect(mergeRunAt(index, 1, 0)?.anchor).toBe(true);
    expect(mergeRunAt(index, 2, 0)?.anchor).toBe(false);
  });
});

describe("safeRowCount", () => {
  it("never ends inside a row span", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 10,
        colCount: 2,
        merges: [
          { row: 2, col: 0, rowSpan: 3, colSpan: 1 },
          { row: 4, col: 1, rowSpan: 3, colSpan: 1 },
        ],
      }),
    );
    const index = buildMergeIndex(layout, 0, 0);
    expect(safeRowCount(index, 2, 10)).toBe(2);
    expect(safeRowCount(index, 3, 10)).toBe(7);
    expect(safeRowCount(index, 5, 10)).toBe(7);
    expect(safeRowCount(index, 8, 10)).toBe(8);
    expect(safeRowCount(index, 20, 10)).toBe(10);
  });
});

describe("safeRowStart", () => {
  it("never starts inside a row span", () => {
    const layout = buildSheetLayout(
      makeSheet({
        rowCount: 10,
        colCount: 2,
        merges: [
          { row: 2, col: 0, rowSpan: 3, colSpan: 1 },
          { row: 4, col: 1, rowSpan: 3, colSpan: 1 },
        ],
      }),
    );
    const index = buildMergeIndex(layout, 0, 0);
    expect(safeRowStart(index, 2)).toBe(2);
    expect(safeRowStart(index, 3)).toBe(2);
    expect(safeRowStart(index, 6)).toBe(2);
    expect(safeRowStart(index, 7)).toBe(7);
    expect(safeRowStart(index, 0)).toBe(0);
  });
});

describe("nextRowWindow", () => {
  // 1000 rows of 20px.
  const tops = Array.from({ length: 1001 }, (_, index) => index * 20);
  const options = { overscan: 400, margin: 5, chunk: 10 };

  it("covers the viewport and the overscan, snapped to chunks", () => {
    expect(
      nextRowWindow({ start: 0, end: 0 }, tops, 2000, 2600, options),
    ).toEqual({
      start: 80,
      end: 160,
    });
  });

  it("stays put while the viewport is well inside it", () => {
    const current = { start: 80, end: 160 };
    expect(nextRowWindow(current, tops, 2100, 2700, options)).toBe(current);
  });

  it("moves when the viewport nears an edge or jumps away", () => {
    const current = { start: 80, end: 160 };
    expect(nextRowWindow(current, tops, 2500, 3100, options)).toEqual({
      start: 100,
      end: 180,
    });
    expect(nextRowWindow(current, tops, 19_000, 19_600, options)).toEqual({
      start: 930,
      end: 1000,
    });
  });

  it("stops at the first and last rows", () => {
    expect(nextRowWindow({ start: 5, end: 5 }, tops, 0, 600, options)).toEqual({
      start: 0,
      end: 60,
    });
    const atEnd = { start: 930, end: 1000 };
    expect(nextRowWindow(atEnd, tops, 19_400, 20_000, options)).toBe(atEnd);
  });

  it("handles a sheet without rows", () => {
    expect(nextRowWindow({ start: 0, end: 3 }, [0], 0, 100, options)).toEqual({
      start: 0,
      end: 0,
    });
  });
});

describe("stepZoom", () => {
  it("steps through the zoom levels and clamps at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.55, -1)).toBe(0.5);
    expect(stepZoom(0.55, 1)).toBe(0.6);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(2, 1)).toBe(2);
  });
});

describe("layoutRow", () => {
  it("draws every column, empty ones as gaps", () => {
    const sheet = makeSheet({
      rowCount: 1,
      colCount: 4,
      rows: [row(0, [num(2, "1")])],
    });
    expect(shape(piecesOf(sheet, 0))).toEqual([
      "gap 0",
      "gap 1",
      "cell 2+1",
      "gap 3",
    ]);
  });

  it("draws a merged range once and skips the columns it covers", () => {
    const sheet = makeSheet({
      rowCount: 3,
      colCount: 4,
      rows: [row(0, [text(0, "Title"), text(1, "")]), row(1, [num(3, "5")])],
      merges: [{ row: 0, col: 0, rowSpan: 2, colSpan: 3 }],
    });
    const first = piecesOf(sheet, 0);
    expect(shape(first)).toEqual(["merge 0+3", "gap 3"]);
    const merge = cellPiece(first, 0);
    expect(merge.rowSpan).toBe(2);
    expect(merge.content?.cell.text).toBe("Title");
    expect(shape(piecesOf(sheet, 1))).toEqual(["cell 3+1"]);
  });

  it("lets left-aligned text run over empty neighbours up to the next text", () => {
    const sheet = makeSheet({
      rowCount: 1,
      colCount: 6,
      colWidths: [64, 50, 40, 64, 64, 64],
      rows: [row(0, [text(0, "A long title"), text(3, "next")])],
    });
    const pieces = piecesOf(sheet, 0);
    const title = cellPiece(pieces, 0).content;
    expect(title).toMatchObject({
      spillBefore: 0,
      spillAfter: 90,
      clearSpill: true,
    });
    // The last text runs to the grid's edge and past it.
    expect(cellPiece(pieces, 3).content?.spillAfter).toBe(128 + OPEN_SPILL);
  });

  it("stops overflowing text at a styled cell with text but not at a styled blank", () => {
    const styles: CellStyle[] = [{ background: "#ffff00" }];
    const sheet = makeSheet({
      rowCount: 1,
      colCount: 4,
      styles,
      rows: [
        row(0, [
          text(0, "Overflowing"),
          text(1, "", { style: 0 }),
          num(2, "3"),
        ]),
      ],
    });
    const content = cellPiece(piecesOf(sheet, 0), 0).content;
    expect(content?.spillAfter).toBe(64);
    // The filled blank shows through, so gridlines are not hidden there.
    expect(content?.clearSpill).toBe(false);
  });

  it("never lets numbers, wrapped text or justified text overflow", () => {
    const sheet = makeSheet({
      rowCount: 1,
      colCount: 8,
      styles: [{ wrap: true }, { horizontal: "justify" }],
      rows: [
        row(0, [
          num(0, "123456789012"),
          text(2, "wrapped words", { style: 0 }),
          text(5, "justified", { style: 1 }),
        ]),
      ],
    });
    const pieces = piecesOf(sheet, 0);
    for (const col of [0, 2, 5]) {
      expect(cellPiece(pieces, col).content).toMatchObject({
        spillBefore: 0,
        spillAfter: 0,
      });
    }
  });

  it("runs right-aligned text to the left and centered text both ways", () => {
    const sheet = makeSheet({
      rowCount: 1,
      colCount: 7,
      styles: [{ horizontal: "right" }, { horizontal: "center" }],
      rows: [
        row(0, [
          text(2, "right", { style: 0 }),
          text(5, "center", { style: 1 }),
        ]),
      ],
    });
    const pieces = piecesOf(sheet, 0);
    expect(cellPiece(pieces, 2).content).toMatchObject({
      spillBefore: 128,
      spillAfter: 0,
    });
    // Two free columns on the left, open grid on the right: the narrower side wins.
    expect(cellPiece(pieces, 5).content).toMatchObject({
      spillBefore: 128,
      spillAfter: 128,
    });
  });

  it("stops overflowing text at a merged range", () => {
    const sheet = makeSheet({
      rowCount: 1,
      colCount: 5,
      rows: [row(0, [text(0, "Overflowing")])],
      merges: [{ row: 0, col: 2, rowSpan: 1, colSpan: 2 }],
    });
    expect(cellPiece(piecesOf(sheet, 0), 0).content?.spillAfter).toBe(64);
  });

  it("continues frozen text past the freeze line in the first scrolling column", () => {
    const sheet = makeSheet({
      rowCount: 1,
      colCount: 5,
      colWidths: [40, 60, 64, 64, 64],
      rows: [row(0, [text(0, "Quarterly revenue report"), num(4, "7")])],
    });
    const pieces = piecesOf(sheet, 0, 2);
    expect(shape(pieces)).toEqual([
      "cell 0+1",
      "gap 1",
      "cell 2+1",
      "gap 3",
      "cell 4+1",
    ]);
    expect(cellPiece(pieces, 0).content).toMatchObject({
      spillAfter: 60,
      continued: false,
    });
    const continued = cellPiece(pieces, 2);
    expect(continued.content).toMatchObject({
      spillBefore: 100,
      spillAfter: 64,
      continued: true,
      align: "left",
    });
    expect(continued.content?.cell.text).toBe("Quarterly revenue report");
  });

  it("keeps scrolling text out of the frozen columns", () => {
    const sheet = makeSheet({
      rowCount: 1,
      colCount: 4,
      styles: [{ horizontal: "right" }],
      rows: [row(0, [text(3, "right", { style: 0 })])],
    });
    expect(cellPiece(piecesOf(sheet, 0, 1), 3).content?.spillBefore).toBe(128);
  });

  describe("borders", () => {
    const thin = "1px solid #000000";
    const thick = "3px solid #ff0000";

    it("draws a neighbour's left border as this cell's right border", () => {
      const sheet = makeSheet({
        rowCount: 1,
        colCount: 3,
        styles: [{ borderLeft: thin }],
        rows: [row(0, [num(0, "1"), num(1, "2", { style: 0 })])],
      });
      const pieces = piecesOf(sheet, 0);
      expect(cellPiece(pieces, 0).borderRight).toBe(thin);
      expect(cellPiece(pieces, 1).borderLeft).toBeUndefined();
    });

    it("prefers the cell's own border to the neighbour's", () => {
      const sheet = makeSheet({
        rowCount: 1,
        colCount: 2,
        styles: [{ borderRight: thick }, { borderLeft: thin }],
        rows: [row(0, [num(0, "1", { style: 0 }), num(1, "2", { style: 1 })])],
      });
      expect(cellPiece(piecesOf(sheet, 0), 0).borderRight).toBe(thick);
    });

    it("draws the top border of the row below as this row's bottom border", () => {
      const sheet = makeSheet({
        rowCount: 2,
        colCount: 3,
        styles: [{ borderTop: thin }],
        rows: [row(1, [num(1, "2", { style: 0 })])],
      });
      expect(piecesOf(sheet, 0)).toEqual<GapPiece[]>([
        {
          type: "gap",
          col: 0,
          borderRight: undefined,
          borderBottom: undefined,
        },
        { type: "gap", col: 1, borderRight: undefined, borderBottom: thin },
        {
          type: "gap",
          col: 2,
          borderRight: undefined,
          borderBottom: undefined,
        },
      ]);
      expect(cellPiece(piecesOf(sheet, 1), 1).borderTop).toBeUndefined();
    });

    it("draws its own top and left borders at the grid's edge", () => {
      const sheet = makeSheet({
        rowCount: 1,
        colCount: 1,
        styles: [{ borderTop: thin, borderLeft: thick }],
        rows: [row(0, [num(0, "1", { style: 0 })])],
      });
      const piece = cellPiece(piecesOf(sheet, 0), 0);
      expect(piece.borderTop).toBe(thin);
      expect(piece.borderLeft).toBe(thick);
    });

    it("gives an empty column its neighbour's left border", () => {
      const sheet = makeSheet({
        rowCount: 1,
        colCount: 5,
        styles: [{ borderLeft: thin }],
        rows: [row(0, [text(3, "", { style: 0 })])],
      });
      const pieces = piecesOf(sheet, 0);
      expect(shape(pieces)).toEqual([
        "gap 0",
        "gap 1",
        "gap 2",
        "cell 3+1",
        "gap 4",
      ]);
      expect((pieces[2] as GapPiece).borderRight).toBe(thin);
      expect((pieces[1] as GapPiece).borderRight).toBeUndefined();
    });

    it("takes a merged range's right and bottom borders from its edge cells", () => {
      const sheet = makeSheet({
        rowCount: 3,
        colCount: 3,
        styles: [{ borderRight: thin }, { borderBottom: thick }],
        rows: [
          row(0, [text(0, "Merged"), text(1, "", { style: 0 })]),
          row(1, [text(0, "", { style: 1 })]),
        ],
        merges: [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
      });
      const merge = cellPiece(piecesOf(sheet, 0), 0);
      expect(merge.borderRight).toBe(thin);
      expect(merge.borderBottom).toBe(thick);
    });

    it("leaves the inner edges of a range cut at the freeze line without borders", () => {
      const sheet = makeSheet({
        rowCount: 2,
        colCount: 3,
        styles: [{ borderRight: thin }],
        rows: [row(0, [text(0, "Merged"), text(2, "", { style: 0 })])],
        merges: [{ row: 0, col: 0, rowSpan: 1, colSpan: 3 }],
      });
      const pieces = piecesOf(sheet, 0, 1);
      expect(shape(pieces)).toEqual(["merge 0+1", "merge 1+2"]);
      expect(cellPiece(pieces, 0).borderRight).toBeUndefined();
      expect(cellPiece(pieces, 1).borderRight).toBe(thin);
      expect(cellPiece(pieces, 1).merge?.offsetX).toBe(64);
    });
  });
});
