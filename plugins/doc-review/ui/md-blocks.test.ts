import { describe, expect, it } from "vitest";
import { narrowLines, rewriteImages, splitBlocks } from "./md-blocks";

const SOURCE = [
  "---", // 1
  "title: Plan", // 2
  "---", // 3
  "", // 4
  "# Heading", // 5
  "", // 6
  "Intro with **bold** text", // 7
  "that wraps.", // 8
  "", // 9
  "1. First goal", // 10
  "2. Second goal", // 11
  "", // 12
  "[ref]: https://example.com", // 13
].join("\n");

describe("splitBlocks", () => {
  it("keeps source line ranges for every block", () => {
    const blocks = splitBlocks(SOURCE);
    expect(blocks.map((block) => [block.start, block.end])).toEqual([
      [1, 3],
      [5, 5],
      [7, 8],
      [10, 11],
    ]);
  });

  it("renders front matter as a code block and appends link definitions", () => {
    const blocks = splitBlocks(SOURCE);
    expect(blocks[0]!.markdown).toContain("```yaml");
    expect(blocks[2]!.markdown).toContain("[ref]: https://example.com");
  });

  it("treats CRLF input like LF", () => {
    const blocks = splitBlocks(SOURCE.replace(/\n/g, "\r\n"));
    expect(blocks[3]).toMatchObject({ start: 10, end: 11 });
  });
});

describe("narrowLines", () => {
  const lines = SOURCE.split("\n");

  it("narrows a selection to the lines that contain it", () => {
    expect(narrowLines(lines, { start: 10, end: 11 }, "Second goal")).toEqual({ start: 11, end: 11 });
  });

  it("matches rendered text across Markdown syntax and line wraps", () => {
    expect(narrowLines(lines, { start: 7, end: 8 }, "bold text that wraps")).toEqual({ start: 7, end: 8 });
  });

  it("falls back to the block range when nothing matches", () => {
    expect(narrowLines(lines, { start: 10, end: 11 }, "unrelated")).toEqual({ start: 10, end: 11 });
  });
});

describe("rewriteImages", () => {
  it("points relative images at the document folder", () => {
    expect(rewriteImages('![a](img/shot.png "Title")', "https://x/p/")).toBe(
      '![a](https://x/p/img/shot.png "Title")',
    );
    expect(rewriteImages("![a](<img/shot 1.png>)", "https://x/p")).toBe("![a](<https://x/p/img/shot%201.png>)");
  });

  it("leaves absolute, remote, and parent paths alone", () => {
    const text = "![a](https://e.com/a.png) ![b](/abs.png) ![c](../up.png)";
    expect(rewriteImages(text, "https://x/p")).toBe(text);
  });
});
