// The "Claude Design" sidebar page: the saved projects, their bb links, and
// the ways into them. The host draws the title bar; this is the body.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { BbProject, DesignProject, rpcContract } from "@/contract";
import {
  CHANGED_CHANNEL,
  CLAUDE_DESIGN_HOME,
  NAME_MAX,
  handoffPrompt,
  parseProjectRef,
} from "@/lib/links";
import { messageOf, refreshProjects, useProjects, type Rpc } from "@/lib/store";
import { cn } from "@/lib/utils";
import { RouteCard } from "./RouteCard";

/** The dashed box bb's own list pages use for loading and empty states. */
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
      role="status"
    >
      {children}
    </div>
  );
}

function useBbProjects(rpc: Rpc): BbProject[] | null {
  const [projects, setProjects] = useState<BbProject[] | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("bb_projects").then(
      (result) => {
        if (live) setProjects(result.projects);
      },
      () => {
        if (live) setProjects([]);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc]);
  return projects;
}

/** Runs a change, then shows the fresh list or says what went wrong. */
async function change(action: () => Promise<unknown>, failure: string) {
  try {
    await action();
    await refreshProjects();
  } catch (cause) {
    toast.error(failure, { description: messageOf(cause) });
  }
}

function AddForm({ rpc }: { rpc: Rpc }) {
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    if (parseProjectRef(link) === null) {
      setProblem(
        "That is not a Claude Design project link. Copy it from the address bar of an open project: https://claude.ai/design/p/…",
      );
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const project = await rpc.call("add", {
        ref: link,
        name: name.trim() === "" ? null : name,
        bbProjectId: null,
        makeDefault: false,
      });
      setLink("");
      setName("");
      await refreshProjects();
      toast.success(`Saved ${project.name}`);
    } catch (cause) {
      setProblem(messageOf(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      aria-label="Add a Claude Design project"
      className="space-y-2"
      onSubmit={(event) => void submit(event)}
    >
      <div className="flex flex-col gap-2 @lg:flex-row">
        <Input
          aria-label="Project link"
          className="@lg:flex-[3]"
          inputMode="url"
          onChange={(event) => setLink(event.target.value)}
          placeholder="https://claude.ai/design/p/…"
          value={link}
        />
        <Input
          aria-label="Project name"
          className="@lg:flex-[2]"
          maxLength={NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name (optional)"
          value={name}
        />
        <Button disabled={pending || link.trim() === ""} type="submit">
          <Icon name={pending ? "Loading" : "Plus"} />
          Add
        </Button>
      </div>
      {problem === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

function LinkPicker({
  project,
  bbProjects,
  rpc,
}: {
  project: DesignProject;
  bbProjects: BbProject[] | null;
  rpc: Rpc;
}) {
  const label =
    project.bbProjectId === null
      ? "Not linked to a bb project"
      : (project.bbProjectName ?? "Linked bb project was removed");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`bb project for ${project.name}: ${label}`}
          className="-mx-1 inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          type="button"
        >
          <Icon className="size-3.5 shrink-0" name="Folder" />
          <span className="truncate">{label}</span>
          <Icon className="size-3 shrink-0" name="ChevronDown" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 w-60 overflow-y-auto"
        mobileTitle="Link to a bb project"
      >
        <DropdownMenuLabel>Link to a bb project</DropdownMenuLabel>
        {bbProjects === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : bbProjects.length === 0 ? (
          <DropdownMenuItem disabled>No bb projects yet</DropdownMenuItem>
        ) : (
          bbProjects.map((bbProject) => (
            <DropdownMenuCheckboxItem
              checked={project.bbProjectId === bbProject.id}
              key={bbProject.id}
              onSelect={() => {
                if (project.bbProjectId === bbProject.id) return;
                void change(
                  () =>
                    rpc.call("link", {
                      id: project.id,
                      bbProjectId: bbProject.id,
                      makeDefault: false,
                    }),
                  "Could not link the project",
                );
              }}
            >
              <span className="truncate">{bbProject.name}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
        {project.bbProjectId === null ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                void change(
                  () => rpc.call("unlink", { id: project.id }),
                  "Could not unlink the project",
                )
              }
            >
              <Icon name="X" />
              Unlink
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowMenu({ project, rpc }: { project: DesignProject; rpc: Rpc }) {
  const remove = () =>
    void change(async () => {
      const { removed } = await rpc.call("remove", { id: project.id });
      toast(`Removed ${removed.name}`, {
        action: {
          label: "Undo",
          onClick: () =>
            void change(
              () =>
                rpc.call("add", {
                  ref: removed.id,
                  name: removed.name,
                  bbProjectId:
                    removed.bbProjectName === null ? null : removed.bbProjectId,
                  makeDefault: removed.isDefault,
                }),
              "Could not restore the project",
            ),
        },
      });
    }, "Could not remove the project");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`More actions for ${project.name}`}
          className="size-8 text-muted-foreground"
          size="icon"
          variant="ghost"
        >
          <Icon name="MoreHorizontal" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" mobileTitle={project.name}>
        {project.bbProjectId !== null &&
        project.bbProjectName !== null &&
        !project.isDefault ? (
          <DropdownMenuItem
            onSelect={() =>
              void change(
                () => rpc.call("set_default", { id: project.id }),
                "Could not change the default",
              )
            }
          >
            <Icon name="Check" />
            Make default for {project.bbProjectName}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(project.url).then(
              () => toast.success("Link copied"),
              () => toast.error("The clipboard refused the link"),
            );
          }}
        >
          <Icon name="Copy" />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={remove} variant="destructive">
          <Icon name="Trash2" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectRow({
  project,
  bbProjects,
  sharesBbProject,
  rpc,
}: {
  project: DesignProject;
  bbProjects: BbProject[] | null;
  /** Another saved project is linked to the same bb project. */
  sharesBbProject: boolean;
  rpc: Rpc;
}) {
  const navigate = useBbNavigate();
  return (
    <li className="flex flex-col gap-2 px-4 py-3 @2xl:flex-row @2xl:items-center @2xl:gap-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {project.name}
          </span>
          {sharesBbProject && project.isDefault ? (
            <span
              className="shrink-0 rounded-full bg-state-hover px-2 py-0.5 text-[11px] text-muted-foreground"
              title={`Opened and handed off from ${project.bbProjectName ?? "its bb project"}'s threads`}
            >
              default
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <LinkPicker bbProjects={bbProjects} project={project} rpc={rpc} />
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @md:inline">
            {project.id.slice(0, 8)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <UrlLink
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={project.url}
        >
          <Icon name="ArrowUpRight" />
          Open
        </UrlLink>
        <Button
          onClick={() =>
            navigate.toCompose({
              initialPrompt: handoffPrompt({ id: project.id, name: project.name }),
              focusPrompt: true,
            })
          }
          size="sm"
          variant="ghost"
        >
          <Icon name="Sent" />
          Hand comments to new chat
        </Button>
        <RowMenu project={project} rpc={rpc} />
      </div>
    </li>
  );
}

export function ProjectsPage(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { status, projects, error } = useProjects();
  const bbProjects = useBbProjects(rpc);

  // The overlay keeps the list current too; this covers a host without it.
  useRealtime(CHANGED_CHANNEL, () => {
    void refreshProjects();
  });

  const linkCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      if (project.bbProjectId === null) continue;
      counts.set(project.bbProjectId, (counts.get(project.bbProjectId) ?? 0) + 1);
    }
    return counts;
  }, [projects]);

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <div className="@container mx-auto w-full max-w-3xl space-y-4">
        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">
            Link a Claude Design project to a bb project, and that project's
            threads get a Claude Design button in the header and a “Claude
            Design comments” item in the composer's + menu.
          </p>
          <p className="text-xs text-muted-foreground">
            In the desktop app, links open in bb's browser beside the chat while
            Settings → General → Links → “Open links in the in-app browser” is
            on. Sign in to claude.ai there once, or import your browser's
            cookies in Settings → Browser.
          </p>
        </div>

        <RouteCard rpc={rpc} />

        <AddForm rpc={rpc} />

        {projects.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {projects.map((project) => (
              <ProjectRow
                bbProjects={bbProjects}
                key={project.id}
                project={project}
                rpc={rpc}
                sharesBbProject={
                  project.bbProjectId !== null &&
                  (linkCounts.get(project.bbProjectId) ?? 0) > 1
                }
              />
            ))}
          </ul>
        ) : status === "loading" ? (
          <EmptyState>Loading projects…</EmptyState>
        ) : status === "error" ? (
          <EmptyState>
            Could not load the projects: {error}{" "}
            <button
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => void refreshProjects()}
              type="button"
            >
              Try again
            </button>
          </EmptyState>
        ) : (
          <EmptyState>
            No Claude Design projects yet. Paste a project link above, or ask an
            agent to run <code>bb claude-design add &lt;link&gt;</code>.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

/** The title bar's right side: Claude Design's home, in bb's browser. */
export function ProjectsHeader(_props: PluginNavPanelProps) {
  return (
    <UrlLink
      className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-7")}
      href={CLAUDE_DESIGN_HOME}
    >
      <Icon name="ArrowUpRight" />
      Open Claude Design
    </UrlLink>
  );
}
