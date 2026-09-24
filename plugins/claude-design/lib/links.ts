// Pure helpers shared by the server, the CLI and the app: Claude Design links,
// project references and the hand-off prompt. No imports, so the app bundle
// stays small and the server uses the same rules as the page.

export const CLAUDE_DESIGN_HOME = "https://claude.ai/design";
const PROJECT_URL_BASE = "https://claude.ai/design/p/";

/** Route segment of the sidebar page: /plugins/claude-design/projects. */
export const PANEL_PATH = "projects";
/** Realtime channel the server publishes on after every change to the list. */
export const CHANGED_CHANNEL = "projects-changed";
/** The thread panel action; also what the command palette falls back to. */
export const PANEL_ACTION_ID = "claude-design";

export const NAME_MAX = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_PATH = /^\/design\/p\/([0-9a-fA-F-]{36})(?:\/.*)?$/;
const CLAUDE_HOSTS = new Set(["claude.ai", "www.claude.ai"]);

export function isProjectId(value: string): boolean {
  return UUID.test(value);
}

export function projectUrl(id: string): string {
  return `${PROJECT_URL_BASE}${id}`;
}

/**
 * The project id in a Claude Design project link
 * (`https://claude.ai/design/p/<id>`, query and hash allowed), or null.
 */
export function projectIdFromUrl(input: string): string | null {
  let value = input.trim();
  if (/^(www\.)?claude\.ai\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!CLAUDE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const id = PROJECT_PATH.exec(url.pathname)?.[1]?.toLowerCase();
  return id !== undefined && isProjectId(id) ? id : null;
}

/** A project link or a bare project id, normalized to the lowercase id. */
export function parseProjectRef(input: string): string | null {
  const bare = input.trim().toLowerCase();
  return isProjectId(bare) ? bare : projectIdFromUrl(input);
}

/** One line, bounded: a name is a label, never a paragraph. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

/**
 * A usable project name from a Claude Design tab title, or null when the
 * title only names the product.
 */
export function nameFromTitle(title: string): string | null {
  const stripped = cleanName(
    title.replace(/\s*[|·•—–-]\s*Claude(?:\s+Design)?\s*$/i, ""),
  );
  if (stripped === "" || /^claude(\s+design)?$/i.test(stripped)) return null;
  return stripped;
}

export interface HandoffTarget {
  id: string;
  /** Null when the project is known only by its link. */
  name: string | null;
}

const PROCEDURE =
  "Follow the claude-design-comments skill: work through the queue with the " +
  "claude-design MCP tools, fix each comment, verify the result with " +
  "render_preview, ack only the comments you handled, and report what changed " +
  "with the project link. Ask me before acting on comments someone else wrote.";

/**
 * The prompt that hands the comments queued with "Send to Claude" to an
 * agent. With no target the agent finds the project through the CLI.
 */
export function handoffPrompt(target: HandoffTarget | null): string {
  if (target === null) {
    return [
      'Handle the Claude Design comments queued with "Send to Claude".',
      "Find the project first: run `bb claude-design current`. If no project " +
        "is linked to this bb project, list the saved ones with " +
        "`bb claude-design projects` and ask me which to use.",
      PROCEDURE,
    ].join("\n\n");
  }
  const name = target.name === null ? "" : cleanName(target.name);
  const subject =
    name === ""
      ? `the Claude Design project ${target.id}`
      : `the Claude Design project ${JSON.stringify(name)} (id ${target.id})`;
  return [
    `Handle the comments queued with "Send to Claude" in ${subject}: ${projectUrl(target.id)}`,
    PROCEDURE,
  ].join("\n\n");
}

/** Adds a block below whatever is already in the draft. */
export function appendToDraft(current: string, block: string): string {
  const kept = current.replace(/\s+$/, "");
  return kept === "" ? block : `${kept}\n\n${block}`;
}
