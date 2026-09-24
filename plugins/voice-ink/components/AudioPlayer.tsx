// A play button, a scrub bar and the two timestamps — the browser's own
// controls in bb's colours.
//
// The native <audio controls> widget is drawn by the browser and ignores the
// theme, which makes it the one light-grey slab on a dark panel. The element
// is still here, just headless: it does the decoding and seeking.
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** `m:ss`, the length people read on a voice message. */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function AudioPlayer({
  src,
  fallbackDurationSec,
}: {
  src: string;
  /** Used until the browser has read the real length out of the file. */
  fallbackDurationSec: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(fallbackDurationSec ?? 0);
  const [failed, setFailed] = useState(false);

  // A new recording in the same slot must not keep the old one's progress.
  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(fallbackDurationSec ?? 0);
    setFailed(false);
  }, [fallbackDurationSec, src]);

  const toggle = useCallback(() => {
    const element = audioRef.current;
    if (element === null) return;
    if (element.paused) {
      void element.play().catch(() => setFailed(true));
    } else {
      element.pause();
    }
  }, []);

  const seek = useCallback((seconds: number) => {
    const element = audioRef.current;
    if (element === null) return;
    element.currentTime = seconds;
    setPosition(seconds);
  }, []);

  if (failed) {
    return (
      <p className="text-xs text-muted-foreground">
        This recording could not be played — its audio file is gone.
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <audio
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onError={() => setFailed(true)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        preload="metadata"
        ref={audioRef}
        src={src}
      />
      <button
        aria-label={playing ? "Pause" : "Play"}
        className={cn(
          "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full",
          // Solid, not a ghost button: it is the one control in the card that
          // does something to the recording rather than to the text.
          "bg-primary text-primary-foreground transition-opacity hover:opacity-90",
        )}
        onClick={toggle}
        type="button"
      >
        <Icon aria-hidden className="size-4" name={playing ? "Pause" : "Play"} />
      </button>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatClock(position)}
      </span>
      <input
        aria-label="Position in the recording"
        className="h-1 grow cursor-pointer appearance-none rounded-full bg-border accent-primary"
        max={Math.max(duration, 0.1)}
        min={0}
        onChange={(event) => seek(Number(event.target.value))}
        step={0.1}
        type="range"
        value={Math.min(position, duration || position)}
      />
      <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatClock(duration)}
      </span>
    </div>
  );
}
