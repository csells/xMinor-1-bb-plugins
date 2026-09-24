// Splits Markdown into top-level blocks that remember their source lines, so
// a selection in the rendered view maps back to line numbers in the file.
import { Lexer } from "marked";

export interface MdBlock {
  /** 1-based, inclusive source lines. */
  start: number;
  end: number;
  markdown: string;
}

function countLines(text: string): number {
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

/** Link reference definitions, appended to every block so `[x][ref]` still resolves. */
function referenceDefinitions(source: string): string {
  return source
    .split("\n")
    .filter((line) => /^ {0,3}\[[^\]\n]+\]:\s*\S/.test(line))
    .join("\n");
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Points relative image paths at a URL that serves the document's folder. */
export function rewriteImages(markdown: string, baseUrl: string | null): string {
  if (!baseUrl) return markdown;
  const base = baseUrl.replace(/\/+$/, "");
  const resolve = (target: string): string => {
    if (SCHEME.test(target) || target.startsWith("/") || target.startsWith("#")) return target;
    const clean = target.replace(/^\.\//, "");
    if (clean.split("/").some((segment) => segment === "..")) return target;
    return `${base}/${clean.split("/").map(encodeURIComponent).join("/")}`;
  };
  return markdown
    .replace(
      /(!\[[^\]]*\]\(\s*)(?:<([^>]+)>|([^)\s]+))/g,
      (_, head: string, angled: string | undefined, plain: string | undefined) =>
        angled !== undefined ? `${head}<${resolve(angled)}>` : `${head}${resolve(plain ?? "")}`,
    )
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (_, head: string, target: string, tail: string) => `${head}${resolve(target)}${tail}`);
}

export function splitBlocks(input: string): MdBlock[] {
  const source = input.replace(/\r\n?/g, "\n");
  const blocks: MdBlock[] = [];
  let offset = 0;
  let line = 1;

  // YAML front matter renders as a code block so it can be commented too.
  const front = /^---\n([\s\S]*?)\n(?:---|\.\.\.)\n/.exec(source);
  if (front) {
    const raw = front[0];
    const lines = countLines(raw);
    blocks.push({ start: 1, end: lines, markdown: "```yaml\n" + front[1] + "\n```" });
    offset = raw.length;
    line = lines + 1;
  }

  const body = source.slice(offset);
  const definitions = referenceDefinitions(body);
  let tokens: ReturnType<typeof Lexer.lex>;
  try {
    tokens = Lexer.lex(body, { gfm: true });
  } catch {
    return [{ start: line, end: line + countLines(body), markdown: body }];
  }

  let cursor = 0;
  for (const token of tokens) {
    const raw = token.raw;
    if (!raw) continue;
    let at = body.indexOf(raw, cursor);
    if (at < 0) at = cursor;
    const startLine = line + countLines(body.slice(0, at));
    const trailing = raw.replace(/\n+$/, "");
    const endLine = startLine + countLines(trailing);
    cursor = at + raw.length;
    if (token.type === "space" || token.type === "def" || !trailing.trim()) continue;
    blocks.push({
      start: startLine,
      end: endLine,
      markdown: definitions ? `${trailing}\n\n${definitions}` : trailing,
    });
  }
  return blocks;
}

function normalizeForSearch(text: string): string {
  return text
    .replace(/[*_`~#>|\\[\]()!]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Narrows a selection to the source lines that contain it. Rendered text
 * drops Markdown syntax, so both sides are normalized before matching; when
 * nothing matches, the block's own range stands.
 */
export function narrowLines(
  sourceLines: readonly string[],
  range: { start: number; end: number },
  quote: string,
): { start: number; end: number } {
  const wanted = normalizeForSearch(quote);
  if (!wanted) return range;
  const offsets: { line: number; from: number }[] = [];
  let joined = "";
  for (let line = range.start; line <= range.end; line += 1) {
    const text = normalizeForSearch(sourceLines[line - 1] ?? "");
    if (!text) continue;
    if (joined) joined += " ";
    offsets.push({ line, from: joined.length });
    joined += text;
  }
  const lineAt = (position: number): number => {
    let found = range.start;
    for (const entry of offsets) {
      if (entry.from <= position) found = entry.line;
      else break;
    }
    return found;
  };
  const exact = joined.indexOf(wanted);
  if (exact >= 0) {
    return { start: lineAt(exact), end: lineAt(exact + wanted.length - 1) };
  }
  const head = wanted.slice(0, 40);
  const tail = wanted.slice(-40);
  const headAt = joined.indexOf(head);
  const tailAt = joined.lastIndexOf(tail);
  if (headAt >= 0 && tailAt >= headAt) {
    return { start: lineAt(headAt), end: lineAt(tailAt + tail.length - 1) };
  }
  if (headAt >= 0) return { start: lineAt(headAt), end: range.end };
  if (tailAt >= 0) return { start: range.start, end: lineAt(tailAt + tail.length - 1) };
  return range;
}
