// The byte route behind the viewer: streams one registered file — a PDF to
// read or an original to download — with range support so a browser's PDF
// viewer can jump to a page without pulling the whole file first.
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Context } from "hono";

import {
  contentDisposition,
  parseRange,
  type DocumentRegistry,
} from "./documents.js";

/** Path tail under /api/v1/plugins/pdf-viewer/http/. */
export const DOCUMENT_ROUTE = "/document";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

export function handleDocumentRequest(
  context: Context,
  registry: DocumentRegistry,
): Response {
  const id = context.req.query("id");
  if (!id) return jsonResponse(400, { error: "Missing document id." });

  const document = registry.resolve(id);
  if (!document) {
    return jsonResponse(404, { error: "This document link has expired." });
  }

  const range = parseRange(context.req.header("range"), document.sizeBytes);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${document.sizeBytes}` },
    });
  }

  const headers = new Headers({
    "content-type": document.contentType,
    "content-disposition": contentDisposition(document.name),
    "accept-ranges": "bytes",
    // The server's compress() middleware also runs for plugin routes; PDFs and
    // Office files are already compressed, and no-transform keeps
    // content-length intact.
    "cache-control": "private, no-store, no-transform",
    "x-content-type-options": "nosniff",
  });

  if (!range) {
    headers.set("content-length", String(document.sizeBytes));
    const stream = createReadStream(document.path);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers,
    });
  }

  headers.set("content-length", String(range.end - range.start + 1));
  headers.set(
    "content-range",
    `bytes ${range.start}-${range.end}/${document.sizeBytes}`,
  );
  const stream = createReadStream(document.path, {
    start: range.start,
    end: range.end,
  });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 206,
    headers,
  });
}
