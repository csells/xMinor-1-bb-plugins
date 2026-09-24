// The floating control over the page view: which page is on screen, a field
// to jump to another, and zoom out, fit, and zoom in.
import { useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { MAX_ZOOM, MIN_ZOOM } from "./page-layout";

function BarButton({
  label,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function ZoomBar({
  zoom,
  page,
  count,
  noun,
  onStep,
  onFit,
  onJump,
}: {
  zoom: number;
  page: number;
  count: number;
  noun: string;
  onStep: (direction: 1 | -1) => void;
  onFit: () => void;
  onJump: (page: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = Number(new FormData(event.currentTarget).get("page"));
    if (Number.isInteger(value) && value >= 1 && value <= count) onJump(value);
    setEditing(false);
  };
  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border bg-background/95 p-0.5 text-xs shadow-md backdrop-blur">
      {count > 1 ? (
        editing ? (
          <form onSubmit={submit} className="flex items-center gap-1 px-1">
            <input
              name="page"
              type="number"
              inputMode="numeric"
              min={1}
              max={count}
              defaultValue={page}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => event.key === "Escape" && setEditing(false)}
              aria-label={`${noun} number`}
              className="h-7 w-16 rounded-md border border-input bg-background px-1.5 text-base tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:text-xs"
            />
            <span className="text-muted-foreground">/ {count}</span>
          </form>
        ) : (
          <BarButton label={`Go to a ${noun.toLowerCase()}`} onClick={() => setEditing(true)} className="px-2">
            {page} / {count}
          </BarButton>
        )
      ) : null}
      {count > 1 ? <span className="mx-0.5 h-4 w-px bg-border" aria-hidden /> : null}
      <BarButton label="Zoom out" disabled={zoom <= MIN_ZOOM + 1e-3} onClick={() => onStep(-1)}>
        <Icon name="ZoomOut" className="size-4" />
      </BarButton>
      <BarButton label="Fit the width" onClick={onFit} className="min-w-12">
        {Math.round(zoom * 100)}%
      </BarButton>
      <BarButton label="Zoom in" disabled={zoom >= MAX_ZOOM - 1e-3} onClick={() => onStep(1)}>
        <Icon name="ZoomIn" className="size-4" />
      </BarButton>
    </div>
  );
}
