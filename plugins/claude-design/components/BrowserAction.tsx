// Controls beside the address bar of bb's own browser, shown only while the
// tab is on a Claude Design project page. The project comes straight from the
// address, so it needs no linking first:
//   Comments — puts the hand-off prompt for this project in the thread's
//              composer (a new chat's, outside a thread);
//   Link     — makes this project the one the thread's bb project opens, when
//              it is not already.
// Plain buttons, no menus: the page is a native view drawn above the app, and
// a menu opening over it would be hidden behind it.
import { useState } from "react";
import {
  useBbNavigate,
  useComposer,
  useRpc,
  type ExperimentalPluginBrowserToolbarActionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { ClaudeDesignMark } from "@/components/ClaudeDesignMark";
import { chromeButtonClass } from "@/components/HeaderAction";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "@/contract";
import {
  appendToDraft,
  handoffPrompt,
  nameFromTitle,
  projectIdFromUrl,
} from "@/lib/links";
import { messageOf, refreshProjects, useProjects } from "@/lib/store";
import { useDesignContext } from "@/lib/use-design-context";
import { cn } from "@/lib/utils";

export function BrowserAction({
  threadId,
  url,
  isCompactViewport,
  experimental_page: page,
}: ExperimentalPluginBrowserToolbarActionProps) {
  const designId = projectIdFromUrl(url);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const composer = useComposer();
  const { projects } = useProjects();
  const context = useDesignContext(designId === null ? null : threadId);
  const [linking, setLinking] = useState(false);

  if (designId === null) return null;

  const saved = projects.find((project) => project.id === designId) ?? null;
  const bbProject = context.data?.bbProject ?? null;
  const isDefaultHere =
    saved !== null &&
    bbProject !== null &&
    saved.bbProjectId === bbProject.id &&
    saved.isDefault;
  const canLink =
    context.data?.linkable === true && bbProject !== null && !isDefaultHere;

  // The tab title names the project; only the desktop app can read it.
  const titleName = async (): Promise<string | null> => {
    if (page === null) return null;
    try {
      const title = await page.evaluate("document.title");
      return typeof title === "string" ? nameFromTitle(title) : null;
    } catch {
      return null;
    }
  };

  const handOff = async () => {
    const prompt = handoffPrompt({
      id: designId,
      name: saved?.name ?? (await titleName()),
    });
    // Outside a thread (a plugin page's browser) there is no chat to add to.
    if (bbProject === null) {
      navigate.toCompose({ initialPrompt: prompt, focusPrompt: true });
      return;
    }
    composer.updateText((current) => appendToDraft(current, prompt));
    composer.focus();
  };

  const link = async () => {
    if (bbProject === null) return;
    setLinking(true);
    try {
      await rpc.call("add", {
        ref: designId,
        name: saved === null ? await titleName() : null,
        bbProjectId: bbProject.id,
        makeDefault: true,
      });
      await refreshProjects();
    } catch (cause) {
      toast.error("Could not link the Claude Design project", {
        description: messageOf(cause),
      });
    } finally {
      setLinking(false);
    }
  };

  const handLabel =
    bbProject === null
      ? "Start a chat that works through the comments queued with Send to Claude"
      : "Hand the comments queued with Send to Claude to this chat";
  const projectName = saved?.name ?? "this Claude Design project";
  const linkLabel =
    bbProject === null
      ? ""
      : saved?.bbProjectId === bbProject.id
        ? `Make ${projectName} the one ${bbProject.name} opens`
        : `Link ${projectName} to ${bbProject.name}`;

  return (
    <span className="flex items-center gap-0.5">
      <button
        aria-label={handLabel}
        className={cn(chromeButtonClass, isCompactViewport ? "w-7" : "px-2")}
        disabled={context.status === "loading"}
        onClick={() => void handOff()}
        title={handLabel}
        type="button"
      >
        <ClaudeDesignMark className="size-4" />
        {isCompactViewport ? null : <span>Comments</span>}
      </button>
      {canLink ? (
        <button
          aria-label={linkLabel}
          className={cn(chromeButtonClass, isCompactViewport ? "w-7" : "px-2")}
          disabled={linking}
          onClick={() => void link()}
          title={linkLabel}
          type="button"
        >
          <Icon
            aria-hidden
            className={cn("size-3.5", linking && "animate-spin")}
            name={linking ? "Loading" : "Plus"}
          />
          {isCompactViewport ? null : <span>Link</span>}
        </button>
      ) : null}
    </span>
  );
}
