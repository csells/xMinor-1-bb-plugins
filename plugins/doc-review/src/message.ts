// The message an agent receives: one block per comment with its place in the
// file, the quoted text, and the requested change, followed by how to report
// back through `bb doc-review`.
import path from "node:path";
import {
  anchorLabel,
  truncate,
  type DocKind,
  type ReviewComment,
} from "./types.js";

export const CLI_NAME = "doc-review";

const QUOTE_MAX = 600;

function quoteFor(comment: ReviewComment): string | null {
  const { anchor } = comment;
  if (anchor.kind === "md-text" || anchor.kind === "page-text") {
    return `«${truncate(anchor.quote, QUOTE_MAX)}»`;
  }
  if (anchor.kind === "page-area" && anchor.text.trim()) {
    return `text in the area: «${truncate(anchor.text, QUOTE_MAX)}»`;
  }
  if (anchor.kind === "cell" && anchor.text.trim()) {
    return `value: «${truncate(anchor.text, QUOTE_MAX)}»`;
  }
  return null;
}

function kindHint(kind: DocKind): string {
  switch (kind) {
    case "md":
      return "Line numbers refer to the file as it was when the comments were written; match by the quoted text if lines have shifted.";
    case "presentation":
      return "Slide numbers are 1-based. Edit the presentation itself (for .pptx, python-pptx) and keep its design; area images show what the comment points at.";
    case "text":
      return "Page numbers come from a PDF rendering and can differ from the editor's own pagination; find places by the quoted text. Edit the document itself (for .docx, python-docx) and keep its formatting.";
    case "spreadsheet":
      return "Cells are A1 references on the named sheet. Edit the workbook itself (for .xlsx, openpyxl) and keep its formatting and formulas.";
    case "pdf":
      return "Page numbers are 1-based. If this PDF is generated from a source file (Markdown, HTML, PPTX, …), edit the source and regenerate the PDF; otherwise say what you cannot change.";
  }
}

export function buildHandoffMessage(input: {
  kind: DocKind;
  absPath: string;
  comments: ReviewComment[];
  /** Comment id → 1-based number of its attached image, when one is attached. */
  imageNumbers: Map<string, number>;
  /** Comment id → local image path, used when images cannot be attached. */
  imagePaths: Map<string, string>;
}): string {
  const name = path.posix.basename(input.absPath);
  const count = input.comments.length;
  const lines: string[] = [
    `Review comments on \`${name}\` — ${count} to address.`,
    `File: \`${input.absPath}\``,
    "",
  ];
  for (const comment of input.comments) {
    const label = anchorLabel(comment.anchor, input.kind);
    const parts = [`[${comment.id}] ${label}`];
    const imageNumber = input.imageNumbers.get(comment.id);
    const imagePath = input.imagePaths.get(comment.id);
    if (imageNumber !== undefined) parts.push(`image ${imageNumber} attached`);
    else if (imagePath) parts.push(`image: \`${imagePath}\``);
    const quote = quoteFor(comment);
    if (quote) parts.push(quote);
    lines.push(parts.join(" · "));
    lines.push(comment.body.trim());
    lines.push("");
  }
  lines.push(kindHint(input.kind));
  lines.push(
    `When a comment is done, close it with a one-line note: \`bb ${CLI_NAME} resolve <id> --note "what changed"\`.`,
  );
  lines.push(
    `If you cannot apply one or need an answer first, reply instead: \`bb ${CLI_NAME} reply <id> --note "question or reason"\`.`,
  );
  return lines.join("\n");
}
