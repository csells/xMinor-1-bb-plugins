import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { NeedsLibreOffice as NeedsLibreOfficeResult } from "@/src/contract";

/**
 * Install commands for the machine bb runs on — which is not necessarily the
 * one this browser runs on, hence the server reports its platform.
 */
function installCommands(
  result: NeedsLibreOfficeResult,
): { label: string; command: string }[] {
  const module = result.component === "impress" ? "impress" : "writer";
  switch (result.platform) {
    case "darwin":
      return [{ label: "macOS", command: "brew install --cask libreoffice" }];
    case "win32":
      return [
        {
          label: "Windows",
          command: "winget install TheDocumentFoundation.LibreOffice",
        },
      ];
    case "linux":
      return [
        {
          label: "Debian, Ubuntu",
          command: `sudo apt install libreoffice-${module}`,
        },
        { label: "Fedora", command: `sudo dnf install libreoffice-${module}` },
      ];
    default:
      return [];
  }
}

function CommandLine({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1 text-left">
      <p className="text-xs">{label}</p>
      <div className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1">
        <code className="min-w-0 flex-1 select-all truncate font-mono text-xs text-foreground">
          {command}
        </code>
        <Button
          size="sm"
          variant="ghost"
          aria-label={copied ? "Copied" : "Copy command"}
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <Icon name={copied ? "Check" : "Copy"} aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function NeedsLibreOffice({
  result,
  name,
  downloadUrl,
  onReload,
}: {
  result: NeedsLibreOfficeResult;
  name: string;
  /** The original file, when a link could be minted. */
  downloadUrl: string | null;
  onReload: () => void;
}) {
  const kind = result.component === "impress" ? "PowerPoint" : "Word";
  const module = result.component === "impress" ? "Impress" : "Writer";
  const commands = installCommands(result);
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto p-6 text-sm text-muted-foreground">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-2 text-center">
          <Icon name="FileQuestion" className="mx-auto size-6" aria-hidden />
          <p className="font-medium text-foreground">
            LibreOffice is needed to show this file
          </p>
          <p>
            {kind} files are shown as PDF, converted by LibreOffice on the
            machine bb runs on.{" "}
            {result.installed
              ? `LibreOffice is installed there, but without its ${module} module.`
              : "LibreOffice was not found there."}
          </p>
        </div>
        {commands.map((entry) => (
          <CommandLine key={entry.label} {...entry} />
        ))}
        <p className="text-center text-xs">
          Installed somewhere unusual? Set the path to soffice in this
          plugin&apos;s settings.
        </p>
        <div className="flex justify-center gap-2">
          <Button size="sm" variant="outline" onClick={onReload}>
            <Icon name="RotateCcw" aria-hidden />
            Try again
          </Button>
          {downloadUrl ? (
            <Button size="sm" variant="ghost" asChild>
              <a href={downloadUrl} download={name}>
                <Icon name="Download" aria-hidden />
                Download
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
