// components/dialogs/ExtractDialog.tsx — start a background extraction.
//
// `extractArchive` returns immediately with a `running` job; progress arrives
// on the `job` realtime channel and is rendered by the ActivityTray. The
// available formats come from `getState().archiveSupport`, so a host without
// `unzip` disables the zip path instead of failing halfway through.
import { useEffect, useState } from "react";

import type { ArchiveFormat, FileEntry } from "../../contract";
import { dirname, splitFileName } from "../../lib/fm-paths";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Icon } from "../ui/icon";
import { FolderPickerDialog } from "./FolderPickerDialog";

export interface ArchiveSupport {
  zip: boolean;
  tar: boolean;
  sevenZip: boolean;
  /** 7z with the RAR codec: every 7z lists a RAR, not every 7z unpacks one. */
  rar: boolean;
}

export interface ExtractSubmission {
  entry: FileEntry;
  destinationDir: string;
  createSubfolder: boolean;
}

export interface ExtractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: FileEntry | null;
  root: string;
  showHidden: boolean;
  archiveSupport: ArchiveSupport;
  onSubmit: (submission: ExtractSubmission) => Promise<void>;
}

/** Which extractor a format needs, so an unsupported host can say so up front. */
export function isFormatSupported(format: ArchiveFormat, support: ArchiveSupport): boolean {
  if (format === "zip") return support.zip || support.sevenZip;
  if (format === "7z") return support.sevenZip;
  if (format === "rar") return support.rar;
  return support.tar;
}

export function ExtractDialog({
  open,
  onOpenChange,
  entry,
  root,
  showHidden,
  archiveSupport,
  onSubmit,
}: ExtractDialogProps) {
  const [destination, setDestination] = useState(root);
  const [createSubfolder, setCreateSubfolder] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || entry === null) return;
    setDestination(dirname(entry.path));
    setCreateSubfolder(true);
    setBusy(false);
    setError(null);
  }, [open, entry]);

  if (entry === null) return null;

  const format = entry.archiveFormat;
  const supported = format !== null && isFormatSupported(format, archiveSupport);
  const subfolderName = splitFileName(entry.name).stem;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-md bg-card text-card-foreground"
          data-testid="fm-extract-dialog"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="ArchiveRestore" className="size-4" aria-hidden="true" />
              Extract archive
            </DialogTitle>
            <DialogDescription className="truncate">{entry.name}</DialogDescription>
          </DialogHeader>

          {supported ? null : (
            <p className="rounded-md bg-surface-attention px-2 py-1.5 text-xs text-warning-text">
              {format === null
                ? "This file is not a recognized archive."
                : `No extractor for ${format} is installed on this host.`}
            </p>
          )}

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Extract to</p>
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-recessed px-2 py-1.5 text-xs"
                title={destination}
              >
                {destination}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                Change…
              </Button>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={createSubfolder}
              onCheckedChange={(checked) => setCreateSubfolder(checked === true)}
              aria-label="Extract into a sub-folder"
            />
            <span>
              Extract into <span className="font-medium">{subfolderName}/</span>
            </span>
          </label>

          {error === null ? null : (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={busy || !supported}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  try {
                    await onSubmit({ entry, destinationDir: destination, createSubfolder });
                    onOpenChange(false);
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : String(failure));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Extract
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Extract to…"
        initialPath={destination}
        root={root}
        showHidden={showHidden}
        onChoose={setDestination}
      />
    </>
  );
}
