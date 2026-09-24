// Claude Design for bb — the server side.
//
// The plugin never talks to Claude Design: that is the claude-design MCP
// server's job, inside an agent thread. What lives here is the list of
// Claude Design projects the user works on, each optionally linked to one bb
// project, served three ways: RPC for the sidebar page and the in-thread
// controls, the `bb claude-design` command for agents, and a realtime signal
// so every open page follows a change made anywhere else.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  rpcContract,
  type BbProject,
  type DesignContext,
  type DesignProject,
} from "./contract";
import {
  CHANGED_CHANNEL,
  cleanName,
  isProjectId,
  parseProjectRef,
  projectUrl,
} from "./lib/links";
import {
  PAC_ROUTE,
  ROUTED_DOMAINS,
  installCommand,
  isSshTarget,
  pacScript,
  uninstallCommand,
} from "./lib/route";
import {
  ProjectListError,
  defaultFor,
  findProject,
  linkProject,
  makeDefault,
  normalizeDefaults,
  removeProject,
  sortByName,
  unlinkProject,
  upsertProject,
  type StoredProject,
} from "./lib/project-list";

const STORAGE_KEY = "projects";

/** Stored rows are read back through this: storage is not a trusted source. */
const storedProjectSchema = z.object({
  id: z.string().refine(isProjectId, "not a project id"),
  name: z.string().min(1),
  bbProjectId: z.string().min(1).nullable(),
  isDefault: z.boolean(),
  addedAt: z.string(),
  linkedAt: z.string().nullable(),
});

interface BbProjectInfo {
  name: string;
  kind: string;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    sshTarget: {
      type: "string",
      label: "SSH login to this server from your Mac (user@host), used by the no-VPN setup",
      default: "",
    },
  });

  // The routing rule a Mac fetches through its SSH tunnel (see lib/route.ts).
  // It holds no secret: it only names Claude's domains and a local port.
  let lastPacFetchAt: number | null = null;
  bb.http.route("GET", PAC_ROUTE, () => {
    lastPacFetchAt = Date.now();
    return new Response(pacScript(), {
      headers: {
        "content-type": "application/x-ns-proxy-autoconfig; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  });

  async function readList(): Promise<StoredProject[]> {
    const raw = await bb.storage.kv.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const list: StoredProject[] = [];
    for (const entry of raw) {
      const parsed = storedProjectSchema.safeParse(entry);
      if (!parsed.success) {
        bb.log.warn(
          `ignoring a malformed saved project: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
        continue;
      }
      if (seen.has(parsed.data.id)) continue;
      seen.add(parsed.data.id);
      list.push({ ...parsed.data, name: cleanName(parsed.data.name) });
    }
    return normalizeDefaults(list);
  }

  // Every change is read-modify-write on one kv row, so changes run one at a
  // time; a click on the page and an agent's CLI call cannot overwrite each other.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(
    change: (list: StoredProject[]) => { list: StoredProject[]; result: T },
  ): Promise<T> {
    const run = queue.then(async () => {
      const { list, result } = change(await readList());
      await bb.storage.kv.set(STORAGE_KEY, list);
      bb.realtime.publish(CHANGED_CHANNEL, { count: list.length });
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  async function bbProjects(): Promise<Map<string, BbProjectInfo>> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return new Map(
      projects.map((project) => [
        project.id,
        { name: project.name, kind: project.kind },
      ]),
    );
  }

  function toView(
    project: StoredProject,
    names: Map<string, BbProjectInfo>,
  ): DesignProject {
    return {
      id: project.id,
      name: project.name,
      url: projectUrl(project.id),
      bbProjectId: project.bbProjectId,
      bbProjectName:
        project.bbProjectId === null
          ? null
          : (names.get(project.bbProjectId)?.name ?? null),
      isDefault: project.isDefault,
      addedAt: project.addedAt,
      linkedAt: project.linkedAt,
    };
  }

  async function listViews(): Promise<DesignProject[]> {
    const [list, names] = await Promise.all([readList(), bbProjects()]);
    return sortByName(list).map((project) => toView(project, names));
  }

  async function viewOf(id: string): Promise<DesignProject> {
    const [list, names] = await Promise.all([readList(), bbProjects()]);
    const project = list.find((candidate) => candidate.id === id);
    if (project === undefined) {
      throw new ProjectListError("not_found", `No saved project with id ${id}`);
    }
    return toView(project, names);
  }

  /** Only real projects: bb's personal project holds unrelated threads. */
  async function linkableProject(bbProjectId: string): Promise<BbProject> {
    const info = (await bbProjects()).get(bbProjectId);
    if (info === undefined) {
      throw new ProjectListError(
        "unknown_bb_project",
        `No bb project with id ${bbProjectId}`,
        "Run `bb project list` for the ids.",
      );
    }
    if (info.kind === "personal") {
      throw new ProjectListError(
        "not_linkable",
        "Threads outside a project cannot have a linked Claude Design project",
        "Link it to a bb project instead.",
      );
    }
    return { id: bbProjectId, name: info.name };
  }

  async function addProject(input: {
    ref: string;
    name: string | null;
    bbProjectId: string | null;
    makeDefault: boolean;
  }): Promise<{ project: DesignProject; created: boolean }> {
    const id = parseProjectRef(input.ref);
    if (id === null) {
      throw new ProjectListError(
        "invalid_link",
        `Not a Claude Design project link: ${input.ref.slice(0, 200)}`,
        "Use a link like https://claude.ai/design/p/<project id>, or the bare id.",
      );
    }
    const bbProject =
      input.bbProjectId === null ? null : await linkableProject(input.bbProjectId);
    const now = new Date().toISOString();
    const created = await mutate((list) => {
      const saved = upsertProject(list, { id, name: input.name, now });
      const next =
        bbProject === null
          ? saved.list
          : linkProject(saved.list, {
              id,
              bbProjectId: bbProject.id,
              makeDefault: input.makeDefault,
              now,
            });
      return { list: next, result: saved.created };
    });
    return { project: await viewOf(id), created };
  }

  async function link(input: {
    id: string;
    bbProjectId: string;
    makeDefault: boolean;
  }): Promise<DesignProject> {
    const bbProject = await linkableProject(input.bbProjectId);
    const now = new Date().toISOString();
    await mutate((list) => ({
      list: linkProject(list, { ...input, bbProjectId: bbProject.id, now }),
      result: null,
    }));
    return viewOf(input.id);
  }

  async function unlink(id: string): Promise<DesignProject> {
    await mutate((list) => ({ list: unlinkProject(list, id), result: null }));
    return viewOf(id);
  }

  async function setDefault(id: string): Promise<DesignProject> {
    await mutate((list) => ({ list: makeDefault(list, id), result: null }));
    return viewOf(id);
  }

  async function remove(id: string): Promise<DesignProject> {
    const names = await bbProjects();
    const removed = await mutate((list) => {
      const next = removeProject(list, id);
      return { list: next.list, result: next.removed };
    });
    return toView(removed, names);
  }

  async function projectOfThread(threadId: string): Promise<string | null> {
    try {
      return (await bb.sdk.threads.get({ threadId })).projectId;
    } catch {
      // Not a thread bb knows (a plugin page's browser uses its own ids).
      return null;
    }
  }

  async function contextFor(bbProjectId: string | null): Promise<DesignContext> {
    if (bbProjectId === null) {
      return { bbProject: null, linkable: false, project: null };
    }
    const [list, names] = await Promise.all([readList(), bbProjects()]);
    const info = names.get(bbProjectId);
    const linked = defaultFor(list, bbProjectId);
    return {
      bbProject: { id: bbProjectId, name: info?.name ?? bbProjectId },
      linkable: info !== undefined && info.kind !== "personal",
      project: linked === null ? null : toView(linked, names),
    };
  }

  // Refusals (unknown project, bad link) are ordinary Errors: the RPC layer
  // hands their message to the page, which shows it as is.
  bb.rpc.register(rpcContract, {
    list: async () => ({ projects: await listViews() }),
    route_info: async () => {
      const { sshTarget } = await settings.get();
      const target = sshTarget && isSshTarget(sshTarget) ? sshTarget : null;
      const serverPort = Number(new URL(bb.server.loopbackBaseUrl).port || 80);
      return {
        target,
        installCommand: target
          ? installCommand({ target, serverPort, pluginId: bb.pluginId })
          : null,
        uninstallCommand: uninstallCommand(bb.pluginId),
        domains: [...ROUTED_DOMAINS],
        lastPacFetchAt,
      };
    },
    route_set_target: async ({ target }) => {
      if (target && !isSshTarget(target)) {
        throw new Error("Use the SSH login you use from the Mac, like coder@203.0.113.7.");
      }
      await settings.experimental_set({ sshTarget: target });
      return { target: target || null };
    },
    bb_projects: async () => {
      const projects = await bb.sdk.projects.list();
      return {
        projects: projects
          .filter((project) => project.kind !== "personal")
          .map((project) => ({ id: project.id, name: project.name })),
      };
    },
    add: async (input) => (await addProject(input)).project,
    link: (input) => link(input),
    unlink: ({ id }) => unlink(id),
    set_default: ({ id }) => setDefault(id),
    remove: async ({ id }) => ({ removed: await remove(id) }),
    context: async ({ threadId, projectId }) =>
      contextFor(
        projectId ?? (threadId === null ? null : await projectOfThread(threadId)),
      ),
  });

  // ---- `bb claude-design` ------------------------------------------------

  function json(value: unknown): PluginCliResult {
    return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` };
  }

  function text(lines: string[]): PluginCliResult {
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }

  /** Library refusals become CLI errors with their hint and a stable code. */
  async function cli(run: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof ProjectListError) {
        throw new PluginCliError(cause.message, {
          code: cause.code,
          ...(cause.hint === undefined ? {} : { hint: cause.hint }),
        });
      }
      throw cause;
    }
  }

  async function findSaved(ref: string): Promise<StoredProject> {
    return findProject(await readList(), ref, parseProjectRef(ref));
  }

  async function bbProjectFor(
    option: string | undefined,
    ctx: PluginCliContext,
  ): Promise<string> {
    const explicit = option?.trim();
    if (explicit !== undefined && explicit !== "") return explicit;
    if (ctx.projectId !== undefined && ctx.projectId !== "") return ctx.projectId;
    if (ctx.threadId !== undefined) {
      const fromThread = await projectOfThread(ctx.threadId);
      if (fromThread !== null) return fromThread;
    }
    throw new PluginCliError("No bb project to work with here", {
      code: "no_bb_project",
      hint: "Run it inside a bb thread, or pass --project <proj id> (see `bb project list`).",
    });
  }

  function linkLabel(project: DesignProject): string {
    if (project.bbProjectId === null) return "not linked";
    const name = project.bbProjectName ?? "a bb project that no longer exists";
    return `${name} (${project.bbProjectId})${project.isDefault ? ", default" : ""}`;
  }

  function table(projects: DesignProject[]): string[] {
    const width = Math.min(40, Math.max(...projects.map((p) => p.name.length)));
    return projects.map((project) => {
      const name =
        project.name.length > width
          ? `${project.name.slice(0, width - 1)}…`
          : project.name.padEnd(width);
      return `${name}  ${project.id}  ${linkLabel(project)}`;
    });
  }

  function card(project: DesignProject): string[] {
    return [`  ${project.url}`, `  ${linkLabel(project)}`];
  }

  const jsonFlag = {
    type: "boolean",
    description: "Print JSON instead of text",
  } as const;
  const projectOption = {
    type: "string",
    description: "bb project id (proj_…); see `bb project list`",
    placeholder: "proj id",
    aliases: ["bb-project"],
  } as const;
  const designRef = {
    name: "design-project",
    description:
      "A saved Claude Design project: its id, a 6+ character id prefix, its link, or its exact name",
    required: true,
  } as const;

  bb.cli.register(
    defineCli({
      name: "claude-design",
      summary:
        "Keep Claude Design projects linked to bb projects and find the one for this thread",
      description:
        "Claude Design itself is reached through the claude-design MCP server; this command only keeps the list of projects and their bb links.",
      commands: {
        projects: cliCommand({
          summary: "List saved Claude Design projects and their bb links",
          options: { json: jsonFlag },
          run: ({ options }) =>
            cli(async () => {
              const projects = await listViews();
              if (options.json) return json({ projects });
              if (projects.length === 0) {
                return text([
                  "No Claude Design projects saved.",
                  "Save one: bb claude-design add <link> --name <name> [--project <proj id>]",
                ]);
              }
              return text(table(projects));
            }),
        }),
        add: cliCommand({
          summary:
            "Save a project by its link; for a saved one, --name renames it and --project links it",
          positionals: [
            {
              name: "link",
              description: "https://claude.ai/design/p/<id> (query allowed) or the bare id",
              required: true,
            },
          ],
          options: {
            name: {
              type: "string",
              description: `Display name, up to 120 characters (new projects default to "Project <id prefix>")`,
            },
            project: { ...projectOption, description: "Also link it to this bb project (proj_…)" },
            default: {
              type: "boolean",
              description: "Make it the default for --project even if that project has one",
            },
            json: jsonFlag,
          },
          constraints: [{ kind: "requires", option: "default", needs: ["project"] }],
          run: ({ positionals, options }) =>
            cli(async () => {
              const { project, created } = await addProject({
                ref: positionals.link,
                name: options.name ?? null,
                bbProjectId: options.project?.trim() || null,
                makeDefault: options.default,
              });
              if (options.json) return json({ created, project });
              return text([
                `${created ? "Saved" : "Updated"} ${JSON.stringify(project.name)} (${project.id})`,
                ...card(project),
              ]);
            }),
        }),
        link: cliCommand({
          summary:
            "Link a saved project to a bb project (default: this thread's); the first link becomes the default",
          positionals: [designRef],
          options: {
            project: {
              ...projectOption,
              description: "bb project id (proj_…); defaults to the invoking thread's project",
            },
            default: {
              type: "boolean",
              description: "Make it the default even if the bb project already has one",
            },
            json: jsonFlag,
          },
          run: ({ positionals, options }, ctx) =>
            cli(async () => {
              const saved = await findSaved(positionals["design-project"]);
              const bbProjectId = await bbProjectFor(options.project, ctx);
              const project = await link({
                id: saved.id,
                bbProjectId,
                makeDefault: options.default,
              });
              if (options.json) return json({ project });
              const lines = [
                `Linked ${JSON.stringify(project.name)} to ${linkLabel(project)}`,
              ];
              if (!project.isDefault) {
                const current = defaultFor(await readList(), bbProjectId);
                if (current !== null) {
                  lines.push(
                    `${JSON.stringify(current.name)} stays the default; pass --default to switch.`,
                  );
                }
              }
              return text(lines);
            }),
        }),
        unlink: cliCommand({
          summary: "Remove a project's bb link (the project stays saved)",
          positionals: [designRef],
          options: { json: jsonFlag },
          run: ({ positionals, options }) =>
            cli(async () => {
              const saved = await findSaved(positionals["design-project"]);
              const before = await viewOf(saved.id);
              const project = await unlink(saved.id);
              if (options.json) return json({ project });
              const previous = before.bbProjectId;
              if (previous === null) {
                return text([`${JSON.stringify(project.name)} was not linked.`]);
              }
              const lines = [
                `Unlinked ${JSON.stringify(project.name)} from ${before.bbProjectName ?? "a removed bb project"} (${previous}).`,
              ];
              const next = before.isDefault
                ? defaultFor(await readList(), previous)
                : null;
              if (next !== null) {
                lines.push(`${JSON.stringify(next.name)} is now the default there.`);
              }
              return text(lines);
            }),
        }),
        remove: cliCommand({
          summary: "Forget a saved project and its link",
          positionals: [designRef],
          options: { json: jsonFlag },
          run: ({ positionals, options }) =>
            cli(async () => {
              const saved = await findSaved(positionals["design-project"]);
              const removed = await remove(saved.id);
              if (options.json) return json({ removed });
              return text([`Removed ${JSON.stringify(removed.name)} (${removed.id}).`]);
            }),
        }),
        current: cliCommand({
          summary:
            "Show the Claude Design project linked to this thread's bb project (what agents use to find the project id)",
          options: {
            project: {
              ...projectOption,
              description: "Look up this bb project instead of the invoking thread's",
            },
            json: jsonFlag,
          },
          run: ({ options }, ctx) =>
            cli(async () => {
              const bbProjectId = await bbProjectFor(options.project, ctx);
              const context = await contextFor(bbProjectId);
              const all = await listViews();
              const alsoLinked = all.filter(
                (project) =>
                  project.bbProjectId === bbProjectId && !project.isDefault,
              );
              if (options.json) return json({ ...context, alsoLinked });
              const where = `${context.bbProject?.name ?? bbProjectId} (${bbProjectId})`;
              const project = context.project;
              if (project === null) {
                const saved = `Saved projects: ${all.length} (bb claude-design projects).`;
                if (!context.linkable) {
                  return text([
                    `This thread is not in a bb project, so no Claude Design project is linked to it.`,
                    saved,
                  ]);
                }
                return text([
                  `No Claude Design project is linked to ${where}.`,
                  saved,
                  `Link one: bb claude-design link <id> --project ${bbProjectId}`,
                ]);
              }
              return text([
                `${where} -> ${JSON.stringify(project.name)}`,
                `  id   ${project.id}`,
                `  url  ${project.url}`,
                ...(alsoLinked.length === 0
                  ? []
                  : [
                      `Also linked: ${alsoLinked
                        .map((other) => `${JSON.stringify(other.name)} (${other.id})`)
                        .join(", ")}`,
                    ]),
              ]);
            }),
        }),
      },
    }),
  );
}
