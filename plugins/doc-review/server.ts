// bb-plugin-doc-review — backend entry.
//
// View and comment on Markdown, PDF, Word, PowerPoint, and Excel files in a
// panel tab, then hand the comments to an agent in one message. Viewing
// (LibreOffice conversions, workbooks, links for the classic PDF view) lives
// in src/viewer.ts; page images and text boxes in src/render.ts. Comments live
// in this plugin's SQLite database; the reviewed file is never modified by
// the plugin. Agents report back with the `bb doc-review` command, and every
// change reaches open panels through a realtime signal.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isSupportedPath } from "./lib/formats.js";
import { rpcContract, type RecentDocument } from "./src/contract.js";
import { reviewCli } from "./src/cli.js";
import { DocFiles } from "./src/files.js";
import { buildHandoffMessage } from "./src/message.js";
import { Renderer, renderWidth, type PageSize } from "./src/render.js";
import { MIGRATIONS, ReviewStore, type Db, type DocRow } from "./src/store.js";
import {
  docKindFor,
  isPaged,
  MARKDOWN_EXTENSIONS,
  type ReviewComment,
  type ReviewDoc,
} from "./src/types.js";
import {
  createViewer,
  normalizeLocale,
  serverPlatform,
  type Located,
  type MissingLibreOffice,
} from "./src/viewer.js";

export { rpcContract };
export type { RpcContract } from "./src/contract.js";

/** Realtime channel the panel listens on; payload `{ docIds }`. */
const CHANGED = "review-changed";
const PAGE_ROUTE = "/page";
const NO_PROJECT =
  "This file is not in a project, so a new chat cannot be started from here.";
const RECENTS_KEY = "recent-documents";
const RECENTS_LIMIT = 12;

/** Thrown where pages are needed but LibreOffice cannot make them. */
class NeedsLibreOfficeError extends Error {
  constructor(readonly missing: MissingLibreOffice) {
    super(
      missing.installed
        ? `LibreOffice ${missing.component === "impress" ? "Impress" : "Writer"} is needed to show this file.`
        : "LibreOffice is needed to show this file.",
    );
  }
}

export default async function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, MIGRATIONS);
  const store = new ReviewStore(database as unknown as Db);
  const dataDir = path.dirname(database.name);
  const files = new DocFiles(bb, dataDir);
  const renderer = new Renderer(dataDir);

  const settings = bb.settings.define({
    rememberRecents: {
      type: "boolean",
      label: "Remember recently opened documents",
      default: true,
    },
    libreOfficePath: {
      type: "string",
      label: "LibreOffice executable",
      description:
        "Word and PowerPoint files are converted with LibreOffice on the machine bb runs on. Leave empty to find it automatically; set the full path to soffice if it lives somewhere unusual.",
      default: "",
    },
  });
  const viewer = createViewer(bb, {
    dataDir,
    localHostId: () => files.localHostId(),
    libreOfficePath: async () => (await settings.get()).libreOfficePath,
  });

  function located(doc: DocRow): Located {
    return { absPath: doc.absPath, hostId: doc.hostId };
  }

  function publish(docIds: string[]): void {
    if (docIds.length > 0) bb.realtime.publish(CHANGED, { docIds });
  }

  function requireDoc(docId: string): DocRow {
    const doc = store.getDoc(docId);
    if (!doc) throw new Error("This document is no longer known; reopen the file.");
    return doc;
  }

  async function currentVersion(doc: DocRow): Promise<string> {
    const version = await files.version(doc);
    if (version === null) throw new Error(`The file is gone: ${doc.absPath}`);
    return version;
  }

  function toDto(doc: DocRow, version: string): ReviewDoc {
    return {
      id: doc.id,
      kind: doc.kind,
      name: path.posix.basename(doc.absPath),
      absPath: doc.absPath,
      hostId: doc.hostId,
      version,
    };
  }

  /** The PDF whose pages are shown: the file itself, or LibreOffice's rendering of it. */
  async function pdfFor(doc: DocRow): Promise<string> {
    if (!isPaged(doc.kind)) throw new Error("This kind of document has no pages.");
    const file = await viewer.localFile(located(doc));
    if (doc.kind === "pdf") return file.path;
    const converted = await viewer.convertedPdf(file, path.posix.basename(doc.absPath), doc.kind);
    if (typeof converted !== "string") throw new NeedsLibreOfficeError(converted);
    return converted;
  }

  async function readRecents(): Promise<RecentDocument[]> {
    return (await bb.storage.kv.get<RecentDocument[]>(RECENTS_KEY)) ?? [];
  }

  async function rememberDocument(doc: DocRow): Promise<void> {
    if (!(await settings.get()).rememberRecents) return;
    const hostId = doc.hostId;
    const next = [
      { path: doc.absPath, name: path.posix.basename(doc.absPath), hostId, openedAtMs: Date.now() },
      ...(await readRecents()).filter((entry) => entry.path !== doc.absPath || entry.hostId !== hostId),
    ].slice(0, RECENTS_LIMIT);
    await bb.storage.kv.set(RECENTS_KEY, next);
  }

  /** The host the Doc Review page browses when the user has not picked one. */
  async function defaultHostId(): Promise<string> {
    const local = await files.localHostId();
    if (local) return local;
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((candidate) => candidate.status === "connected") ?? hosts[0];
    if (!host) throw new Error("No host is available to browse.");
    return host.id;
  }

  bb.http.route("GET", PAGE_ROUTE, async (context) => {
    const docId = context.req.query("doc") ?? "";
    const wanted = context.req.query("v") ?? "";
    const n = Number.parseInt(context.req.query("n") ?? "", 10);
    const requested = Number.parseInt(context.req.query("w") ?? "", 10);
    const doc = store.getDoc(docId);
    if (!doc || !isPaged(doc.kind) || !Number.isInteger(n) || n < 1) {
      return context.text("Not found", 404);
    }
    try {
      const version = await currentVersion(doc);
      // A stale URL means the file changed: the panel refetches its page list.
      if (version !== wanted) return context.text("Stale page", 404);
      const pdf = await pdfFor(doc);
      const size = (await renderer.pageSizes(doc.id, version, pdf))[n - 1];
      if (!size) return context.text("Not found", 404);
      const width = renderWidth(size, Number.isFinite(requested) ? requested : null);
      const image = await renderer.pageImage(doc.id, version, pdf, n, width);
      const bytes = await readFile(image);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": "image/png",
          "cache-control": "private, max-age=86400, immutable",
        },
      });
    } catch (error) {
      bb.log.warn(`page ${n} of ${doc.absPath}: ${String(error)}`);
      return context.text("Render failed", 500);
    }
  });

  /** Crops for area comments on pages, in comment order. */
  async function areaImages(
    doc: DocRow,
    comments: ReviewComment[],
  ): Promise<Map<string, Buffer>> {
    const images = new Map<string, Buffer>();
    const areas = comments.filter((comment) => comment.anchor.kind === "page-area");
    if (areas.length === 0 || !isPaged(doc.kind)) return images;
    const version = await currentVersion(doc);
    const pdf = await pdfFor(doc);
    const sizes = await renderer.pageSizes(doc.id, version, pdf);
    for (const comment of areas) {
      const anchor = comment.anchor;
      if (anchor.kind !== "page-area") continue;
      const size: PageSize | undefined = sizes[anchor.page - 1];
      if (!size) continue;
      try {
        images.set(comment.id, await renderer.crop(pdf, anchor.page, size, anchor.rect));
      } catch (error) {
        bb.log.warn(`crop for ${comment.id}: ${String(error)}`);
      }
    }
    return images;
  }

  /** Saves crops next to the plugin data so an agent can open them by path. */
  async function saveCrops(images: Map<string, Buffer>): Promise<Map<string, string>> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = path.join(dataDir, "crops");
    await mkdir(dir, { recursive: true });
    const paths = new Map<string, string>();
    for (const [id, bytes] of images) {
      const file = path.join(dir, `${id}.png`);
      await writeFile(file, bytes);
      paths.set(id, file);
    }
    return paths;
  }

  function pickComments(docId: string, ids: string[] | undefined): ReviewComment[] {
    const all = store.listComments(docId);
    const chosen = ids
      ? all.filter((comment) => ids.includes(comment.id))
      : all.filter((comment) => comment.status === "draft");
    if (chosen.length === 0) throw new Error("There are no draft comments to send.");
    return chosen;
  }

  bb.rpc.register(rpcContract, {
    async "doc.open"({ path: rawPath, source, remember }) {
      const kind = docKindFor(rawPath);
      if (!kind) {
        throw new Error("Doc Review opens Markdown, PDF, Word, PowerPoint, and Excel files.");
      }
      const { absPath, hostId } = await files.resolve(rawPath, source);
      const doc = store.upsertDoc(hostId, absPath, kind);
      const dto = toDto(doc, await currentVersion(doc));
      if (remember) await rememberDocument(doc);
      return { doc: dto };
    },

    async "doc.get"({ docId }) {
      const doc = requireDoc(docId);
      return { doc: toDto(doc, await currentVersion(doc)) };
    },

    async "docs.list"() {
      return {
        docs: store.listDocsWithCounts(100).map((doc) => ({
          id: doc.id,
          kind: doc.kind,
          name: path.posix.basename(doc.absPath),
          absPath: doc.absPath,
          hostId: doc.hostId,
          counts: doc.counts,
          lastActivity: doc.lastActivity,
        })),
      };
    },

    async "doc.version"({ docId }) {
      return { version: await files.version(requireDoc(docId)) };
    },

    async "doc.markdown"({ docId }) {
      const doc = requireDoc(docId);
      if (doc.kind !== "md") throw new Error("Not a Markdown file.");
      const version = await currentVersion(doc);
      const [content, assetBaseUrl] = await Promise.all([
        files.readText(doc),
        files.assetBaseUrl(doc),
      ]);
      return { version, content, assetBaseUrl };
    },

    async "doc.pages"({ docId }) {
      const doc = requireDoc(docId);
      const version = await currentVersion(doc);
      let pdf: string;
      try {
        pdf = await pdfFor(doc);
      } catch (error) {
        if (error instanceof NeedsLibreOfficeError) {
          return { status: "needs-libreoffice" as const, ...error.missing, platform: serverPlatform() };
        }
        throw error;
      }
      const sizes = await renderer.pageSizes(doc.id, version, pdf);
      const base = `/api/v1/plugins/${bb.pluginId}/http${PAGE_ROUTE}`;
      const v = encodeURIComponent(version);
      return {
        status: "ready" as const,
        version,
        pages: sizes.map((size, index) => ({
          n: index + 1,
          width: size.width,
          height: size.height,
          url: `${base}?doc=${doc.id}&v=${v}&n=${index + 1}`,
        })),
      };
    },

    async "doc.pageText"({ docId, version, n }) {
      const doc = requireDoc(docId);
      const current = await currentVersion(doc);
      if (current !== version) throw new Error("The file changed; reload it.");
      const pdf = await pdfFor(doc);
      const page = await renderer.pageText(doc.id, current, pdf, n);
      return { n, lines: page.lines };
    },

    async "doc.links"({ docId }) {
      const doc = requireDoc(docId);
      const download = await viewer.mintLink(located(doc));
      if (doc.kind === "pdf") return { document: download, download };
      if (doc.kind === "text" || doc.kind === "presentation") {
        try {
          return { document: await viewer.mintLink({ absPath: await pdfFor(doc), hostId: null }), download };
        } catch (error) {
          if (error instanceof NeedsLibreOfficeError) return { document: null, download };
          throw error;
        }
      }
      return { document: null, download };
    },

    async "sheet.open"({ docId, locale }) {
      const doc = requireDoc(docId);
      if (doc.kind !== "spreadsheet") throw new Error("Not a spreadsheet.");
      const version = await currentVersion(doc);
      return await viewer.withWorkbook(located(doc), normalizeLocale(locale), async (reader) => ({
        version,
        workbook: reader.summary,
        sheet: await reader.readSheet(reader.summary.activeSheet),
        fidelity: reader.fidelity,
      }));
    },

    async "sheet.read"({ docId, index, locale }) {
      const doc = requireDoc(docId);
      return await viewer.withWorkbook(located(doc), normalizeLocale(locale), async (reader) => {
        if (index >= reader.summary.sheets.length) throw new Error("This workbook has no such sheet.");
        return { sheet: await reader.readSheet(index) };
      });
    },

    async hosts() {
      const hosts = await bb.sdk.hosts.list();
      return { hosts: hosts.map((host) => ({ id: host.id, name: host.name, status: host.status })) };
    },

    async browse({ hostId, path: directory }) {
      const targetHost = hostId ?? (await defaultHostId());
      const listing = await bb.sdk.hosts.directory({
        hostId: targetHost,
        ...(directory ? { path: directory } : {}),
      });
      const openable = (name: string) =>
        isSupportedPath(name) ||
        (MARKDOWN_EXTENSIONS as readonly string[]).some((extension) => name.toLowerCase().endsWith(`.${extension}`));
      return {
        hostId: targetHost,
        directory: listing.directory,
        parent: listing.parent,
        entries: listing.entries
          .filter((entry) => entry.kind === "directory" || openable(entry.name))
          .sort((left, right) =>
            left.kind !== right.kind ? (left.kind === "directory" ? -1 : 1) : left.name.localeCompare(right.name),
          ),
      };
    },

    async recents() {
      return { recents: await readRecents() };
    },

    async "recents.clear"() {
      await bb.storage.kv.set(RECENTS_KEY, []);
      return { recents: [] };
    },

    async "comments.list"({ docId }) {
      requireDoc(docId);
      return { comments: store.listComments(docId) };
    },

    async "comments.create"({ docId, anchor, body, docVersion }) {
      requireDoc(docId);
      const comment = store.createComment({ docId, anchor, body, docVersion });
      publish([docId]);
      return comment;
    },

    async "comments.update"({ id, body }) {
      const existing = store.getComment(id);
      if (!existing) throw new Error("This comment was deleted.");
      const comment = store.updateBody(id, body);
      publish([existing.doc.id]);
      return comment;
    },

    async "comments.delete"({ id }) {
      const existing = store.getComment(id);
      const deleted = store.deleteComment(id);
      if (existing) publish([existing.doc.id]);
      return { deleted };
    },

    async "comments.reopen"({ id }) {
      const existing = store.getComment(id);
      if (!existing) throw new Error("This comment was deleted.");
      const comment = store.reopen(id);
      publish([existing.doc.id]);
      return comment;
    },

    async "comments.send"({ docId, ids, target }) {
      const doc = requireDoc(docId);
      const comments = pickComments(docId, ids);

      // Resolve where the message goes before doing any work.
      let projectId: string | null = null;
      let sourceThreadId: string | null = null;
      if (target.kind === "thread") {
        const thread = await bb.sdk.threads.get({ threadId: target.threadId });
        projectId = thread.projectId;
      } else {
        sourceThreadId = target.sourceThreadId;
        projectId = target.projectId;
        if (!projectId && sourceThreadId) {
          projectId = (await bb.sdk.threads.get({ threadId: sourceThreadId })).projectId;
        }
        if (!projectId) throw new Error(NO_PROJECT);
      }

      // Area comments carry a crop of the page. Attach them as images when
      // bb accepts the upload; otherwise point the agent at a saved file.
      const crops = await areaImages(doc, comments);
      const imageNumbers = new Map<string, number>();
      const imageInputs: { type: "localImage"; path: string }[] = [];
      const unattached = new Map<string, Buffer>();
      for (const comment of comments) {
        const bytes = crops.get(comment.id);
        if (!bytes) continue;
        try {
          const uploaded = await bb.sdk.projects.attachments.upload({
            projectId,
            clientFile: new Uint8Array(bytes),
            filename: `${comment.id}.png`,
            mimeType: "image/png",
          });
          imageInputs.push({ type: "localImage", path: uploaded.path });
          imageNumbers.set(comment.id, imageInputs.length);
        } catch (error) {
          bb.log.warn(`attachment upload for ${comment.id}: ${String(error)}`);
          unattached.set(comment.id, bytes);
        }
      }
      const imagePaths = await saveCrops(unattached);

      const text = buildHandoffMessage({
        kind: doc.kind,
        absPath: doc.absPath,
        comments,
        imageNumbers,
        imagePaths,
      });
      const input = [{ type: "text" as const, text, mentions: [] }, ...imageInputs];

      let threadId: string;
      if (target.kind === "thread") {
        await bb.sdk.threads.send({ threadId: target.threadId, mode: "auto", input });
        threadId = target.threadId;
      } else {
        // Reuse the model and workspace of the thread the panel was opened in.
        type SpawnArgs = Parameters<typeof bb.sdk.threads.spawn>[0];
        const execution: Partial<
          Pick<SpawnArgs, "providerId" | "model" | "reasoningLevel" | "permissionMode">
        > = {};
        let environmentId = target.environmentId;
        if (sourceThreadId) {
          const source = await bb.sdk.threads.get({ threadId: sourceThreadId });
          environmentId ??= source.environmentId;
          execution.providerId = source.providerId;
          const options = await bb.sdk.threads
            .defaultExecutionOptions({ threadId: sourceThreadId })
            .catch(() => null);
          if (options) {
            execution.model = options.model;
            execution.reasoningLevel = options.reasoningLevel;
            execution.permissionMode = options.permissionMode;
          }
        }
        const created = await bb.sdk.threads.spawn({
          projectId,
          environment: environmentId
            ? { type: "reuse", environmentId }
            : { type: "project-default" },
          input,
          title: `Review: ${path.posix.basename(doc.absPath)}`,
          ...execution,
        });
        threadId = created.id;
      }

      const sent = store.markSent(
        comments.map((comment) => comment.id),
        threadId,
      );
      publish([docId]);
      return { threadId, sent };
    },

    async "comments.handoffPrompt"({ docId, ids }) {
      const doc = requireDoc(docId);
      const comments = pickComments(docId, ids);
      const imagePaths = await saveCrops(await areaImages(doc, comments));
      const prompt = buildHandoffMessage({
        kind: doc.kind,
        absPath: doc.absPath,
        comments,
        imageNumbers: new Map(),
        imagePaths,
      });
      return { prompt, ids: comments.map((comment) => comment.id) };
    },

    async "comments.markSent"({ ids, threadId }) {
      const docIds = new Set<string>();
      for (const id of ids) {
        const comment = store.getComment(id);
        if (comment) docIds.add(comment.doc.id);
      }
      const sent = store.markSent(ids, threadId);
      publish([...docIds]);
      return { sent };
    },
  });

  bb.cli.register(reviewCli({ bb, store, onChanged: publish }));
}
