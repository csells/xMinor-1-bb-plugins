// components/ArchiveContents.tsx — what is inside an archive (§8.13).
//
// One body for the two surfaces that show a file: the built-in viewer (quick
// look inside the panel, §8.12) and the "Preview + location" file opener (a
// link to an archive in a chat message, §10.2). Both hand it an absolute path
// the backend already agreed exists; this component asks `listArchive` for
// the table of contents and draws it as a tree — folders first, collapsible,
// sorted by name — under one summary line.
//
// It never extracts anything and owns no extraction path of its own.
// "Extract…" is a callback, offered only when the listing says this host can
// unpack the format: each surface decides where it leads, and both lead into
// the panel's existing ExtractDialog and job tray. A second way to start an
// extraction would be a second set of bugs.
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { detectArchiveFormat, type ArchiveListing } from "../contract";
import {
  buildArchiveTree,
  displayName,
  flattenArchiveTree,
  initialExpanded,
  type ArchiveNode,
  type ArchiveRow,
} from "../lib/archive-tree";
import { parseRpcError } from "../lib/errors";
import { MAX_TREE_ROWS, INDENT_STEP_PX, MAX_INDENT_DEPTH } from "../lib/fm-tree";
import { formatBytes, formatDateTime, formatExactBytes, formatModified } from "../lib/format";
import { useFmRpc } from "../lib/fm-rpc";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./ui/icon";

type ListingState =
  | { status: "loading" }
  | { status: "ready"; listing: ArchiveListing }
  | { status: "failed"; unsupported: boolean; message: string };

export interface ArchiveContentsProps {
  /** Absolute path of the archive, as the backend reported it. */
  path: string;
  /**
   * Starts the surface's own extraction flow. Shown only when the listing
   * says `extractable` — a button that ends in "no extractor on this host" is
   * worse than no button.
   */
  onExtract?: (() => void) | undefined;
  className?: string;
}

/** The middle of the body when there is no tree to draw. */
function Placeholder({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="flex h-full w-full flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      <div className="max-w-md space-y-2">{children}</div>
    </div>
  );
}

export function ArchiveContents({ path, onExtract, className }: ArchiveContentsProps) {
  const rpc = useFmRpc();
  const [state, setState] = useState<ListingState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const listing = await rpc.call("listArchive", { path });
        if (!cancelled) setState({ status: "ready", listing });
      } catch (failure) {
        if (cancelled) return;
        const parsed = parseRpcError(failure);
        setState({
          status: "failed",
          // "No tool for this format here" is a fact about the host, not a
          // fault in the file, and reads differently.
          unsupported: parsed.code === "unsupported_archive",
          message: parsed.message === "" ? parsed.rawMessage : parsed.message,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, rpc]);

  let body: React.ReactNode;
  if (state.status === "loading") {
    body = <Placeholder testId="fm-archive-loading">Reading the archive…</Placeholder>;
  } else if (state.status === "failed") {
    body = (
      <Placeholder testId="fm-archive-error">
        <p className="font-medium text-foreground">
          {state.unsupported ? "Can't look inside this archive here" : "Could not read this archive"}
        </p>
        <p className="break-words">{state.message}</p>
      </Placeholder>
    );
  } else {
    // Keyed by the listing, so a re-read starts from its own expansion rather
    // than carrying ids that belong to the previous tree.
    body = <ListingView key={state.listing.path} listing={state.listing} onExtract={onExtract} />;
  }

  return (
    <div
      data-testid="fm-archive"
      className={cn("@container flex min-h-0 flex-1 flex-col overflow-hidden", className)}
    >
      {body}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The listing itself                                                  */
/* ------------------------------------------------------------------ */

function countText(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * Why the list or the counts are not the whole archive, in one sentence — or
 * null when they are. A partial scan outranks a merely capped list: when the
 * counts themselves are lower bounds, that is the thing to say.
 */
function noteFor(listing: ArchiveListing): { text: string; warning: boolean } | null {
  const shown = listing.entries.length.toLocaleString();
  switch (listing.stoppedBy) {
    case "damaged":
      return {
        text: `This archive looks damaged or cut short — showing the ${shown} entries that could be read.${
          listing.problem === null ? "" : ` (${listing.problem})`
        }`,
        warning: true,
      };
    case "time":
      return {
        text: `Reading this archive took too long, so the listing stopped after ${listing.totalEntries.toLocaleString()} entries — the counts above cover only that part.`,
        warning: true,
      };
    case "output":
    case "entries":
      return {
        text: `This archive is too large to count in full — showing the first ${shown} entries; the counts above cover the first ${listing.totalEntries.toLocaleString()}.`,
        warning: true,
      };
    case null:
      break;
  }
  if (listing.truncated) {
    return {
      text: `Showing the first ${shown} of ${listing.totalEntries.toLocaleString()} entries.`,
      warning: false,
    };
  }
  return null;
}

/** Same set as the panel's rows (components/FileRow.tsx), so icons agree. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "conf", "cfg",
  "log", "csv", "tsv", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py",
  "rs", "go", "rb", "sh", "bash", "zsh", "sql", "env",
]);

/** The row icon, from the names the vendored ICON_MAP carries (§9). */
function nodeIcon(node: ArchiveNode, expanded: boolean): IconName {
  if (node.kind === "directory") return expanded ? "FolderOpen" : "Folder";
  if (detectArchiveFormat(node.name) !== null) return "Archive";
  const dot = node.name.lastIndexOf(".");
  const extension = dot > 0 ? node.name.slice(dot + 1).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(extension) ? "FileText" : "File";
}

function ListingView({
  listing,
  onExtract,
}: {
  listing: ArchiveListing;
  onExtract: (() => void) | undefined;
}) {
  const tree = useMemo(() => buildArchiveTree(listing.entries), [listing]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => initialExpanded(tree));
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const baseId = useId();
  const { rows, capped } = useMemo(
    () => flattenArchiveTree(tree, expanded, MAX_TREE_ROWS),
    [expanded, tree],
  );
  // `nowMs` only feeds the relative "Modified" wording; one clock per listing
  // (this view is keyed by the listing, so it mounts once per answer).
  const [nowMs] = useState(() => Date.now());
  const domId = useCallback((node: ArchiveNode) => `${baseId}-${node.id}`, [baseId]);

  const toggle = useCallback((node: ArchiveNode) => {
    if (node.kind !== "directory") return;
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }, []);

  const focusRow = useCallback((node: ArchiveNode) => {
    setFocusedId(node.id);
  }, []);

  // Keep the keyboard cursor on screen as it moves.
  useEffect(() => {
    if (focusedId === null) return;
    const element = document.getElementById(`${baseId}-${focusedId}`);
    element?.scrollIntoView?.({ block: "nearest" });
  }, [baseId, focusedId]);

  /**
   * The WAI-ARIA tree keys: ↑/↓ move, → opens a folder or steps into it,
   * ← closes a folder or steps out to its parent, Home/End jump, Enter and
   * Space toggle. Anything else is left alone.
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.node.id === focusedId);
    const current: ArchiveRow | undefined = index < 0 ? undefined : rows[index];
    const moveTo = (target: number): void => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, target))];
      if (row !== undefined) setFocusedId(row.node.id);
    };
    switch (event.key) {
      case "ArrowDown":
        moveTo(index < 0 ? 0 : index + 1);
        break;
      case "ArrowUp":
        moveTo(index < 0 ? 0 : index - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (current === undefined) {
          moveTo(0);
        } else if (current.node.kind === "directory") {
          if (!current.expanded) toggle(current.node);
          else if (current.node.children.length > 0) moveTo(index + 1);
        }
        break;
      case "ArrowLeft":
        if (current === undefined) {
          moveTo(0);
        } else if (current.node.kind === "directory" && current.expanded) {
          toggle(current.node);
        } else {
          for (let parent = index - 1; parent >= 0; parent -= 1) {
            if ((rows[parent]?.depth ?? 0) < current.depth) {
              moveTo(parent);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ":
        if (current !== undefined) toggle(current.node);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const note = noteFor(listing);
  const focusOnScreen = focusedId !== null && rows.some((row) => row.node.id === focusedId);
  const canExtract = listing.extractable && onExtract !== undefined;

  return (
    <>
      <div
        data-testid="fm-archive-summary"
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2 text-xs text-muted-foreground"
      >
        <span className="tabular-nums">{countText(listing.fileCount, "file")}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{countText(listing.directoryCount, "folder")}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums" title={formatExactBytes(listing.uncompressedBytes)}>
          {formatBytes(listing.uncompressedBytes)} uncompressed
        </span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums" title={formatExactBytes(listing.archiveSizeBytes)}>
          {formatBytes(listing.archiveSizeBytes)} archive
        </span>
        {listing.encryptedCount > 0 ? (
          <span className="flex items-center gap-1 tabular-nums" data-testid="fm-archive-encrypted">
            <span aria-hidden="true">·</span>
            <Icon name="Lock" className="size-3.5" aria-hidden="true" />
            {listing.encryptedCount.toLocaleString()} encrypted
          </span>
        ) : null}
        <span className="flex-1" />
        {canExtract ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-foreground"
            data-testid="fm-archive-extract"
            onClick={onExtract}
          >
            <Icon name="ArchiveRestore" className="size-4" aria-hidden="true" />
            Extract…
          </Button>
        ) : null}
      </div>

      {note === null ? null : (
        <p
          data-testid="fm-archive-note"
          className={cn(
            "shrink-0 border-b border-border px-3 py-1.5 text-xs",
            note.warning ? "bg-surface-attention text-warning-text" : "text-muted-foreground",
          )}
        >
          {note.text}
        </p>
      )}

      {rows.length === 0 ? (
        listing.partial ? null : (
          <Placeholder testId="fm-archive-empty">This archive is empty.</Placeholder>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" data-testid="fm-archive-scroll">
          <div
            aria-hidden="true"
            className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-border bg-background px-3 text-xs font-medium text-muted-foreground"
          >
            <span className="min-w-0 flex-1 pl-6">Name</span>
            <span className="w-20 shrink-0 text-right">Size</span>
            <span className="hidden w-28 shrink-0 @md:block">Modified</span>
          </div>
          <div
            role="tree"
            aria-label="Archive contents"
            tabIndex={0}
            aria-activedescendant={
              focusOnScreen && focusedId !== null ? `${baseId}-${focusedId}` : undefined
            }
            data-testid="fm-archive-tree"
            className="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onKeyDown={handleKeyDown}
            onFocus={() => {
              const first = rows[0];
              if (focusedId === null && first !== undefined) setFocusedId(first.node.id);
            }}
          >
            {rows.map((row) => (
              <ArchiveTreeRow
                key={row.node.id}
                row={row}
                domId={domId(row.node)}
                focused={row.node.id === focusedId}
                nowMs={nowMs}
                onToggle={toggle}
                onFocusRow={focusRow}
              />
            ))}
          </div>
          {capped ? (
            <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="fm-archive-capped">
              Showing the first {String(MAX_TREE_ROWS)} rows. Collapse a folder to see more.
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

interface ArchiveTreeRowProps {
  row: ArchiveRow;
  domId: string;
  focused: boolean;
  nowMs: number;
  onToggle: (node: ArchiveNode) => void;
  onFocusRow: (node: ArchiveNode) => void;
}

/**
 * One member. Memoised like FileRow: opening one folder must re-render the
 * rows it added, not every row already on screen.
 */
const ArchiveTreeRow = memo(function ArchiveTreeRow({
  row,
  domId,
  focused,
  nowMs,
  onToggle,
  onFocusRow,
}: ArchiveTreeRowProps) {
  const { node, depth, expanded } = row;
  const folder = node.kind === "directory";
  const entry = node.entry;
  const indentPx = Math.min(depth, MAX_INDENT_DEPTH) * INDENT_STEP_PX;
  const link = entry !== null && (entry.kind === "symlink" || entry.kind === "hardlink");
  const modifiedAtMs = entry?.modifiedAtMs ?? null;
  const size = entry !== null && entry.kind === "file" ? formatBytes(entry.sizeBytes) : "—";

  return (
    <div
      role="treeitem"
      id={domId}
      aria-level={depth + 1}
      aria-expanded={folder ? expanded : undefined}
      aria-selected={focused}
      data-testid="fm-archive-row"
      data-archive-path={node.path}
      data-kind={node.kind}
      title={
        link && entry?.linkTarget
          ? `${node.path} ${entry.kind === "hardlink" ? "is a hard link to" : "→"} ${entry.linkTarget}`
          : node.path
      }
      className={cn(
        "flex h-9 cursor-default select-none items-center gap-2 border-b border-border-hairline px-3 text-sm",
        "hover:bg-state-hover",
        focused && "bg-surface-selected hover:bg-surface-selected",
      )}
      onClick={() => {
        onFocusRow(node);
        if (folder) onToggle(node);
      }}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        style={indentPx === 0 ? undefined : { paddingInlineStart: indentPx }}
      >
        {folder ? (
          <Icon
            name="ChevronRight"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        ) : (
          <span className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <Icon
          name={nodeIcon(node, expanded)}
          className={cn("size-4 shrink-0", folder ? "text-foreground" : "text-muted-foreground")}
          aria-hidden="true"
        />
        <span className="truncate">{displayName(node.name)}</span>
        {link ? (
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            data-testid="fm-archive-link"
          >
            {entry?.kind === "hardlink" ? "hard link to " : "→ "}
            {entry?.linkTarget === null || entry?.linkTarget === undefined
              ? "(target not recorded)"
              : displayName(entry.linkTarget)}
          </span>
        ) : null}
        {entry?.encrypted ? (
          <Icon name="Lock" className="size-3.5 shrink-0 text-muted-foreground" aria-label="Encrypted" />
        ) : null}
      </div>
      <span
        className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
        title={entry !== null && entry.kind === "file" ? formatExactBytes(entry.sizeBytes) : undefined}
      >
        {size}
      </span>
      <span
        className="hidden w-28 shrink-0 text-xs tabular-nums text-muted-foreground @md:block"
        title={modifiedAtMs === null ? undefined : formatDateTime(modifiedAtMs)}
      >
        {modifiedAtMs === null ? "—" : formatModified(modifiedAtMs, nowMs)}
      </span>
    </div>
  );
});
