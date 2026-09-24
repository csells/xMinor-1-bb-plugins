// Dictation as the button sees it: press to listen, press again to finish.
//
// Segments are recognized in parallel but committed in order, so the draft
// reads the way it was spoken even when a later segment comes back first.
import { useCallback, useRef, useState } from "react";
import { startDictation, toBase64, type DictationSession } from "@/lib/dictation";
import type { TranscriptionResult } from "@/contract";

export type DictationStatus = "idle" | "listening" | "finishing" | "error";

interface UseDictationOptions {
  transcribe(input: { audioBase64: string; mimeType: string }): Promise<TranscriptionResult>;
  /** Append recognized text to wherever it belongs. */
  onText(text: string): void;
  onError(message: string): void;
  /** Called once per session so the model can load while the user talks. */
  warmUp(): void;
}

/** A segment that has not come back by then is treated as lost, not awaited forever. */
const SEGMENT_TIMEOUT_MS = 180_000;

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        throw error;
      },
    );
  });
}

interface OrderedCommitter {
  next: number;
  ready: Map<number, string>;
}

export function useDictation(options: UseDictationOptions) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [level, setLevel] = useState(0);
  const [pending, setPending] = useState(0);
  const sessionRef = useRef<DictationSession | null>(null);
  const orderRef = useRef<OrderedCommitter>({ next: 0, ready: new Map() });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const commit = useCallback((index: number, text: string) => {
    const order = orderRef.current;
    order.ready.set(index, text);
    while (order.ready.has(order.next)) {
      const value = order.ready.get(order.next) ?? "";
      order.ready.delete(order.next);
      order.next += 1;
      if (value.trim() !== "") optionsRef.current.onText(value.trim());
    }
  }, []);

  const start = useCallback(async () => {
    if (sessionRef.current !== null) return;
    orderRef.current = { next: 0, ready: new Map() };
    setStatus("listening");
    setPending(0);
    optionsRef.current.warmUp();

    try {
      sessionRef.current = await startDictation({
        onLevel: setLevel,
        onError: (message) => optionsRef.current.onError(message),
        onSegment: ({ index, wav }) => {
          setPending((count) => count + 1);
          void withTimeout(
            optionsRef.current.transcribe({
              audioBase64: toBase64(wav),
              mimeType: "audio/wav",
            }),
            SEGMENT_TIMEOUT_MS,
            () => ({
              ok: false as const,
              code: "timeout",
              message: "Recognition took too long and was dropped",
            }),
          )
            .then((result) => {
              if (result.ok) {
                commit(index, result.text);
              } else {
                commit(index, "");
                optionsRef.current.onError(result.message);
              }
            })
            .catch((error: unknown) => {
              commit(index, "");
              optionsRef.current.onError(
                error instanceof Error ? error.message : String(error),
              );
            })
            .finally(() => {
              setPending((count) => Math.max(0, count - 1));
            });
        },
      });
    } catch (error) {
      sessionRef.current = null;
      setStatus("error");
      const message = error instanceof Error ? error.message : String(error);
      optionsRef.current.onError(
        message.includes("Permission denied") || message.includes("NotAllowedError")
          ? "Microphone permission denied"
          : message,
      );
    }
  }, [commit]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (session === null) return;
    sessionRef.current = null;
    setStatus("finishing");
    setLevel(0);
    await session.stop();
    setStatus("idle");
  }, []);

  const cancel = useCallback(async () => {
    const session = sessionRef.current;
    if (session === null) return;
    sessionRef.current = null;
    orderRef.current = { next: Number.MAX_SAFE_INTEGER, ready: new Map() };
    setLevel(0);
    setStatus("idle");
    await session.cancel();
  }, []);

  return { status, level, pending, start, stop, cancel };
}
