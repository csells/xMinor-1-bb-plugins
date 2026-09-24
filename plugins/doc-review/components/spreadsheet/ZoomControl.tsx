import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ZOOM_LEVELS, stepZoom } from "@/lib/sheet-layout";

const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

/** Zoom out, the current level (click to reset to 100 %), zoom in. */
export function ZoomControl({
  zoom,
  onZoom,
  disabled,
}: {
  zoom: number;
  onZoom: (zoom: number) => void;
  disabled: boolean;
}) {
  const percent = Math.round(zoom * 100);
  const iconButton = "h-6 w-6 text-muted-foreground [&_svg]:size-3.5";
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={iconButton}
        disabled={disabled || zoom <= MIN_ZOOM}
        onClick={() => onZoom(stepZoom(zoom, -1))}
        aria-label="Zoom out"
      >
        <Icon name="ZoomOut" aria-hidden />
      </Button>
      <button
        type="button"
        className="h-6 w-11 cursor-pointer rounded-md text-center text-xs tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
        disabled={disabled}
        onClick={() => onZoom(1)}
        aria-label={`Zoom ${percent}%. Reset to 100%`}
        title="Reset to 100%"
      >
        {percent}%
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={iconButton}
        disabled={disabled || zoom >= MAX_ZOOM}
        onClick={() => onZoom(stepZoom(zoom, 1))}
        aria-label="Zoom in"
      >
        <Icon name="ZoomIn" aria-hidden />
      </Button>
    </div>
  );
}
