// test/frontend/archive-tree.test.ts — §8.13, the tree an archive's flat
// member list becomes: implied folders, folders first, name order, duplicates,
// the lone-folder auto-open and the row cap.
import { describe, expect, it } from "vitest";

import type { ArchiveEntry } from "../../contract";
import {
  archiveSegments,
  buildArchiveTree,
  displayName,
  flattenArchiveTree,
  initialExpanded,
  type ArchiveNode,
} from "../../lib/archive-tree";

function member(path: string, kind: ArchiveEntry["kind"] = "file"): ArchiveEntry {
  return {
    path,
    kind,
    sizeBytes: kind === "file" ? 1 : 0,
    modifiedAtMs: null,
    encrypted: false,
    linkTarget: null,
  };
}

/** `name` for a leaf, `name/` for a folder, children indented by two spaces. */
function outline(nodes: readonly ArchiveNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${node.name}${node.kind === "directory" && node.name !== "/" ? "/" : ""}`,
    ...outline(node.children, depth + 1),
  ]);
}

describe("buildArchiveTree", () => {
  it("implies folders nobody listed, and lists folders first in name order", () => {
    const tree = buildArchiveTree([
      member("zeta.txt"),
      member("docs/b.txt"),
      member("docs/a.txt"),
      member("alpha/sub/deep.txt"),
      member("Beta.txt"),
    ]);

    expect(outline(tree)).toEqual([
      "alpha/",
      "  sub/",
      "    deep.txt",
      "docs/",
      "  a.txt",
      "  b.txt",
      "Beta.txt",
      "zeta.txt",
    ]);
    // Implied folders carry no member; they exist because their paths say so.
    expect(tree[0]?.entry).toBeNull();
  });

  it("sorts names the way the panel does — numerically, case-blind", () => {
    const tree = buildArchiveTree([member("file10.txt"), member("File2.txt"), member("file1.txt")]);
    expect(tree.map((node) => node.name)).toEqual(["file1.txt", "File2.txt", "file10.txt"]);
  });

  it("merges an explicit folder member into the implied folder, keeping its time", () => {
    const folder: ArchiveEntry = { ...member("docs/", "directory"), modifiedAtMs: 1234 };
    const tree = buildArchiveTree([member("docs/a.txt"), folder, member("docs")]);

    // `docs` the folder and `docs` the file are different members: both stay.
    expect(outline(tree)).toEqual(["docs/", "  a.txt", "docs"]);
    expect(tree[0]?.entry?.modifiedAtMs).toBe(1234);
  });

  it("keeps duplicate files — both copies are real members", () => {
    const tree = buildArchiveTree([member("dup.txt"), member("dup.txt")]);
    expect(tree).toHaveLength(2);
    expect(new Set(tree.map((node) => node.id)).size).toBe(2);
  });

  it("shows climbing and absolute members as folders named `..` and `/`", () => {
    const tree = buildArchiveTree([member("../evil.txt"), member("/etc/passwd"), member("./tar/./x")]);
    expect(outline(tree)).toEqual(["../", "  evil.txt", "/", "  etc/", "    passwd", "tar/", "  x"]);
    expect(tree[0]?.children[0]?.path).toBe("../evil.txt");
    expect(tree[1]?.children[0]?.path).toBe("/etc");
  });

  it("skips the archive's own top-level entry", () => {
    expect(buildArchiveTree([member(".", "directory"), member("a.txt")]).map((node) => node.name)).toEqual([
      "a.txt",
    ]);
  });

  it("splits paths by the same rules the backend counts folders by", () => {
    expect(archiveSegments("./a//b/./c")).toEqual(["a", "b", "c"]);
    expect(archiveSegments("/x")).toEqual(["/", "x"]);
    expect(archiveSegments("../x")).toEqual(["..", "x"]);
  });
});

describe("expansion and rows", () => {
  it("opens the chain of lone folders and stops where there is a choice", () => {
    const tree = buildArchiveTree([
      member("project/src/a.ts"),
      member("project/src/b.ts"),
      member("project/src/lib/c.ts"),
    ]);
    const expanded = initialExpanded(tree);
    const { rows } = flattenArchiveTree(tree, expanded, 100);

    expect(rows.map((row) => `${String(row.depth)}:${row.node.name}`)).toEqual([
      "0:project",
      "1:src",
      "2:lib",
      "2:a.ts",
      "2:b.ts",
    ]);
    expect(rows.filter((row) => row.expanded).map((row) => row.node.name)).toEqual(["project", "src"]);
  });

  it("opens nothing when the top level already holds a choice", () => {
    const tree = buildArchiveTree([member("a/x"), member("b/y")]);
    expect(initialExpanded(tree).size).toBe(0);
    expect(flattenArchiveTree(tree, new Set(), 100).rows).toHaveLength(2);
  });

  it("caps the rows and says so", () => {
    const tree = buildArchiveTree(Array.from({ length: 30 }, (_, index) => member(`f${String(index)}`)));
    const flat = flattenArchiveTree(tree, new Set(), 10);
    expect(flat.rows).toHaveLength(10);
    expect(flat.capped).toBe(true);
    expect(flattenArchiveTree(tree, new Set(), 30).capped).toBe(false);
  });
});

describe("displayName", () => {
  it("makes control characters visible instead of collapsing them", () => {
    expect(displayName("new\nline\t.txt")).toBe("new␊line␉.txt");
    expect(displayName("plain name.txt")).toBe("plain name.txt");
  });
});
