// Parser for `pdftotext -bbox-layout` output: pages → lines → words with
// boxes in PDF points. Poppler writes well-formed XHTML with one element per
// line of output, so a small scanner is enough.
import type { PageWord } from "./types.js";

export interface BboxPage {
  width: number;
  height: number;
  /** Words grouped by text line, boxes normalized to 0..1 of the page. */
  lines: PageWord[][];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attr(tag: string, name: string): number {
  const match = new RegExp(`${name}="([-0-9.]+)"`).exec(tag);
  return match ? Number.parseFloat(match[1]!) : Number.NaN;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function parseBboxLayout(xhtml: string): BboxPage[] {
  const pages: BboxPage[] = [];
  let page: BboxPage | null = null;
  let line: PageWord[] | null = null;
  const token = /<(page|line|word)\b([^>]*)>|<\/(page|line)>/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xhtml)) !== null) {
    const [, open, attrs = "", close] = match;
    if (open === "page") {
      page = {
        width: attr(attrs, "width"),
        height: attr(attrs, "height"),
        lines: [],
      };
      pages.push(page);
    } else if (open === "line") {
      line = [];
    } else if (open === "word" && page && line) {
      const end = xhtml.indexOf("</word>", token.lastIndex);
      if (end < 0) break;
      const text = decodeEntities(xhtml.slice(token.lastIndex, end)).trim();
      token.lastIndex = end + "</word>".length;
      const { width, height } = page;
      if (!text || !(width > 0) || !(height > 0)) continue;
      const x0 = attr(attrs, "xMin");
      const y0 = attr(attrs, "yMin");
      const x1 = attr(attrs, "xMax");
      const y1 = attr(attrs, "yMax");
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      line.push([
        round(x0 / width),
        round(y0 / height),
        round(x1 / width),
        round(y1 / height),
        text,
      ]);
    } else if (close === "line") {
      if (page && line && line.length > 0) page.lines.push(line);
      line = null;
    } else if (close === "page") {
      page = null;
    }
  }
  return pages;
}
