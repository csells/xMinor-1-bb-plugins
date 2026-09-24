// Where a document lives and how to read it. Files on the bb server's own
// machine are read from disk; files on other machines go through bb.sdk.files
// and, for rendering, are copied into the plugin's cache.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { openerSourceSchema } from "./contract.js";
import type { DocRow } from "./store.js";

export type OpenerSource = z.infer<typeof openerSourceSchema>;

/** Markdown bigger than this is refused: the panel renders it in one pass. */
export const MARKDOWN_MAX_BYTES = 4 * 1024 * 1024;

export function joinPath(root: string, relative: string): string {
  const normalized = path.posix.normalize(relative.replace(/^\/+/, ""));
  if (normalized.startsWith("..")) {
    throw new Error("The path leaves its workspace.");
  }
  return path.posix.join(root, normalized);
}

export class DocFiles {
  private localHostIdPromise: Promise<string | null> | null = null;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly cacheRoot: string,
  ) {}

  /** The enrolled host id of the machine the bb server runs on. */
  localHostId(): Promise<string | null> {
    this.localHostIdPromise ??= this.bb.sdk.system.config().then(
      (config) => config.primaryHostId ?? null,
      () => null,
    );
    return this.localHostIdPromise;
  }

  /** Normalizes a host id: the server's own machine is stored as null. */
  async canonicalHost(hostId: string | null | undefined): Promise<string | null> {
    if (!hostId) return null;
    return hostId === (await this.localHostId()) ? null : hostId;
  }

  /**
   * Resolves a file-opener path to an absolute path and its host.
   * Workspace paths are worktree-relative, thread-storage paths are relative
   * to the thread's storage root, and host paths are already absolute.
   */
  async resolve(
    rawPath: string,
    source: OpenerSource,
  ): Promise<{ absPath: string; hostId: string | null }> {
    if (source.kind === "workspace") {
      if (source.environmentId) {
        const environment = await this.bb.sdk.environments.get({
          environmentId: source.environmentId,
        });
        if (!environment.path) throw new Error("This environment has no checkout on disk yet.");
        return {
          absPath: joinPath(environment.path, rawPath),
          hostId: await this.canonicalHost(environment.hostId),
        };
      }
      // A project's own checkout, opened outside any thread.
      if (source.projectId) {
        const project = await this.bb.sdk.projects.get({ projectId: source.projectId });
        const checkout =
          project.sources.find((candidate) => candidate.hostId === source.experimental_hostId) ??
          project.sources.find((candidate) => candidate.isDefault) ??
          project.sources[0];
        if (!checkout) throw new Error("This project has no checkout on any host.");
        return {
          absPath: joinPath(checkout.path, rawPath),
          hostId: await this.canonicalHost(checkout.hostId),
        };
      }
      throw new Error("This workspace file has no environment.");
    }
    if (source.kind === "thread-storage") {
      if (!source.threadId) throw new Error("This stored file has no thread.");
      // storageLocation names the root and its host without listing entries
      // (storagePaths refuses a request that asks for no entries).
      const storage = await this.bb.sdk.threads.storageLocation({ threadId: source.threadId });
      return {
        absPath: joinPath(storage.storageRootPath, rawPath),
        hostId: await this.canonicalHost(storage.hostId),
      };
    }
    // "~/…" is a convenience for paths typed on the Doc Review page.
    if (rawPath === "~" || rawPath.startsWith("~/")) rawPath = path.posix.join(homedir(), rawPath.slice(1));
    if (!path.posix.isAbsolute(rawPath)) throw new Error("Expected an absolute path.");
    let hostId: string | null = source.experimental_hostId ?? null;
    if (!hostId && source.environmentId) {
      const environment = await this.bb.sdk.environments.get({
        environmentId: source.environmentId,
      });
      hostId = environment.hostId;
    }
    return { absPath: path.posix.normalize(rawPath), hostId: await this.canonicalHost(hostId) };
  }

  /**
   * A cheap change token. Local files use size and mtime; remote files use
   * the content hash bb reports.
   */
  async version(doc: DocRow): Promise<string | null> {
    if (doc.hostId === null) {
      const info = await stat(doc.absPath).catch(() => null);
      if (!info?.isFile()) return null;
      return `m${Math.round(info.mtimeMs)}-s${info.size}`;
    }
    const file = await this.bb.sdk.files
      .read({ hostId: doc.hostId, path: doc.absPath })
      .catch(() => null);
    return file ? `h${file.sha256.slice(0, 16)}` : null;
  }

  async readText(doc: DocRow): Promise<string> {
    if (doc.hostId === null) {
      const info = await stat(doc.absPath);
      if (info.size > MARKDOWN_MAX_BYTES) throw new Error("This file is too large to review.");
      return readFile(doc.absPath, "utf8");
    }
    const file = await this.bb.sdk.files.read({ hostId: doc.hostId, path: doc.absPath });
    if (file.sizeBytes > MARKDOWN_MAX_BYTES) throw new Error("This file is too large to review.");
    return file.contentEncoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
  }

  /**
   * A short-lived URL serving the document's directory, so relative images in
   * Markdown resolve. Null when bb cannot mint one.
   */
  async assetBaseUrl(doc: DocRow): Promise<string | null> {
    try {
      const preview = await this.bb.sdk.files.createPreview({
        ...(doc.hostId ? { hostId: doc.hostId } : {}),
        rootPath: path.posix.dirname(doc.absPath),
        ttlMs: 6 * 60 * 60 * 1000,
      });
      return preview.baseUrl;
    } catch {
      return null;
    }
  }
}
