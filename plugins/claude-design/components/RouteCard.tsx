// "Use Claude without a VPN": the one-time Mac setup that sends Claude's
// domains through this server (see lib/route.ts), with copy buttons.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { messageOf, type Rpc } from "@/lib/store";

interface RouteInfo {
  target: string | null;
  installCommand: string | null;
  uninstallCommand: string;
  domains: string[];
  lastPacFetchAt: number | null;
}

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2"
          onClick={() =>
            navigator.clipboard.writeText(command).then(
              () => toast.success("Copied. Paste it into Terminal on the Mac."),
              () => toast.error("The clipboard refused the command"),
            )
          }
        >
          <Icon name="Copy" className="size-3.5" />
          Copy
        </Button>
      </div>
      <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {command}
      </pre>
    </div>
  );
}

export function RouteCard({ rpc }: { rpc: Rpc }) {
  const [info, setInfo] = useState<RouteInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    rpc.call("route_info").then(
      (next) => {
        setInfo(next);
        setTarget((current) => current || next.target || "");
      },
      (cause: unknown) => toast.error("Could not load the no-VPN setup", { description: messageOf(cause) }),
    );
  }, [rpc]);
  useEffect(load, [load]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      await rpc.call("route_set_target", { target: target.trim() });
      load();
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const active = info?.lastPacFetchAt ? Date.now() - info.lastPacFetchAt < 24 * 3600 * 1000 : false;

  return (
    <section className="rounded-lg border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium">Use Claude Design without a VPN</span>
        <span className="text-xs text-muted-foreground">
          {info?.lastPacFetchAt
            ? `${active ? "Working" : "Last used"} · Mac seen ${ago(info.lastPacFetchAt)}`
            : "Not set up"}
        </span>
      </button>
      {open && info ? (
        <div className="space-y-3 border-t border-border px-4 pb-4 pt-3 text-sm">
          <p className="text-muted-foreground">
            bb's browser runs on your Mac, so claude.ai sees the Mac's address and can refuse
            your country. This setup sends only Claude's domains ({info.domains.join(", ")})
            through this server over SSH, so claude.ai sees the server's address. Everything
            else stays direct. It starts with the Mac and reconnects on its own.
          </p>
          <form onSubmit={save} className="flex items-center gap-2">
            <Input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="SSH login from the Mac, like coder@203.0.113.7"
              aria-label="SSH login to this server"
            />
            <Button type="submit" variant="outline" disabled={saving || target.trim() === (info.target ?? "")}>
              Save
            </Button>
          </form>
          {info.installCommand ? (
            <>
              <CommandBlock label="1. Set up (Terminal on the Mac, asks for the Mac password once)" command={info.installCommand} />
              <p className="text-xs text-muted-foreground">
                2. Quit and reopen bb, then open Claude Design. The Mac needs a working SSH key for this
                login (the same one you use to connect to the server). A network that already uses its
                own proxy settings is skipped and listed in the output.
              </p>
              <CommandBlock label="Undo" command={info.uninstallCommand} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Enter the SSH login first; the setup command appears here.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
