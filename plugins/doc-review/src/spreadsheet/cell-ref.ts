// A1-style references, 0-based.

/** Excel's grid: XFD columns, 1,048,576 rows. */
export const MAX_COLUMNS = 16_384;
export const MAX_ROWS = 1_048_576;

export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** 0-based column of the letters at the start of a reference ("AB12" → 27), or -1. */
export function columnOf(ref: string): number {
  let column = 0;
  let i = 0;
  if (ref.charCodeAt(0) === 36) i = 1; // $
  const start = i;
  for (; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i) | 0x20; // ASCII lower case
    if (code < 97 || code > 122) break;
    column = column * 26 + (code - 96);
  }
  if (i === start || column > MAX_COLUMNS) return -1;
  return column - 1;
}

/** 0-based row of a reference ("AB12" → 11), or -1. */
export function rowOf(ref: string): number {
  let i = 0;
  while (i < ref.length) {
    const code = ref.charCodeAt(i);
    if (code >= 48 && code <= 57) break;
    i += 1;
  }
  if (i === ref.length) return -1;
  const row = Number(ref.slice(i));
  return Number.isInteger(row) && row >= 1 && row <= MAX_ROWS ? row - 1 : -1;
}

/** "B2:D5", "B2" or "$B$2:$D$5"; null for anything else (whole rows or columns). */
export function parseRange(ref: string | undefined): CellRange | null {
  if (!ref) return null;
  const [first, second = first] = ref.trim().split(":");
  if (first === undefined) return null;
  const start = first.replace(/\$/g, "");
  const end = second.replace(/\$/g, "");
  const top = rowOf(start);
  const left = columnOf(start);
  const bottom = rowOf(end);
  const right = columnOf(end);
  if (top < 0 || left < 0 || bottom < 0 || right < 0) return null;
  return {
    top: Math.min(top, bottom),
    left: Math.min(left, right),
    bottom: Math.max(top, bottom),
    right: Math.max(left, right),
  };
}
