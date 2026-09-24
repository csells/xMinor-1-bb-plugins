// The thread header button: opens the Claude Design project linked to the
// thread's bb project in the thread's own browser panel. Threads of projects
// with no linked Claude Design project show nothing here.
import { useEffect } from "react";
import {
  useBbNavigate,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { ClaudeDesignMark } from "@/components/ClaudeDesignMark";
import { linkedProject, registerThreadSurface, useProjects } from "@/lib/store";

export const chromeButtonClass =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export function HeaderAction({
  threadId,
  projectId,
}: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const { projects } = useProjects();

  // The panel launcher row and the palette command have no navigator of their
  // own; this one opens links in this thread's browser panel.
  useEffect(
    () =>
      registerThreadSurface(threadId, {
        projectId,
        openUrl: (url) => navigate.openUrl(url),
      }),
    [navigate, projectId, threadId],
  );

  const project = linkedProject(projects, projectId);
  if (project === null) return null;
  const label = `Open ${project.name} in Claude Design`;
  return (
    <button
      aria-label={label}
      className={`${chromeButtonClass} w-7`}
      onClick={() => navigate.openUrl(project.url)}
      title={label}
      type="button"
    >
      <ClaudeDesignMark className="size-4" />
    </button>
  );
}
