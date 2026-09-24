// RPC contract between the review panel (app.tsx) and the backend. app.tsx
// imports only its type, so zod never reaches the frontend bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SheetData } from "../lib/sheet-model.js";

const rectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  })
  .strict();

const MAX_QUOTE = 4000;

export const anchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("doc") }).strict(),
  z
    .object({
      kind: z.literal("md-text"),
      quote: z.string().min(1).max(MAX_QUOTE),
      prefix: z.string().max(200),
      suffix: z.string().max(200),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page-text"),
      page: z.number().int().min(1),
      quote: z.string().min(1).max(MAX_QUOTE),
      rects: z.array(rectSchema).min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page-area"),
      page: z.number().int().min(1),
      rect: rectSchema,
      text: z.string().max(MAX_QUOTE),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cell"),
      sheet: z.string().min(1).max(200),
      sheetIndex: z.number().int().min(0),
      ref: z.string().regex(/^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$/),
      text: z.string().max(MAX_QUOTE),
    })
    .strict(),
]);

const statusSchema = z.enum(["draft", "sent", "replied", "resolved"]);

export const commentSchema = z.object({
  id: z.string(),
  seq: z.number(),
  status: statusSchema,
  anchor: anchorSchema,
  body: z.string(),
  docVersion: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sentAt: z.number().nullable(),
  sentThreadId: z.string().nullable(),
  agentNote: z.string().nullable(),
  resolvedAt: z.number().nullable(),
});

const kindSchema = z.enum(["md", "pdf", "text", "presentation", "spreadsheet"]);

const docSchema = z.object({
  id: z.string(),
  kind: kindSchema,
  name: z.string(),
  absPath: z.string(),
  hostId: z.string().nullable(),
  version: z.string(),
});

export const openerSourceSchema = z
  .object({
    kind: z.enum(["host", "thread-storage", "workspace"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().nullable().optional(),
  })
  .strip();

const linkSchema = z.object({ url: z.string(), expiresAtMs: z.number() });

const needsLibreOfficeSchema = z.object({
  status: z.literal("needs-libreoffice"),
  /** The LibreOffice module this file needs. */
  component: z.enum(["writer", "impress"]),
  /** False when no LibreOffice was found at all. */
  installed: z.boolean(),
  /** The server's platform: install instructions are for that machine. */
  platform: z.enum(["linux", "darwin", "win32", "other"]),
});

const workbookSummarySchema = z.object({
  sheets: z.array(
    z.object({
      name: z.string(),
      hidden: z.boolean(),
      kind: z.enum(["worksheet", "chartsheet", "other"]),
    }),
  ),
  activeSheet: z.number().int(),
});

/**
 * The readers build the grid; validating up to 100k cells field by field on
 * every response would cost more than it protects.
 */
const sheetDataSchema = z.custom<SheetData>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { rows?: unknown }).rows),
);

/** BCP 47 tag from the browser; formats dates and numbers like Excel would there. */
const localeSchema = z.string().max(64).optional();

const recentSchema = z.object({
  path: z.string(),
  name: z.string(),
  hostId: z.string().nullable(),
  openedAtMs: z.number(),
});

const sendTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("new-thread"),
      /** The thread the panel is open in, if any: its project and model are reused. */
      sourceThreadId: z.string().nullable(),
      projectId: z.string().nullable(),
      environmentId: z.string().nullable(),
    })
    .strict(),
]);

const BODY_MAX = 8000;

export const rpcContract = defineRpcContract({
  "doc.open": {
    input: z
      .object({
        path: z.string().min(1),
        source: openerSourceSchema,
        /** Add it to the Doc Review page's recent files. */
        remember: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ doc: docSchema }),
  },
  "doc.get": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ doc: docSchema }),
  },
  "docs.list": {
    input: z.null(),
    output: z.object({
      docs: z.array(
        z.object({
          id: z.string(),
          kind: kindSchema,
          name: z.string(),
          absPath: z.string(),
          hostId: z.string().nullable(),
          counts: z.object({
            draft: z.number(),
            sent: z.number(),
            replied: z.number(),
            resolved: z.number(),
          }),
          lastActivity: z.number(),
        }),
      ),
    }),
  },
  "doc.version": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ version: z.string().nullable() }),
  },
  "doc.markdown": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({
      version: z.string(),
      content: z.string(),
      /** Base URL that serves files next to the document, for relative images. */
      assetBaseUrl: z.string().nullable(),
    }),
  },
  "doc.pages": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("ready"),
        version: z.string(),
        pages: z.array(
          z.object({
            n: z.number(),
            width: z.number(),
            height: z.number(),
            url: z.string(),
          }),
        ),
      }),
      needsLibreOfficeSchema,
    ]),
  },
  /** URLs for the classic PDF view (null when there is no PDF) and the original file. */
  "doc.links": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ document: linkSchema.nullable(), download: linkSchema }),
  },
  "sheet.open": {
    input: z.object({ docId: z.string(), locale: localeSchema }).strict(),
    output: z.object({
      version: z.string(),
      workbook: workbookSummarySchema,
      sheet: sheetDataSchema,
      /** "basic" when only values and fills could be read. */
      fidelity: z.enum(["full", "basic"]),
    }),
  },
  "sheet.read": {
    input: z
      .object({ docId: z.string(), index: z.number().int().min(0), locale: localeSchema })
      .strict(),
    output: z.object({ sheet: sheetDataSchema }),
  },
  hosts: {
    input: z.null(),
    output: z.object({
      hosts: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.enum(["connected", "disconnected"]),
        }),
      ),
    }),
  },
  browse: {
    input: z
      .object({
        hostId: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({
      hostId: z.string(),
      directory: z.string(),
      parent: z.string().nullable(),
      entries: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          kind: z.enum(["directory", "file"]),
        }),
      ),
    }),
  },
  recents: {
    input: z.null(),
    output: z.object({ recents: z.array(recentSchema) }),
  },
  "recents.clear": {
    input: z.null(),
    output: z.object({ recents: z.array(recentSchema) }),
  },
  "doc.pageText": {
    input: z
      .object({
        docId: z.string(),
        version: z.string(),
        n: z.number().int().min(1),
      })
      .strict(),
    output: z.object({
      n: z.number(),
      lines: z.array(
        z.array(
          z.tuple([z.number(), z.number(), z.number(), z.number(), z.string()]),
        ),
      ),
    }),
  },
  "comments.list": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ comments: z.array(commentSchema) }),
  },
  "comments.create": {
    input: z
      .object({
        docId: z.string(),
        anchor: anchorSchema,
        body: z.string().trim().min(1).max(BODY_MAX),
        docVersion: z.string().nullable(),
      })
      .strict(),
    output: commentSchema,
  },
  "comments.update": {
    input: z
      .object({ id: z.string(), body: z.string().trim().min(1).max(BODY_MAX) })
      .strict(),
    output: commentSchema,
  },
  "comments.delete": {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  "comments.reopen": {
    input: z.object({ id: z.string() }).strict(),
    output: commentSchema,
  },
  "comments.send": {
    input: z
      .object({
        docId: z.string(),
        /** Omit to send every draft of the document. */
        ids: z.array(z.string()).max(500).optional(),
        target: sendTargetSchema,
      })
      .strict(),
    output: z.object({ threadId: z.string(), sent: z.number() }),
  },
  "comments.handoffPrompt": {
    input: z
      .object({ docId: z.string(), ids: z.array(z.string()).max(500).optional() })
      .strict(),
    output: z.object({ prompt: z.string(), ids: z.array(z.string()) }),
  },
  "comments.markSent": {
    input: z
      .object({ ids: z.array(z.string()).min(1).max(500), threadId: z.string().nullable() })
      .strict(),
    output: z.object({ sent: z.number() }),
  },
});

export type RpcContract = typeof rpcContract;
export type ViewerLink = z.infer<typeof linkSchema>;
export type NeedsLibreOffice = z.infer<typeof needsLibreOfficeSchema>;
export type WorkbookSummary = z.infer<typeof workbookSummarySchema>;
export type RecentDocument = z.infer<typeof recentSchema>;
