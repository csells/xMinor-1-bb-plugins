// The comment list: drafts to send, comments waiting on an agent, answers
// that need the user, and resolved ones.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  anchorLabel,
  anchorQuote,
  truncate,
  type CommentStatus,
  type DocKind,
  type ReviewComment,
} from "../src/types";
import { CommentEditor } from "./comment-editor";

const SECTIONS: { status: CommentStatus; title: string; hint: string }[] = [
  { status: "replied", title: "Needs you", hint: "The agent answered instead of changing the file." },
  { status: "draft", title: "Drafts", hint: "Not sent yet." },
  { status: "sent", title: "Waiting for the agent", hint: "" },
  { status: "resolved", title: "Done", hint: "" },
];

const STATUS_LABEL: Record<CommentStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  replied: "Answered",
  resolved: "Done",
};

export interface CommentActions {
  onSelect: (id: string) => void;
  onEdit: (comment: ReviewComment, body: string) => Promise<void>;
  onDelete: (comment: ReviewComment) => void;
  onReopen: (comment: ReviewComment) => void;
  onAddGeneral: (body: string) => Promise<void>;
}

function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground hover:text-foreground"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} className="size-3.5" />
    </Button>
  );
}

function CommentCard({
  comment,
  kind,
  active,
  stale,
  detached,
  actions,
}: {
  comment: ReviewComment;
  kind: DocKind;
  active: boolean;
  stale: boolean;
  detached: boolean;
  actions: CommentActions;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const quote = anchorQuote(comment.anchor);

  useEffect(() => {
    if (active) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <div
      ref={card}
      role="button"
      tabIndex={0}
      onClick={() => actions.onSelect(comment.id)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          actions.onSelect(comment.id);
        }
      }}
      className={cn(
        "group rounded-lg border bg-card p-2.5 text-sm outline-none transition-colors",
        active ? "border-primary/60 ring-1 ring-primary/30" : "border-border hover:border-foreground/20",
        comment.status === "resolved" && !active && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold",
            comment.status === "resolved"
              ? "bg-muted text-muted-foreground"
              : "bg-primary text-primary-foreground",
          )}
        >
          {comment.seq}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {anchorLabel(comment.anchor, kind)} · {STATUS_LABEL[comment.status]}
        </span>
        <div className="flex shrink-0 items-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          {comment.status !== "resolved" ? (
            <IconButton icon="Edit" label="Edit comment" onClick={() => setEditing(true)} />
          ) : null}
          {comment.status !== "draft" ? (
            <IconButton
              icon="RotateCcw"
              label="Back to draft"
              onClick={() => actions.onReopen(comment)}
            />
          ) : null}
          <IconButton icon="Trash2" label="Delete comment" onClick={() => actions.onDelete(comment)} />
        </div>
      </div>
      {quote ? (
        <div className="mt-1.5 line-clamp-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
          {truncate(quote, 240)}
        </div>
      ) : null}
      {editing ? (
        <CommentEditor
          className="mt-2 shadow-none"
          initial={comment.body}
          submitLabel="Save"
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => {
            setBusy(true);
            actions
              .onEdit(comment, body)
              .then(() => setEditing(false))
              .finally(() => setBusy(false));
          }}
        />
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap break-words">{comment.body}</p>
      )}
      {comment.agentNote ? (
        <div
          className={cn(
            "mt-2 rounded-md px-2 py-1.5 text-xs",
            comment.status === "replied" ? "bg-primary/10 text-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          <span className="font-medium">Agent:</span> {comment.agentNote}
        </div>
      ) : null}
      {(stale || detached) && comment.status !== "resolved" ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          {detached ? "The quoted text is no longer in the file." : "The file changed after this comment."}
        </div>
      ) : null}
    </div>
  );
}

export function CommentList({
  comments,
  kind,
  docVersion,
  activeId,
  detachedIds,
  actions,
  header,
}: {
  comments: ReviewComment[];
  kind: DocKind;
  docVersion: string;
  activeId: string | null;
  detachedIds: ReadonlySet<string>;
  actions: CommentActions;
  header?: ReactNode;
}) {
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);

  return (
    <div className="flex flex-col gap-3 p-3">
      {header}
      {composing ? (
        <CommentEditor
          label="Whole document"
          busy={busy}
          onCancel={() => setComposing(false)}
          onSubmit={(body) => {
            setBusy(true);
            actions
              .onAddGeneral(body)
              .then(() => setComposing(false))
              .finally(() => setBusy(false));
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={() => setComposing(true)}
        >
          <Icon name="MessageSquarePlus" className="size-4" />
          Comment on the whole document
        </Button>
      )}
      {comments.length === 0 ? (
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          Select text to comment on it.
          {kind === "md" ? "" : " Switch to Area to draw a box around a picture or chart."}
          {" "}Comments stay here as drafts until you send them to a chat.
        </p>
      ) : null}
      {SECTIONS.map((section) => {
        const items = comments.filter((comment) => comment.status === section.status);
        if (items.length === 0) return null;
        const collapsed = section.status === "resolved" && !showDone;
        return (
          <section key={section.status} className="flex flex-col gap-2">
            <button
              type="button"
              className="flex items-center gap-1.5 px-1 text-left text-xs font-medium text-muted-foreground"
              onClick={() => section.status === "resolved" && setShowDone((value) => !value)}
            >
              {section.status === "resolved" ? (
                <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
              ) : null}
              {section.title} · {items.length}
            </button>
            {section.hint && !collapsed ? (
              <p className="-mt-1 px-1 text-[11px] text-muted-foreground">{section.hint}</p>
            ) : null}
            {collapsed
              ? null
              : items.map((comment) => (
                  <CommentCard
                    key={comment.id}
                    comment={comment}
                    kind={kind}
                    active={comment.id === activeId}
                    stale={comment.docVersion !== null && comment.docVersion !== docVersion}
                    detached={detachedIds.has(comment.id)}
                    actions={actions}
                  />
                ))}
          </section>
        );
      })}
    </div>
  );
}
