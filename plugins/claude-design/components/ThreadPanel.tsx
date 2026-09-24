// The panel tab behind the "Claude Design" row of a thread's panel launcher,
// used when the row cannot open the project straight away (the thread's
// header is not mounted). It offers the same links as the other entry points.
import {
  useBbNavigate,
  useComposer,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  CLAUDE_DESIGN_HOME,
  PANEL_PATH,
  appendToDraft,
  handoffPrompt,
} from "@/lib/links";
import { linkedProject, useProjects } from "@/lib/store";
import { useDesignContext } from "@/lib/use-design-context";

export function ThreadPanel({ threadId }: PluginThreadPanelProps) {
  const navigate = useBbNavigate();
  const composer = useComposer();
  const { projects } = useProjects();
  const context = useDesignContext(threadId);

  if (context.status === "loading" || context.status === "idle") {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  const bbProject = context.data?.bbProject ?? null;
  const project = linkedProject(projects, bbProject?.id ?? null);

  if (project === null) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          {bbProject === null || !context.data?.linkable
            ? "This thread is not in a bb project, so no Claude Design project is linked to it."
            : `No Claude Design project is linked to ${bbProject.name}.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => navigate.openUrl(CLAUDE_DESIGN_HOME)}
            size="sm"
            variant="outline"
          >
            <Icon name="ArrowUpRight" />
            Open Claude Design
          </Button>
          <Button
            onClick={() => navigate.toPluginPanel(PANEL_PATH)}
            size="sm"
            variant="ghost"
          >
            Link a project
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="font-medium">{project.name}</div>
        <div className="text-xs text-muted-foreground">
          Linked to {bbProject?.name ?? project.bbProjectName}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => navigate.openUrl(project.url)} size="sm">
          <Icon name="ArrowUpRight" />
          Open in a browser tab
        </Button>
        <Button
          onClick={() => {
            composer.updateText((current) =>
              appendToDraft(
                current,
                handoffPrompt({ id: project.id, name: project.name }),
              ),
            );
            composer.focus();
          }}
          size="sm"
          variant="outline"
        >
          <Icon name="Sent" />
          Hand queued comments to this chat
        </Button>
      </div>
    </div>
  );
}
