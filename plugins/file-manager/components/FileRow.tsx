// components/FileRow.tsx — one directory entry.
//
// Owns nothing: every interaction is reported upward to FileManagerPanel,
// which is the single source of truth for selection, clipboard and drag state
// (§8.1). The row is both a drag source and — when it is a directory — a drag
// target (§8.4).
import { memo, type DragEvent, type MouseEvent } from "react";

import type { FileEntry } from "../contract";
import { cn } from "../lib/utils";
import { formatBytes, formatDateTime, formatExactBytes, formatModified } from "../lib/format";
import { rootPhrase } from "../lib/fm-paths";
import { INDENT_STEP_PX, MAX_INDENT_DEPTH, MAX_TREE_ROWS } from "../lib/fm-tree";
import { Checkbox } from "./ui/checkbox";
import { Icon, type IconName } from "./ui/icon";
import { CONTROL_HOVER_TRANSITION } from "./ui/motion";
import { TableCell, TableRow } from "./ui/table";

/** Effective kind: a symlink is presented as what it points at. */
export function effectiveKind(entry: FileEntry): FileEntry["kind"] {
  if (entry.isSymlink && entry.targetKind !== null) return entry.targetKind;
  return entry.kind;
}

export function isDirectoryEntry(entry: FileEntry): boolean {
  return !entry.escapesRoot && effectiveKind(entry) === "directory";
}

export function isFileEntry(entry: FileEntry): boolean {
  return !entry.escapesRoot && effectiveKind(entry) === "file";
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "conf", "cfg",
  "log", "csv", "tsv", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py",
  "rs", "go", "rb", "sh", "bash", "zsh", "sql", "env",
]);

/** Icon for one entry, restricted to names present in the vendored ICON_MAP (§9). */
export function entryIconName(entry: FileEntry): IconName {
  if (entry.escapesRoot) return "ExternalLink";
  if (entry.archiveFormat !== null) return "Archive";
  const kind = effectiveKind(entry);
  if (kind === "directory") return "Folder";
  if (kind === "other") return "File";
  const dot = entry.name.lastIndexOf(".");
  const extension = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(extension) ? "FileText" : "File";
}

/**
 * Stable per-path DOM id, so `aria-activedescendant` on the grid can point at
 * the row the keyboard cursor is on. Paths are unique inside one listing, and
 * HTML5 allows every character but whitespace in an id.
 */
export function rowDomId(path: string): string {
  return `fm-row:${path}`;
}

export interface FileRowProps {
  entry: FileEntry;
  /** False on a touch (coarse) pointer, where a long press would start a drag. */
  dragEnabled: boolean;
  /** 0 for a row of the current directory; +1 per expanded ancestor. */
  depth: number;
  /** A navigable directory shallower than MAX_TREE_DEPTH gets a chevron. */
  expandable: boolean;
  expanded: boolean;
  /** Its child listing is in flight — the chevron becomes a spinner. */
  loadingChildren: boolean;
  /** The cached child listing was capped by the backend (§5.9). */
  childrenTruncated: boolean;
  onToggleExpand: (entry: FileEntry) => void;
  selected: boolean;
  /** Keyboard cursor position; drives `tabIndex` and the focus ring. */
  focused: boolean;
  /** Part of a pending `cut` clipboard (§8.5). */
  cut: boolean;
  /** Highlighted as the resolved drop target (§8.4). */
  dropTarget: boolean;
  nowMs: number;
  onRowClick: (entry: FileEntry, event: MouseEvent<HTMLElement>) => void;
  onRowDoubleClick: (entry: FileEntry) => void;
  onRowContextMenu: (entry: FileEntry, event: MouseEvent<HTMLElement>) => void;
  onToggleSelect: (entry: FileEntry) => void;
  onRowDragStart: (entry: FileEntry, event: DragEvent<HTMLElement>) => void;
  onRowDragOver: (entry: FileEntry, event: DragEvent<HTMLElement>) => void;
  onRowDragLeave: (entry: FileEntry, event: DragEvent<HTMLElement>) => void;
  onRowDrop: (entry: FileEntry, event: DragEvent<HTMLElement>) => void;
  onRowDragEnd: (event: DragEvent<HTMLElement>) => void;
}

function FileRowImpl({
  entry,
  dragEnabled,
  depth,
  expandable,
  expanded,
  loadingChildren,
  childrenTruncated,
  onToggleExpand,
  selected,
  focused,
  cut,
  dropTarget,
  nowMs,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  onToggleSelect,
  onRowDragStart,
  onRowDragOver,
  onRowDragLeave,
  onRowDrop,
  onRowDragEnd,
}: FileRowProps) {
  const directory = isDirectoryEntry(entry);
  const size = directory ? "—" : formatBytes(entry.sizeBytes);
  const indentPx = Math.min(depth, MAX_INDENT_DEPTH) * INDENT_STEP_PX;

  // `rootPhrase()` reads the root the panel published from `getState`; rows
  // only ever render after that bootstrap, so the memo never holds a stale one.
  const title = entry.escapesRoot
    ? `${entry.name} → outside ${rootPhrase()}`
    : childrenTruncated
      ? `${entry.name} — showing the first ${String(MAX_TREE_ROWS)} items`
      : entry.name;

  return (
    <TableRow
      role="row"
      id={rowDomId(entry.path)}
      aria-selected={selected}
      aria-level={depth + 1}
      aria-expanded={expandable ? expanded : undefined}
      data-testid="fm-row"
      data-fm-path={entry.path}
      data-fm-depth={String(depth)}
      data-selected={selected ? "true" : undefined}
      data-drop-target={dropTarget ? "true" : undefined}
      tabIndex={-1}
      draggable={dragEnabled}
      title={title}
      className={cn(
        "h-9 border-b border-border-hairline text-sm select-none",
        "hover:bg-state-hover active:bg-state-active",
        selected && "bg-surface-selected hover:bg-surface-selected",
        focused && "ring-1 ring-inset ring-ring",
        cut && "opacity-50",
        dropTarget && "ring-2 ring-inset ring-primary/50",
        entry.escapesRoot && "text-muted-foreground opacity-60",
      )}
      onClick={(event) => onRowClick(entry, event)}
      onDoubleClick={() => onRowDoubleClick(entry)}
      onContextMenu={(event) => onRowContextMenu(entry, event)}
      onDragStart={(event) => onRowDragStart(entry, event)}
      onDragOver={(event) => onRowDragOver(entry, event)}
      onDragLeave={(event) => onRowDragLeave(entry, event)}
      onDrop={(event) => onRowDrop(entry, event)}
      onDragEnd={onRowDragEnd}
    >
      <TableCell
        className="w-8 py-0 pl-3 pr-0"
        onClick={(event) => {
          event.stopPropagation();
          onToggleSelect(entry);
        }}
      >
        <Checkbox
          checked={selected}
          tabIndex={-1}
          aria-label={`Select ${entry.name}`}
          onCheckedChange={() => undefined}
        />
      </TableCell>

      <TableCell className="min-w-0 py-0">
        <div
          className="flex min-w-0 items-center gap-2"
          style={indentPx === 0 ? undefined : { paddingInlineStart: indentPx }}
        >
          {expandable ? (
            <button
              type="button"
              tabIndex={-1}
              data-testid="fm-chevron"
              data-fm-chevron={entry.path}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground",
                "hover:bg-state-hover hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "max-md:pointer-coarse:size-5",
                CONTROL_HOVER_TRANSITION,
              )}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleExpand(entry);
              }}
            >
              <Icon
                name={loadingChildren ? "Loading" : "ChevronRight"}
                className={cn(
                  "size-3.5 transition-transform duration-150",
                  loadingChildren && "animate-spin",
                  !loadingChildren && expanded && "rotate-90",
                )}
                aria-hidden="true"
              />
            </button>
          ) : (
            <span className="size-4 shrink-0 max-md:pointer-coarse:size-5" aria-hidden="true" />
          )}
          <Icon
            name={entryIconName(entry)}
            className={cn("size-4 shrink-0", directory ? "text-foreground" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className="truncate">{entry.name}</span>
          {entry.isSymlink ? (
            <Icon
              name="ExternalLink"
              className="size-3 shrink-0 text-muted-foreground"
              aria-label="Symbolic link"
            />
          ) : null}
        </div>
      </TableCell>

      <TableCell
        className="hidden w-24 py-0 text-right text-xs tabular-nums text-muted-foreground @md:table-cell"
        title={directory ? undefined : formatExactBytes(entry.sizeBytes)}
      >
        {size}
      </TableCell>

      <TableCell
        className="hidden w-32 py-0 text-xs tabular-nums text-muted-foreground @md:table-cell"
        title={formatDateTime(entry.modifiedAtMs)}
      >
        {formatModified(entry.modifiedAtMs, nowMs)}
      </TableCell>
    </TableRow>
  );
}

/**
 * Memoised: expanding one folder must re-render the rows it added, not the
 * other 500 already on screen. Every prop is a primitive, a stable
 * `useCallback` from the panel, or the `entry` object of a stable listing.
 */
export const FileRow = memo(FileRowImpl);
