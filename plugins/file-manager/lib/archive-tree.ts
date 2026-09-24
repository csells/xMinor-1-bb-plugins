// lib/archive-tree.ts — an archive's flat member list as a folder tree
// (§8.13). Pure: no React, no RPC, so every rule below is unit-testable.
//
// Archives rarely list their own folders. A zip made by Windows Explorer
// names only the files, and `dir/sub/file.txt` is the only evidence that
// `dir` and `dir/sub` exist — so folders are *implied* from paths, and an
// explicit folder member, when there is one, only lends the folder its time.
//
// Paths are split by the same rules the backend counts folders by
// (src/archive-parse.ts#memberSegments): empty and `.` segments dropped, `..`
// kept as a literal name, a leading `/` kept as a folder named `/`. Nothing
// here resolves anything — a `../evil` member is a folder called `..` with
// `evil` inside it, which is exactly what the archive says.
import type { ArchiveEntry, ArchiveEntryKind } from "../contract";

export interface ArchiveNode {
  /** Stable within one tree; safe as a React key and inside a DOM id. */
  id: string;
  /** One path segment, as the archive spells it. */
  name: string;
  /** The member's full path inside the archive, `/`-joined, for tooltips. */
  path: string;
  /** "directory" for every folder, explicit or implied. */
  kind: ArchiveEntryKind;
  /** The member itself; null for a folder only its children's paths imply. */
  entry: ArchiveEntry | null;
  /** Folders first, then by name — the order the page renders. */
  children: ArchiveNode[];
}

/** One visible line of the tree. */
export interface ArchiveRow {
  node: ArchiveNode;
  /** 0 for the archive's top level. */
  depth: number;
  expanded: boolean;
}

/** Mirrors src/archive-parse.ts#memberSegments — keep the two in step. */
export function archiveSegments(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return path.startsWith("/") ? ["/", ...segments] : segments;
}

function compareNodes(a: ArchiveNode, b: ArchiveNode): number {
  const aFolder = a.kind === "directory" ? 0 : 1;
  const bFolder = b.kind === "directory" ? 0 : 1;
  if (aFolder !== bFolder) return aFolder - bFolder;
  // The panel's own name order (hooks/useDirectory.ts): numeric, case-blind.
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

interface Builder {
  node: ArchiveNode;
  /** Child folders by name: a folder is one node however often it is named. */
  folders: Map<string, Builder>;
}

/**
 * Build the tree. Files are never merged — an archive can hold one name
 * twice (a zip appended to, a tar with an update), and both copies are real
 * members — while folders always are.
 */
export function buildArchiveTree(entries: readonly ArchiveEntry[]): ArchiveNode[] {
  let nextId = 0;
  const makeNode = (name: string, path: string, entry: ArchiveEntry | null): ArchiveNode => ({
    id: `n${String((nextId += 1))}`,
    name,
    path,
    kind: entry === null ? "directory" : entry.kind,
    entry,
    children: [],
  });
  const root: Builder = { node: makeNode("", "", null), folders: new Map() };

  const folderAt = (parent: Builder, name: string, path: string): Builder => {
    let folder = parent.folders.get(name);
    if (folder === undefined) {
      folder = { node: makeNode(name, path, null), folders: new Map() };
      parent.folders.set(name, folder);
      parent.node.children.push(folder.node);
    }
    return folder;
  };

  for (const entry of entries) {
    const segments = archiveSegments(entry.path);
    if (segments.length === 0) continue; // `./` — the archive's own top level
    let parent = root;
    let path = "";
    const last = segments.length - 1;
    for (let index = 0; index < last; index += 1) {
      const segment = segments[index] as string;
      path = path === "" ? segment : `${path === "/" ? "" : path}/${segment}`;
      parent = folderAt(parent, segment, path);
    }
    const name = segments[last] as string;
    path = path === "" ? name : `${path === "/" ? "" : path}/${name}`;
    if (entry.kind === "directory") {
      const folder = folderAt(parent, name, path);
      // The first explicit member lends its time; the folder stays one node.
      if (folder.node.entry === null) folder.node.entry = entry;
    } else {
      parent.node.children.push(makeNode(name, path, entry));
    }
  }

  const sortAll = (nodes: ArchiveNode[]): void => {
    nodes.sort(compareNodes);
    for (const node of nodes) if (node.children.length > 0) sortAll(node.children);
  };
  sortAll(root.node.children);
  return root.node.children;
}

/**
 * The rows on screen: every top-level node, plus the children of each
 * expanded folder, depth-first. Stops at `maxRows` and says so — a folder
 * with fifty thousand files would otherwise turn one click into a page that
 * no longer scrolls.
 */
export function flattenArchiveTree(
  roots: readonly ArchiveNode[],
  expanded: ReadonlySet<string>,
  maxRows: number,
): { rows: ArchiveRow[]; capped: boolean } {
  const rows: ArchiveRow[] = [];
  let capped = false;
  const walk = (nodes: readonly ArchiveNode[], depth: number): void => {
    for (const node of nodes) {
      if (rows.length >= maxRows) {
        capped = true;
        return;
      }
      const open = node.kind === "directory" && expanded.has(node.id);
      rows.push({ node, depth, expanded: open });
      if (open) walk(node.children, depth + 1);
      if (capped) return;
    }
  };
  walk(roots, 0);
  return { rows, capped };
}

/**
 * The folders to open on arrival: the chain of lone top-level folders.
 *
 * Most archives wrap everything in one folder named after themselves, and
 * opening on a single collapsed row is a click the user always has to make.
 * The chain stops at the first level holding more than one thing — past that
 * point there is nothing to guess.
 */
export function initialExpanded(roots: readonly ArchiveNode[], maxDepth = 8): Set<string> {
  const expanded = new Set<string>();
  let level = roots;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const only = level.length === 1 ? level[0] : undefined;
    if (only === undefined || only.kind !== "directory") break;
    expanded.add(only.id);
    level = only.children;
  }
  return expanded;
}

/** Control characters as their visible Unicode pictures (U+2400 block). */
// eslint-disable-next-line no-control-regex -- deliberate: these are what it replaces
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;

/**
 * A name as it can be shown on one line. A newline or a tab inside a member
 * name is legal and does happen; rendered raw it would collapse into a space
 * and the row would claim a name the archive does not hold.
 */
export function displayName(name: string): string {
  return name.replace(CONTROL_CHARACTERS, (char) => {
    const code = char.charCodeAt(0);
    return String.fromCharCode(code === 0x7f ? 0x2421 : 0x2400 + code);
  });
}
