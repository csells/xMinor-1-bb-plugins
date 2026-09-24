// Shared, dependency-free types and helpers. Both server.ts and app.tsx import
// this module, so it must stay free of Node and zod imports.

import { documentFamily, extensionOf } from "../lib/formats.js";

/**
 * - `md`: Markdown, rendered as text.
 * - `pdf`: pages as they are.
 * - `text` (Word, ODT, RTF) and `presentation` (PowerPoint, ODP): converted
 *   to PDF by LibreOffice, then shown as pages.
 * - `spreadsheet` (Excel, ODS): a grid of cells.
 */
export type DocKind = "md" | "pdf" | "text" | "presentation" | "spreadsheet";

/** Kinds shown as rendered pages. */
export type PagedKind = "pdf" | "text" | "presentation";

export function isPaged(kind: DocKind): kind is PagedKind {
  return kind === "pdf" || kind === "text" || kind === "presentation";
}

/** A rectangle in page coordinates normalized to 0..1 of the page size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a comment points.
 * - `doc`: the whole document.
 * - `md-text`: selected text in a Markdown file, with its source line range.
 * - `page-text`: selected text on a PDF page or PPTX slide (1-based page).
 * - `page-area`: a drawn rectangle on a page, with the text found inside it.
 */
export type Anchor =
  | { kind: "doc" }
  | {
      kind: "md-text";
      quote: string;
      prefix: string;
      suffix: string;
      startLine: number;
      endLine: number;
    }
  | { kind: "page-text"; page: number; quote: string; rects: Rect[] }
  | { kind: "page-area"; page: number; rect: Rect; text: string }
  | {
      kind: "cell";
      /** Sheet name as the workbook shows it, and its 0-based position. */
      sheet: string;
      sheetIndex: number;
      /** A1-style cell or range, like "B3" or "B3:D7". */
      ref: string;
      /** The displayed values in the range, for context. */
      text: string;
    };

/**
 * - `draft`: written, not handed to an agent yet.
 * - `sent`: handed to an agent, waiting for the fix.
 * - `replied`: the agent answered without fixing (a question or a refusal).
 * - `resolved`: the agent fixed it and left a note.
 */
export type CommentStatus = "draft" | "sent" | "replied" | "resolved";

export interface ReviewComment {
  id: string;
  /** Display number within the document: #1, #2, … */
  seq: number;
  status: CommentStatus;
  anchor: Anchor;
  body: string;
  /** Document version the comment was written against. */
  docVersion: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  sentThreadId: string | null;
  /** The agent's latest note: what it changed, or its question. */
  agentNote: string | null;
  resolvedAt: number | null;
}

export interface ReviewDoc {
  id: string;
  kind: DocKind;
  name: string;
  absPath: string;
  /** Null when the file lives on the bb server's own machine. */
  hostId: string | null;
  version: string;
}

export interface PageInfo {
  /** 1-based page (or slide) number. */
  n: number;
  /** Page size in PDF points. */
  width: number;
  height: number;
  /** Image URL for the rendered page. */
  url: string;
}

/**
 * Widths, in pixels, a page image is rendered at. The panel asks for the
 * smallest one that covers the page at its zoom on the screen's pixel density.
 */
export const PAGE_WIDTHS = [600, 900, 1200, 1600, 2400, 3200, 4800, 6400] as const;

/** The rendered width to ask for when a page shows `cssWidth` CSS pixels wide. */
export function pageImageWidth(cssWidth: number, pixelRatio: number): number {
  const wanted = cssWidth * Math.max(1, pixelRatio);
  // A tenth of slack keeps a page just past a step on the smaller image.
  return PAGE_WIDTHS.find((width) => width >= wanted * 0.9) ?? PAGE_WIDTHS[PAGE_WIDTHS.length - 1]!;
}

/** One word with its box normalized to the page: [x0, y0, x1, y1, text]. */
export type PageWord = [number, number, number, number, string];

export interface PageText {
  n: number;
  lines: PageWord[][];
}

export const MARKDOWN_EXTENSIONS = ["md", "markdown"] as const;

export function docKindFor(path: string): DocKind | null {
  const extension = extensionOf(path);
  if ((MARKDOWN_EXTENSIONS as readonly string[]).includes(extension)) return "md";
  return documentFamily(path);
}

/** "Slide" for decks, "Page" for everything else. */
export function pageNoun(kind: DocKind): "Slide" | "Page" {
  return kind === "presentation" ? "Slide" : "Page";
}

/** A short human label for where a comment points. */
export function anchorLabel(anchor: Anchor, kind: DocKind): string {
  switch (anchor.kind) {
    case "doc":
      return "Whole document";
    case "md-text":
      return anchor.startLine === anchor.endLine
        ? `Line ${anchor.startLine}`
        : `Lines ${anchor.startLine}–${anchor.endLine}`;
    case "page-text":
      return `${pageNoun(kind)} ${anchor.page}`;
    case "page-area":
      return `${pageNoun(kind)} ${anchor.page}, area`;
    case "cell":
      return `${anchor.sheet}!${anchor.ref}`;
  }
}

/** The quoted text a comment points at, if any. */
export function anchorQuote(anchor: Anchor): string | null {
  switch (anchor.kind) {
    case "md-text":
    case "page-text":
      return anchor.quote;
    case "page-area":
    case "cell":
      return anchor.text || null;
    case "doc":
      return null;
  }
}

/** Collapse whitespace so quotes compare across line wrapping. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  const flat = squash(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
