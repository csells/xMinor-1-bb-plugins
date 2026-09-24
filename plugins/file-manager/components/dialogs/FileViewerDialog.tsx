// components/dialogs/FileViewerDialog.tsx — the built-in viewer (§8.12).
//
// bb's shared preview panel is the nicer surface and stays the first choice,
// but it does not exist everywhere: `experimental_openFilePreview` is wired up
// by the thread split view and by the right-hand panel host, and by nothing
// else. In the sidebar's own full-page File Manager the host answers `false`
// for every file, every time — so a manager that only knew how to delegate
// could not open a file on the surface it is most often used from. This is
// what it does instead.
//
// Two transports, split along what the renderer needs:
//
//   * a URL, for the kinds a browser paints itself — images, PDFs, audio and
//     video ride `createPreviewUrl`, the same folder-rooted transport the
//     gallery hangs its thumbnails off (§8.9), and their bytes never enter JS.
//   * a string, for everything else — `readTextFile` reads at most
//     `MAX_TEXT_PREVIEW_BYTES` and refuses anything that is not UTF-8, which
//     is what turns "unknown extension" into either a source view or an
//     honest "no preview", never a wall of mojibake.
//
// Markdown renders through bb's own `Markdown`, and every other text through
// bb's `experimental_SourceCode`, so a file looks here exactly like it looks
// in a thread — same theme, same highlighting, one implementation.
//
// An archive is the third case (§8.13): neither a URL nor a string, but its
// table of contents, drawn by components/ArchiveContents.tsx from
// `listArchive`. Its "Extract…" hands the entry back to the panel, which
// swaps this dialog for its own ExtractDialog.
import { useEffect, useState } from "react";
import { Markdown, experimental_SourceCode as SourceCode } from "@get-bb/plugin-sdk/app";

import type { FileEntry } from "../../contract";
import { downloadEntry } from "../../lib/download";
import { parseRpcError } from "../../lib/errors";
import { dirname } from "../../lib/fm-paths";
import { formatBytes } from "../../lib/format";
import { useFmRpc, type RpcOutput } from "../../lib/fm-rpc";
import { previewUrl } from "../../lib/preview";
import { isTextViewerKind, isUrlViewerKind, viewerKindForEntry } from "../../lib/viewer";
import { usePreviewBase } from "../../hooks/usePreviewBase";
import { ArchiveContents } from "../ArchiveContents";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Icon } from "../ui/icon";

type TextState =
  | { status: "loading" }
  | { status: "ready"; result: RpcOutput<"readTextFile"> }
  | { status: "unsupported" }
  | { status: "failed"; message: string };

export interface FileViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The file to show; always a real file inside the root (lib/viewer.ts). */
  entry: FileEntry;
  /**
   * An archive's "Extract…" (§8.13). The panel passes its own extraction
   * flow; without it the archive is shown with no way to extract from here.
   */
  onExtract?: ((entry: FileEntry) => void) | undefined;
}

/** The middle of the dialog when there is nothing to render. */
function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <div className="max-w-md space-y-2">{children}</div>
    </div>
  );
}

/**
 * Text, once it has arrived. Markdown gets bb's document renderer with the
 * source one click away — a README is written to be read, but a file manager
 * is also where people come to check what a file literally says.
 */
function TextBody({
  entry,
  result,
  rendered,
}: {
  entry: FileEntry;
  result: RpcOutput<"readTextFile">;
  rendered: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="fm-viewer-text">
      {rendered ? (
        <Markdown content={result.text} className="p-4" />
      ) : (
        <SourceCode content={result.text} path={entry.name} className="min-h-0 flex-1" />
      )}
    </div>
  );
}

export function FileViewerDialog({ open, onOpenChange, entry, onExtract }: FileViewerDialogProps) {
  const rpc = useFmRpc();
  const kind = viewerKindForEntry(entry);
  const wantsUrl = isUrlViewerKind(kind);
  const wantsText = isTextViewerKind(kind);

  // One base URL per folder, exactly like the gallery's — and only for the
  // kinds that are shown from a URL, so opening a text file costs no mint.
  const baseUrl = usePreviewBase({ path: dirname(entry.path), enabled: open && wantsUrl });
  const url = baseUrl === null ? null : previewUrl(baseUrl, entry.name);

  const [text, setText] = useState<TextState>({ status: "loading" });
  /** Markdown starts rendered; the toggle is per open, not a preference. */
  const [rendered, setRendered] = useState(true);
  /** A broken <img>/<video> falls back to the same "no preview" body. */
  const [mediaFailed, setMediaFailed] = useState(false);

  useEffect(() => {
    setRendered(true);
    setMediaFailed(false);
  }, [entry.path]);

  useEffect(() => {
    if (!open || !wantsText) return;
    let cancelled = false;
    setText({ status: "loading" });
    void (async () => {
      try {
        const result = await rpc.call("readTextFile", { path: entry.path });
        if (!cancelled) setText({ status: "ready", result });
      } catch (failure) {
        if (cancelled) return;
        const parsed = parseRpcError(failure);
        // `unsupported` is the server saying "these bytes are not text", which
        // is an answer and not a fault — it renders as the download offer
        // rather than as an error.
        setText(
          parsed.code === "unsupported"
            ? { status: "unsupported" }
            : { status: "failed", message: parsed.rawMessage },
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.path, open, rpc, wantsText]);

  const download = (): void => {
    downloadEntry(entry);
  };

  let body: React.ReactNode;
  if (kind === "archive") {
    body = (
      <ArchiveContents
        path={entry.path}
        onExtract={onExtract === undefined ? undefined : () => onExtract(entry)}
      />
    );
  } else if (wantsUrl && mediaFailed) {
    body = (
      <Placeholder>
        <p className="font-medium text-foreground">This file could not be displayed</p>
        <p>The browser refused to play or paint it. Downloading it still works.</p>
      </Placeholder>
    );
  } else if (wantsUrl && url === null) {
    body = <Placeholder>Loading…</Placeholder>;
  } else if (kind === "image" && url !== null) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={url}
          alt={entry.name}
          data-testid="fm-viewer-image"
          className="max-h-full max-w-full object-contain"
          onError={() => setMediaFailed(true)}
        />
      </div>
    );
  } else if (kind === "pdf" && url !== null) {
    // A PDF is the one kind bb's transport serves that the browser renders in
    // a frame of its own, complete with its own page controls.
    body = (
      <iframe
        src={url}
        title={entry.name}
        data-testid="fm-viewer-pdf"
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    );
  } else if (kind === "video" && url !== null) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a file on
            disk carries no track we could offer. */}
        <video
          src={url}
          controls
          data-testid="fm-viewer-video"
          className="max-h-full max-w-full"
          onError={() => setMediaFailed(true)}
        />
      </div>
    );
  } else if (kind === "audio" && url !== null) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- as above. */}
        <audio
          src={url}
          controls
          data-testid="fm-viewer-audio"
          className="w-full max-w-lg"
          onError={() => setMediaFailed(true)}
        />
      </div>
    );
  } else if (text.status === "loading") {
    body = <Placeholder>Reading…</Placeholder>;
  } else if (text.status === "unsupported") {
    body = (
      <Placeholder>
        <p className="font-medium text-foreground">No preview for this kind of file</p>
        <p>It is not text, and not an image, PDF or media file a browser can show.</p>
      </Placeholder>
    );
  } else if (text.status === "failed") {
    body = (
      <Placeholder>
        <p className="font-medium text-foreground">Could not read this file</p>
        <p>{text.message}</p>
      </Placeholder>
    );
  } else {
    body = <TextBody entry={entry} result={text.result} rendered={kind === "markdown" && rendered} />;
  }

  const truncated = text.status === "ready" && text.result.truncated;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="fm-viewer"
        // Wide and tall on purpose: this is the surface that replaces bb's
        // preview panel, and a file read through a letterbox is not read.
        className="flex h-[85vh] max-h-[85vh] w-[min(72rem,95vw)] max-w-[min(72rem,95vw)] flex-col gap-0 overflow-hidden p-0"
      >
        {/* One flex row rather than an absolutely placed cluster: on a compact
            viewport `DialogContent` renders a drawer instead of a centred
            panel, and an `absolute` corner would have nothing dependable to
            anchor to there. `pr-10` is the gap the host's own close button
            sits in. */}
        <DialogHeader className="shrink-0 gap-0 border-b border-border px-4 py-3 pr-10">
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogTitle className="truncate" title={entry.path}>
                {entry.name}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-x-2">
                <span>{formatBytes(entry.sizeBytes)}</span>
                {truncated ? (
                  <span data-testid="fm-viewer-truncated">
                    · showing the first{" "}
                    {formatBytes(text.status === "ready" ? text.result.readBytes : 0)}
                  </span>
                ) : null}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {kind === "markdown" && text.status === "ready" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 px-2 text-xs"
                  data-testid="fm-viewer-toggle-source"
                  onClick={() => setRendered((value) => !value)}
                >
                  <Icon name={rendered ? "Code" : "AlignLeft"} className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{rendered ? "Source" : "Rendered"}</span>
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs"
                data-testid="fm-viewer-download"
                onClick={download}
              >
                <Icon name="Download" className="size-4" aria-hidden />
                <span className="hidden sm:inline">Download</span>
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      </DialogContent>
    </Dialog>
  );
}
