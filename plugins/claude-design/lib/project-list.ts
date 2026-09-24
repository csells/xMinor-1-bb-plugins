// The saved list of Claude Design projects as plain data, and every change the
// server makes to it. Pure functions: the server owns storage and locking.
//
// Invariant kept by `normalizeDefaults`: every bb project that has linked
// Claude Design projects has exactly one of them marked as its default, and an
// unlinked project is never a default.
import { cleanName, isProjectId } from "./links";

export interface StoredProject {
  /** Claude Design project id (lowercase UUID). */
  id: string;
  name: string;
  /** The bb project (`proj_*`) this project belongs to, if any. */
  bbProjectId: string | null;
  /** The one opened and handed off from that bb project's threads. */
  isDefault: boolean;
  addedAt: string;
  linkedAt: string | null;
}

export const MAX_PROJECTS = 200;

/** A readable default until the user names the project. */
export function fallbackName(id: string): string {
  return `Project ${id.slice(0, 8)}`;
}

function latestLinked(group: readonly StoredProject[]): StoredProject {
  return group.reduce((best, candidate) =>
    (candidate.linkedAt ?? "") > (best.linkedAt ?? "") ? candidate : best,
  );
}

export function normalizeDefaults(
  list: readonly StoredProject[],
): StoredProject[] {
  const groups = new Map<string, StoredProject[]>();
  for (const project of list) {
    if (project.bbProjectId === null) continue;
    const group = groups.get(project.bbProjectId) ?? [];
    group.push(project);
    groups.set(project.bbProjectId, group);
  }
  const defaults = new Set<string>();
  for (const group of groups.values()) {
    const marked = group.filter((project) => project.isDefault);
    defaults.add(latestLinked(marked.length > 0 ? marked : group).id);
  }
  return list.map((project) => {
    const isDefault = defaults.has(project.id);
    return project.isDefault === isDefault ? project : { ...project, isDefault };
  });
}

export function sortByName(list: readonly StoredProject[]): StoredProject[] {
  return [...list].sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
}

export function defaultFor(
  list: readonly StoredProject[],
  bbProjectId: string,
): StoredProject | null {
  return (
    list.find(
      (project) => project.bbProjectId === bbProjectId && project.isDefault,
    ) ?? null
  );
}

/** A refusal worth showing as is: the page shows the message, the CLI adds the hint. */
export class ProjectListError extends Error {
  constructor(
    /** snake_case, stable: the CLI's `--json` error code. */
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ProjectListError";
  }
}

/**
 * Finds a saved project by id, link, id prefix (6+ characters) or exact name,
 * the ways a person or an agent is likely to refer to it.
 */
export function findProject(
  list: readonly StoredProject[],
  ref: string,
  parsedId: string | null,
): StoredProject {
  const wanted = ref.trim();
  if (parsedId !== null) {
    const exact = list.find((project) => project.id === parsedId);
    if (exact !== undefined) return exact;
  }
  const lower = wanted.toLowerCase();
  const byPrefix =
    lower.length >= 6 && /^[0-9a-f-]+$/.test(lower)
      ? list.filter((project) => project.id.startsWith(lower))
      : [];
  const byName = list.filter(
    (project) => project.name.toLowerCase() === lower,
  );
  const matches = [...new Set([...byPrefix, ...byName])];
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1) {
    throw new ProjectListError(
      "ambiguous",
      `"${wanted}" matches ${matches.length} saved projects: ${matches
        .map((project) => `${project.name} (${project.id})`)
        .join(", ")}`,
      "Pass the full project id.",
    );
  }
  throw new ProjectListError(
    "not_found",
    `No saved Claude Design project matches "${wanted}"`,
    "Run `bb claude-design projects` for the saved ones, or save it with `bb claude-design add <link>`.",
  );
}

export function upsertProject(
  list: readonly StoredProject[],
  input: { id: string; name: string | null; now: string },
): { list: StoredProject[]; project: StoredProject; created: boolean } {
  if (!isProjectId(input.id)) {
    throw new ProjectListError("not_found", `Not a project id: ${input.id}`);
  }
  const name = input.name === null ? "" : cleanName(input.name);
  const existing = list.find((project) => project.id === input.id);
  if (existing !== undefined) {
    const project = name === "" ? existing : { ...existing, name };
    return {
      list: list.map((candidate) =>
        candidate.id === input.id ? project : candidate,
      ),
      project,
      created: false,
    };
  }
  if (list.length >= MAX_PROJECTS) {
    throw new ProjectListError(
      "full",
      `The list holds at most ${MAX_PROJECTS} projects`,
      "Remove one you no longer use with `bb claude-design remove <id>`.",
    );
  }
  const project: StoredProject = {
    id: input.id,
    name: name === "" ? fallbackName(input.id) : name,
    bbProjectId: null,
    isDefault: false,
    addedAt: input.now,
    linkedAt: null,
  };
  return { list: [...list, project], project, created: true };
}

function requireProject(
  list: readonly StoredProject[],
  id: string,
): StoredProject {
  const project = list.find((candidate) => candidate.id === id);
  if (project === undefined) {
    throw new ProjectListError(
      "not_found",
      `No saved Claude Design project with id ${id}`,
    );
  }
  return project;
}

/**
 * Links a project to a bb project. It becomes that bb project's default when
 * asked to, or when the bb project has no default yet.
 */
export function linkProject(
  list: readonly StoredProject[],
  input: { id: string; bbProjectId: string; makeDefault: boolean; now: string },
): StoredProject[] {
  const current = requireProject(list, input.id);
  const sameLink = current.bbProjectId === input.bbProjectId;
  const hasOtherDefault = list.some(
    (project) =>
      project.id !== input.id &&
      project.bbProjectId === input.bbProjectId &&
      project.isDefault,
  );
  const becomesDefault =
    input.makeDefault || (sameLink && current.isDefault) || !hasOtherDefault;
  const next = list.map((project) => {
    if (project.id === input.id) {
      return {
        ...project,
        bbProjectId: input.bbProjectId,
        isDefault: becomesDefault,
        linkedAt: sameLink ? project.linkedAt : input.now,
      };
    }
    if (becomesDefault && project.bbProjectId === input.bbProjectId) {
      return { ...project, isDefault: false };
    }
    return project;
  });
  return normalizeDefaults(next);
}

export function unlinkProject(
  list: readonly StoredProject[],
  id: string,
): StoredProject[] {
  requireProject(list, id);
  return normalizeDefaults(
    list.map((project) =>
      project.id === id
        ? { ...project, bbProjectId: null, isDefault: false, linkedAt: null }
        : project,
    ),
  );
}

export function makeDefault(
  list: readonly StoredProject[],
  id: string,
): StoredProject[] {
  const target = requireProject(list, id);
  if (target.bbProjectId === null) {
    throw new ProjectListError(
      "not_linked",
      `${target.name} is not linked to a bb project`,
      "Link it first with `bb claude-design link <id> --project <proj id>`.",
    );
  }
  return list.map((project) =>
    project.bbProjectId === target.bbProjectId
      ? { ...project, isDefault: project.id === id }
      : project,
  );
}

export function removeProject(
  list: readonly StoredProject[],
  id: string,
): { list: StoredProject[]; removed: StoredProject } {
  const removed = requireProject(list, id);
  return {
    list: normalizeDefaults(list.filter((project) => project.id !== id)),
    removed,
  };
}
