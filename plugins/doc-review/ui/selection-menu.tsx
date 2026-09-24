// The right-click menu shown over a text selection in a review view, and the
// keyboard shortcut that comments on the current selection.
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const COMMENT_SHORTCUT = IS_MAC ? "⌘⌥M" : "Ctrl+Alt+M";

/** Cmd+Option+M (Ctrl+Alt+M elsewhere), matched by physical key so any layout works. */
export function isCommentShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyM";
}

export function SelectionMenu({
  top,
  left,
  quote,
  onComment,
  onClose,
}: {
  top: number;
  left: number;
  quote: string;
  onComment: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  const item =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";
  return (
    <div
      ref={box}
      role="menu"
      className="absolute z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ top, left }}
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onClose();
          onComment();
        }}
      >
        <Icon name="MessageSquarePlus" className="size-4" />
        <span className="flex-1">Comment</span>
        <span className="text-xs text-muted-foreground">{COMMENT_SHORTCUT}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onClose();
          navigator.clipboard.writeText(quote).then(
            () => undefined,
            () => toast.error("The clipboard refused the text"),
          );
        }}
      >
        <Icon name="Copy" className="size-4" />
        <span className="flex-1">Copy</span>
      </button>
    </div>
  );
}
