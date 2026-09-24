// The file-opener tab: toolbar, document view, and comment list, plus the
// hand-off to the current chat or a new one.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";
import {
  useBbContext,
  useBbNavigate,
  type PluginFileOpenerProps,
  type PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { NeedsLibreOffice } from "@/components/viewer/NeedsLibreOffice";
import type { SheetData } from "@/lib/sheet-model";
import type {
  NeedsLibreOffice as NeedsLibreOfficeResult,
  ViewerLink,
  WorkbookSummary,
} from "../src/contract";
import {
  anchorLabel,
  isPaged,
  type Anchor,
  type PageInfo,
  type ReviewComment,
  type ReviewDoc,
} from "../src/types";
import { CommentEditor } from "./comment-editor";
import { CommentList, type CommentActions } from "./comment-list";
import { MarkdownDoc, type Point } from "./markdown-doc";
import { PagesDoc, type PageMode } from "./pages-doc";
import { SheetDoc } from "./sheet-doc";
import { errorText, useComments, useReviewDoc, useReviewRpc } from "./use-review";

/** Below this panel width the comment list becomes a bottom sheet. */
const WIDE_MIN_PX = 760;
/** Below this width the toolbar drops its labels (a phone, a thin panel). */
const COMPACT_MAX_PX = 560;
/** How much of the view the comment sheet covers on a narrow panel. */
const SHEET_SHARE = 0.55;

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function useWidth(element: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

type Content =
  | { kind: "md"; version: string; content: string; assetBaseUrl: string | null }
  | { kind: "pages"; version: string; pages: PageInfo[] }
  | { kind: "needs-libreoffice"; missing: NeedsLibreOfficeResult }
  | { kind: "sheet"; version: string; workbook: WorkbookSummary; sheet: SheetData };

/** Loads the document body for the current version; keeps the last one while reloading. */
function useDocContent(doc: ReviewDoc) {
  const rpc = useReviewRpc();
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    const load = async (): Promise<Content> => {
      if (doc.kind === "md") {
        return { kind: "md", ...(await rpc.call("doc.markdown", { docId: doc.id })) };
      }
      if (doc.kind === "spreadsheet") {
        const opened = await rpc.call("sheet.open", { docId: doc.id, locale: navigator.language || "en-US" });
        return { kind: "sheet", version: opened.version, workbook: opened.workbook, sheet: opened.sheet };
      }
      const pages = await rpc.call("doc.pages", { docId: doc.id });
      return pages.status === "ready"
        ? { kind: "pages", version: pages.version, pages: pages.pages }
        : { kind: "needs-libreoffice", missing: pages };
    };
    load().then(
      (next) => alive && setContent(next),
      (cause: unknown) => alive && setError(errorText(cause)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, doc.id, doc.kind, doc.version, reload]);

  const lastStale = useRef(0);
  const onStale = useCallback(() => {
    // Several page images fail at once when the file changes; reload once.
    const now = Date.now();
    if (now - lastStale.current < 3000) return;
    lastStale.current = now;
    setReload((value) => value + 1);
  }, []);
  const retry = useCallback(() => setReload((value) => value + 1), []);

  return { content, error, onStale, retry };
}

/** Refresh URLs well before their one-hour lease expires. */
const LINK_REFRESH_MS = 45 * 60 * 1000;

/** URLs for the classic PDF view and the original file, kept fresh while the tab is open. */
function useDocLinks(doc: ReviewDoc) {
  const rpc = useReviewRpc();
  const [links, setLinks] = useState<{ document: ViewerLink | null; download: ViewerLink } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      rpc.call("doc.links", { docId: doc.id }).then(
        (next) => alive && setLinks(next),
        () => undefined,
      );
    void load();
    const timer = window.setInterval(load, LINK_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [rpc, doc.id, doc.version]);
  return links;
}

function SendMenu({
  count,
  canSendHere,
  busy,
  compact,
  onSend,
}: {
  count: number;
  canSendHere: boolean;
  busy: boolean;
  compact: boolean;
  onSend: (target: "thread" | "new") => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const disabled = count === 0 || busy;
  const primary: "thread" | "new" = canSendHere ? "thread" : "new";
  return (
    <div ref={box} className="relative flex">
      <Button
        type="button"
        size="sm"
        className="rounded-r-none"
        disabled={disabled}
        onClick={() => onSend(primary)}
        aria-label={primary === "thread" ? "Send the drafts to this chat" : "Start a new chat with the drafts"}
      >
        {busy ? <Icon name="Loading" className="size-3.5 animate-spin" /> : <Icon name="Sent" className="size-3.5" />}
        {compact ? "Send" : primary === "thread" ? "Send to chat" : "Send to new chat"}
        {count > 0 ? <span className="tabular-nums opacity-80">{count}</span> : null}
      </Button>
      <Button
        type="button"
        size="sm"
        className="rounded-l-none border-l border-background/25 px-1.5"
        disabled={disabled}
        aria-label="More send options"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="ChevronDown" className="size-3.5" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg">
          <button
            type="button"
            disabled={!canSendHere}
            className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              setOpen(false);
              onSend("thread");
            }}
          >
            <span>To this chat</span>
            <span className="text-xs text-muted-foreground">
              {canSendHere ? "The agent here gets them as the next message" : "Open the file from a chat to use this"}
            </span>
          </button>
          <button
            type="button"
            className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onSend("new");
            }}
          >
            <span>To a new chat</span>
            <span className="text-xs text-muted-foreground">Same project and model, fresh context</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Workspace({
  doc,
  source,
  onShowOriginal,
}: {
  doc: ReviewDoc;
  source: PluginFileOpenerSource;
  /** Absent where bb's own preview is not available. */
  onShowOriginal?: () => void;
}) {
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const threadId = context.threadId ?? source.threadId ?? null;
  const instanceId = useId();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const width = useWidth(root);
  const wide = width >= WIDE_MIN_PX;
  const compact = width > 0 && width < COMPACT_MAX_PX;
  // Phones have no built-in PDF viewer worth switching to.
  const [touchOnly] = useState(() => window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false);

  const { comments, error: commentsError, refetch, setComments } = useComments(doc.id);
  const { content, error: contentError, onStale, retry } = useDocContent(doc);
  const links = useDocLinks(doc);
  const paged = isPaged(doc.kind);
  // The classic view is the browser's own PDF viewer: search, zoom, print.
  const [classic, setClassic] = useState(false);
  const showClassic = classic && paged && !touchOnly && Boolean(links?.document);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState(0);
  const [pending, setPending] = useState<{ anchor: Anchor; point: Point; range: Range | null } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<PageMode>("text");
  const [detached, setDetached] = useState<ReadonlySet<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);

  const list = comments ?? [];
  const coveredBottom = !wide && listOpen ? SHEET_SHARE : 0;
  const drafts = list.filter((comment) => comment.status === "draft");
  const needsYou = list.filter((comment) => comment.status === "replied").length;

  const onDetached = useCallback((ids: Set<string>) => {
    setDetached((current) =>
      current.size === ids.size && [...ids].every((id) => current.has(id)) ? current : ids,
    );
  }, []);

  const selectFromDoc = useCallback(
    (id: string) => {
      setActiveId(id);
      if (!wide) setListOpen(true);
    },
    [wide],
  );

  const selectFromList = useCallback((id: string) => {
    setActiveId(id);
    setScrollRequest((value) => value + 1);
  }, []);

  const requestComment = useCallback((anchor: Anchor, point: Point, range?: Range) => {
    setPending({ anchor, point, range: range ?? null });
    setActiveId(null);
  }, []);

  const create = async (anchor: Anchor, body: string): Promise<ReviewComment | null> => {
    try {
      const comment = await rpc.call("comments.create", {
        docId: doc.id,
        anchor,
        body,
        docVersion: doc.version,
      });
      setComments((current) =>
        current && !current.some((item) => item.id === comment.id) ? [...current, comment] : current,
      );
      return comment;
    } catch (cause) {
      toast.error(`Could not save the comment: ${errorText(cause)}`);
      return null;
    }
  };

  const actions: CommentActions = {
    onSelect: selectFromList,
    async onEdit(comment, body) {
      try {
        // An edited comment goes back to draft so it can be sent again.
        if (comment.status !== "draft") await rpc.call("comments.reopen", { id: comment.id });
        await rpc.call("comments.update", { id: comment.id, body });
        refetch();
      } catch (cause) {
        toast.error(errorText(cause));
      }
    },
    onDelete(comment) {
      setComments((current) => current?.filter((item) => item.id !== comment.id) ?? current);
      rpc.call("comments.delete", { id: comment.id }).then(refetch, (cause: unknown) => {
        toast.error(errorText(cause));
        refetch();
      });
    },
    onReopen(comment) {
      rpc.call("comments.reopen", { id: comment.id }).then(refetch, (cause: unknown) =>
        toast.error(errorText(cause)),
      );
    },
    async onAddGeneral(body) {
      const comment = await create({ kind: "doc" }, body);
      if (comment) setActiveId(comment.id);
    },
  };

  const send = async (target: "thread" | "new") => {
    if (drafts.length === 0 || sending) return;
    setSending(true);
    const count = drafts.length;
    const noun = count === 1 ? "comment" : "comments";
    try {
      if (target === "thread") {
        if (!threadId) throw new Error("Open this file from a chat to send comments there.");
        await rpc.call("comments.send", { docId: doc.id, target: { kind: "thread", threadId } });
        toast.success(`Sent ${count} ${noun} to this chat`);
      } else {
        try {
          const result = await rpc.call("comments.send", {
            docId: doc.id,
            target: {
              kind: "new-thread",
              sourceThreadId: threadId,
              projectId: source.projectId,
              environmentId: source.kind === "workspace" ? source.environmentId : null,
            },
          });
          toast.success(`Started a new chat with ${count} ${noun}`, {
            action: { label: "Open", onClick: () => navigate.toThread(result.threadId) },
          });
        } catch (cause) {
          if (!/not in a project/i.test(errorText(cause))) throw cause;
          // No project to start a chat in: prefill the new-chat screen instead.
          const handoff = await rpc.call("comments.handoffPrompt", { docId: doc.id });
          await rpc.call("comments.markSent", { ids: handoff.ids, threadId: null });
          navigate.toCompose({ initialPrompt: handoff.prompt, focusPrompt: true });
        }
      }
      refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSending(false);
    }
  };

  const composer = pending ? (
    <CommentEditor
      label={anchorLabel(pending.anchor, doc.kind)}
      busy={saving}
      onCancel={() => setPending(null)}
      onSubmit={(body) => {
        setSaving(true);
        create(pending.anchor, body)
          .then((comment) => {
            if (!comment) return;
            setPending(null);
            setActiveId(comment.id);
          })
          .finally(() => setSaving(false));
      }}
    />
  ) : null;

  const listPanel = (
    <CommentList
      comments={list}
      kind={doc.kind}
      docVersion={doc.version}
      activeId={activeId}
      detachedIds={detached}
      actions={actions}
      header={
        commentsError ? <p className="text-xs text-destructive">{commentsError}</p> : null
      }
    />
  );

  const loadingLabel =
    doc.kind === "text" || doc.kind === "presentation"
      ? "Converting to PDF…"
      : doc.kind === "spreadsheet"
        ? "Reading the workbook…"
        : doc.kind === "pdf"
          ? "Rendering pages…"
          : "Loading…";

  const body = contentError ? (
    <Centered>
      <p className="text-foreground">Could not render this file.</p>
      <p className="max-w-md text-xs">{contentError}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
        {onShowOriginal ? (
          <Button type="button" variant="ghost" size="sm" onClick={onShowOriginal}>
            Open bb's preview
          </Button>
        ) : null}
      </div>
    </Centered>
  ) : !content ? (
    <Centered>
      <Icon name="Loading" className="size-5 animate-spin" />
      <p>{loadingLabel}</p>
    </Centered>
  ) : showClassic && links?.document ? (
    <iframe
      key={`${doc.id}:${doc.version}`}
      src={links.document.url}
      title={doc.name}
      className="absolute inset-0 h-full w-full border-0 bg-muted"
    />
  ) : content.kind === "needs-libreoffice" ? (
    <NeedsLibreOffice
      result={content.missing}
      name={doc.name}
      downloadUrl={links?.download.url ?? null}
      onReload={retry}
    />
  ) : content.kind === "sheet" ? (
    <SheetDoc
      key={`${doc.id}:${content.version}`}
      docId={doc.id}
      initial={content}
      comments={list}
      activeId={activeId}
      scrollRequest={scrollRequest}
      pendingAnchor={pending?.anchor ?? null}
      composer={composer}
      composerPoint={pending?.point ?? null}
      onRequestComment={requestComment}
      onSelectComment={selectFromDoc}
    />
  ) : content.kind === "md" ? (
    <MarkdownDoc
      instanceId={instanceId}
      content={content.content}
      assetBaseUrl={content.assetBaseUrl}
      comments={list}
      activeId={activeId}
      scrollRequest={scrollRequest}
      scroller={scroller}
      coveredBottom={coveredBottom}
      pendingRange={pending?.range ?? null}
      composer={composer}
      composerPoint={pending?.point ?? null}
      onRequestComment={requestComment}
      onSelectComment={selectFromDoc}
      onDetached={onDetached}
    />
  ) : (
    <PagesDoc
      docId={doc.id}
      kind={doc.kind}
      version={content.version}
      pages={content.pages}
      mode={mode}
      comments={list}
      activeId={activeId}
      scrollRequest={scrollRequest}
      scroller={scroller}
      overlay={overlay}
      coveredBottom={coveredBottom}
      pendingAnchor={pending?.anchor ?? null}
      composer={composer}
      composerPoint={pending?.point ?? null}
      onStale={onStale}
      onRequestComment={requestComment}
      onSelectComment={selectFromDoc}
    />
  );

  const hasPages = paged && content?.kind === "pages" && !showClassic;
  const ownScroll = content?.kind === "sheet" || showClassic;
  return (
    <div ref={root} className="relative flex h-full min-h-0 flex-col bg-background">
      <div className={cn("flex shrink-0 items-center border-b border-border py-2", compact ? "gap-1 px-2" : "gap-2 px-3")}>
        {hasPages ? (
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Selection mode">
            {(["text", "area"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                title={value === "text" ? "Select text to comment" : "Draw a box to comment on an area"}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs",
                  mode === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon name={value === "text" ? "TextWrap" : "Square"} className="size-3.5" />
                {compact ? <span className="sr-only">{value === "text" ? "Text" : "Area"}</span> : value === "text" ? "Text" : "Area"}
              </button>
            ))}
          </div>
        ) : null}
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {compact ? null : (
            <>
              {needsYou > 0 ? `${needsYou} answered · ` : ""}
              {list.length === 0 ? "No comments yet" : `${list.length} comment${list.length === 1 ? "" : "s"}`}
            </>
          )}
        </div>
        {paged && !touchOnly && links?.document ? (
          <Button
            type="button"
            variant={showClassic ? "secondary" : "ghost"}
            size="sm"
            className="h-8 px-2 text-xs"
            aria-pressed={showClassic}
            aria-label={showClassic ? "Back to commenting" : "Classic view: search, zoom, print"}
            onClick={() => setClassic((value) => !value)}
          >
            <Icon name={showClassic ? "MessageSquare" : "Eye"} className="size-4" />
            {compact ? null : showClassic ? "Comment" : "Classic"}
          </Button>
        ) : null}
        {doc.kind === "md" && onShowOriginal ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Show bb's own preview"
            onClick={onShowOriginal}
          >
            <Icon name="Eye" className="size-4" />
          </Button>
        ) : null}
        {links ? (
          <Button asChild type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground">
            <a href={links.download.url} download={doc.name} aria-label={`Download ${doc.name}`}>
              <Icon name="Download" className="size-4" />
            </a>
          </Button>
        ) : null}
        {wide ? null : (
          <Button
            type="button"
            variant={listOpen ? "secondary" : "ghost"}
            size="sm"
            className="relative h-8 px-2"
            aria-pressed={listOpen}
            aria-label={needsYou > 0 ? `Comments, ${needsYou} answered` : "Comments"}
            onClick={() => setListOpen((value) => !value)}
          >
            <Icon name="MessageSquare" className="size-4" />
            <span className="tabular-nums">{list.length}</span>
            {needsYou > 0 ? (
              <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" aria-hidden />
            ) : null}
          </Button>
        )}
        <SendMenu
          count={drafts.length}
          canSendHere={Boolean(threadId)}
          busy={sending}
          compact={compact}
          onSend={(target) => void send(target)}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <div
            ref={scroller}
            className={cn(
              "relative min-w-0 flex-1",
              ownScroll ? "overflow-hidden" : "overflow-auto",
              // Pages zoom by pinching inside the view, not the whole app.
              hasPages && "overscroll-x-contain [scrollbar-gutter:stable] [touch-action:pan-x_pan-y]",
            )}
          >
            {body}
          </div>
          <div ref={setOverlay} className="pointer-events-none absolute inset-0 z-30" />
        </div>
        {wide ? (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-background">
            {listPanel}
          </aside>
        ) : null}
      </div>
      {!wide && listOpen ? (
        <div className="absolute inset-x-0 bottom-0 z-40 max-h-[55%] overflow-y-auto overscroll-contain rounded-t-xl border-t border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-3 py-1.5">
            <span className="text-xs font-medium">Comments</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Close comments"
              onClick={() => setListOpen(false)}
            >
              <Icon name="ChevronDown" className="size-4" />
            </Button>
          </div>
          {listPanel}
        </div>
      ) : null}
    </div>
  );
}

export function ReviewOpener({ path, source, Original }: PluginFileOpenerProps) {
  const { doc, error } = useReviewDoc(path, source);
  const [original, setOriginal] = useState(false);
  const back = useMemo(
    () => (
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOriginal(false)}>
          <Icon name="MessageSquare" className="size-4" />
          Back to review
        </Button>
      </div>
    ),
    [],
  );

  if (original || (error && !doc)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {error ? (
          <div className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            Doc Review could not open this file: {error}
          </div>
        ) : (
          back
        )}
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      </div>
    );
  }
  if (!doc) {
    return (
      <Centered>
        <Icon name="Loading" className="size-5 animate-spin" />
      </Centered>
    );
  }
  return <Workspace doc={doc} source={source} onShowOriginal={() => setOriginal(true)} />;
}
