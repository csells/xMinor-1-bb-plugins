// Claude Design for bb — the app side.
//
// claude.ai refuses to be framed, so nothing here embeds it. Every "open"
// goes through bb's openUrl, which lands in bb's own browser beside the chat
// when the desktop app's "Open links in the in-app browser" setting is on,
// and in a normal browser tab otherwise.
//
// Surfaces:
//   sidebar page        saved projects, bb links, open / hand off / remove
//   thread header       opens the project linked to the thread's bb project
//   browser toolbar     on a Claude Design project page: hand its comments
//                       to this chat, link it to this thread's bb project
//   panel launcher      "Claude Design" row in a thread's right-panel + menu
//   composer + menu     "Claude Design comments" inserts the hand-off prompt
//   command palette     "Claude Design: Open this thread's project"
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Bridge } from "@/components/Bridge";
import { BrowserAction } from "@/components/BrowserAction";
import { HeaderAction } from "@/components/HeaderAction";
import { ProjectsHeader, ProjectsPage } from "@/components/ProjectsPage";
import { ThreadPanel } from "@/components/ThreadPanel";
import { insertHandoff, openForThread } from "@/lib/actions";
import { PANEL_ACTION_ID, PANEL_PATH } from "@/lib/links";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "projects",
    title: "Claude Design",
    // The sidebar draws the manifest's icon.svg; this is only the fallback.
    icon: "Palette",
    path: PANEL_PATH,
    component: ProjectsPage,
    headerContent: ProjectsHeader,
  });

  app.slots.experimental_appOverlay({ id: "bridge", component: Bridge });

  app.slots.experimental_threadHeaderAction({
    id: "open",
    title: "Claude Design",
    component: HeaderAction,
  });

  app.slots.experimental_browserToolbarAction({
    id: "comments",
    title: "Claude Design",
    component: BrowserAction,
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Claude Design",
    icon: "Palette",
    component: ThreadPanel,
    run: ({ threadId, openPanel }) =>
      openForThread({
        threadId,
        projectId: null,
        openPanel: () => openPanel({ title: "Claude Design" }),
      }),
  });

  app.commands.register({
    id: "open-project",
    title: "Claude Design: Open this thread's project",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId, projectId, openPanel }) => {
      if (threadId === null) return;
      return openForThread({
        threadId,
        projectId,
        openPanel: () =>
          openPanel({ actionId: PANEL_ACTION_ID, title: "Claude Design" }),
      });
    },
  });

  app.composer.customize({
    id: "claude-design",
    plusMenu: [
      {
        id: "comments",
        label: "Claude Design comments",
        icon: "Palette",
        description:
          "Insert a prompt that hands the comments queued with Send to Claude to the agent",
        run: insertHandoff,
      },
    ],
  });
});
