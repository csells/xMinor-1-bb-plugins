// What the host-rendered entry points do: the composer's + menu row, the
// thread panel launcher row and the command palette command. They run outside
// React, so they reach the server and the navigator through lib/store.
import type {
  ComposerView,
  PluginComposerApi,
  PluginComposerScope,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { DesignContext } from "../contract";
import {
  CLAUDE_DESIGN_HOME,
  PANEL_PATH,
  appendToDraft,
  handoffPrompt,
} from "./links";
import {
  currentNavigate,
  currentRpc,
  linkedProject,
  projectsNow,
  refreshProjects,
  threadSurface,
} from "./store";

async function linkedUrl(bbProjectId: string): Promise<string> {
  if (projectsNow().status !== "ready") await refreshProjects();
  return linkedProject(projectsNow().projects, bbProjectId)?.url ?? CLAUDE_DESIGN_HOME;
}

/**
 * Opens the Claude Design project linked to a thread's bb project (Claude
 * Design's home when none is) through that thread's own header, so the link
 * lands in the thread's browser panel. Without a mounted header it asks the
 * caller to open the plugin's panel tab instead, which offers the same links.
 */
export async function openForThread(input: {
  threadId: string;
  projectId: string | null;
  openPanel: () => boolean;
}): Promise<void> {
  const surface = threadSurface(input.threadId);
  if (surface === null) {
    if (input.openPanel()) return;
    const bbProjectId = input.projectId;
    const url =
      bbProjectId === null ? CLAUDE_DESIGN_HOME : await linkedUrl(bbProjectId);
    currentNavigate()?.openUrl(url);
    return;
  }
  const bbProjectId = input.projectId ?? surface.projectId;
  const project = linkedProject(projectsNow().projects, bbProjectId);
  // Synchronous when the list is loaded: a phone browser only opens a tab
  // from the click itself.
  surface.openUrl(project?.url ?? (await linkedUrl(bbProjectId)));
}

function scopeTarget(scope: PluginComposerScope): {
  threadId: string | null;
  projectId: string | null;
} {
  switch (scope.kind) {
    case "thread":
    case "queued-message":
      return { threadId: scope.threadId, projectId: null };
    case "side-chat":
    case "new-thread":
      return { threadId: null, projectId: scope.projectId };
  }
}

/**
 * The composer's "Claude Design comments" row: puts the hand-off prompt for
 * the linked project in the draft. With no linked project the prompt asks the
 * agent to find it and ask, and a toast points at the page that links one.
 */
export async function insertHandoff({
  composer,
  view,
}: {
  composer: PluginComposerApi;
  view: ComposerView;
}): Promise<void> {
  const target = scopeTarget(view.scope);
  const rpc = currentRpc();
  let context: DesignContext | null = null;
  if (rpc !== null && (target.threadId !== null || target.projectId !== null)) {
    context = await rpc.call("context", target).catch(() => null);
  }
  const project = context?.project ?? null;
  composer.updateText((current) =>
    appendToDraft(
      current,
      handoffPrompt(project === null ? null : { id: project.id, name: project.name }),
    ),
  );
  composer.focus();
  if (project === null && context?.bbProject != null && context.linkable) {
    toast(`No Claude Design project is linked to ${context.bbProject.name}`, {
      description:
        "The prompt asks the agent to find it. Link one on the Claude Design page to skip that step.",
      action: {
        label: "Link one",
        onClick: () => currentNavigate()?.toPluginPanel(PANEL_PATH),
      },
    });
  }
}
