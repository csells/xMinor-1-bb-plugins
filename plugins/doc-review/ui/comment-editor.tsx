// The small card used to write or edit a comment.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CommentEditor({
  initial = "",
  label,
  submitLabel = "Comment",
  busy = false,
  className,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  /** Short context line above the field, e.g. "Lines 12–14". */
  label?: string;
  submitLabel?: string;
  busy?: boolean;
  className?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    // On a phone the keyboard shrinks the view; keep the field above it.
    const reveal = () => element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", reveal);
    const timer = window.setTimeout(reveal, 50);
    return () => {
      viewport?.removeEventListener("resize", reveal);
      window.clearTimeout(timer);
    };
  }, []);

  // Grow with the text up to a comfortable height.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [body]);

  const trimmed = body.trim();
  const submit = () => {
    if (trimmed && !busy) onSubmit(trimmed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg",
        className,
      )}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
    >
      {label ? <div className="px-1 pb-1 text-xs text-muted-foreground">{label}</div> : null}
      <textarea
        ref={field}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder="What should change here?"
        aria-label="Comment"
        className="block w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-base outline-none md:text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="hidden text-xs text-muted-foreground sm:inline">⌘↵ to save</span>
        <div className="ml-auto flex gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!trimmed || busy} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
