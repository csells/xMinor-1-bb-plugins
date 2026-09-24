// Review state in the plugin's own SQLite database: one row per reviewed
// document and one per comment. The file itself is never modified.
import { createHash, randomBytes } from "node:crypto";
import type { Anchor, CommentStatus, DocKind, ReviewComment } from "./types.js";

/** The subset of better-sqlite3 this module uses. */
export interface Db {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

/** Append-only: never edit or reorder a shipped statement. */
export const MIGRATIONS = [
  `CREATE TABLE docs (
     id TEXT PRIMARY KEY,
     host_id TEXT,
     abs_path TEXT NOT NULL,
     kind TEXT NOT NULL,
     next_seq INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE comments (
     id TEXT PRIMARY KEY,
     doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     status TEXT NOT NULL,
     anchor TEXT NOT NULL,
     body TEXT NOT NULL,
     doc_version TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     sent_at INTEGER,
     sent_thread_id TEXT,
     agent_note TEXT,
     resolved_at INTEGER
   )`,
  `CREATE INDEX comments_doc ON comments(doc_id, seq)`,
  `CREATE INDEX comments_status ON comments(status, sent_thread_id)`,
  // 0.2: PowerPoint joined Word and Excel under family names.
  `UPDATE docs SET kind = 'presentation' WHERE kind = 'pptx'`,
];

export interface DocRow {
  id: string;
  hostId: string | null;
  absPath: string;
  kind: DocKind;
}

interface RawDoc {
  id: string;
  host_id: string | null;
  abs_path: string;
  kind: DocKind;
}

interface RawComment {
  id: string;
  doc_id: string;
  seq: number;
  status: CommentStatus;
  anchor: string;
  body: string;
  doc_version: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  sent_thread_id: string | null;
  agent_note: string | null;
  resolved_at: number | null;
}

export interface CommentWithDoc extends ReviewComment {
  doc: DocRow;
}

/** Stable id for a file: the same path on the same host is the same doc. */
export function docIdFor(hostId: string | null, absPath: string): string {
  const digest = createHash("sha256")
    .update(`${hostId ?? ""}\u0000${absPath}`)
    .digest("hex");
  return `d_${digest.slice(0, 16)}`;
}

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function newCommentId(): string {
  const bytes = randomBytes(6);
  let id = "c_";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

function toDoc(raw: RawDoc): DocRow {
  return {
    id: raw.id,
    hostId: raw.host_id,
    absPath: raw.abs_path,
    kind: raw.kind,
  };
}

function toComment(raw: RawComment): ReviewComment {
  return {
    id: raw.id,
    seq: raw.seq,
    status: raw.status,
    anchor: JSON.parse(raw.anchor) as Anchor,
    body: raw.body,
    docVersion: raw.doc_version,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    sentAt: raw.sent_at,
    sentThreadId: raw.sent_thread_id,
    agentNote: raw.agent_note,
    resolvedAt: raw.resolved_at,
  };
}

export class ReviewStore {
  constructor(private readonly db: Db) {}

  upsertDoc(hostId: string | null, absPath: string, kind: DocKind): DocRow {
    const id = docIdFor(hostId, absPath);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO docs (id, host_id, abs_path, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at`,
      )
      .run(id, hostId, absPath, kind, now, now);
    return { id, hostId, absPath, kind };
  }

  getDoc(id: string): DocRow | null {
    const raw = this.db.prepare(`SELECT * FROM docs WHERE id = ?`).get(id) as
      | RawDoc
      | undefined;
    return raw ? toDoc(raw) : null;
  }

  findDocsByPath(absPath: string): DocRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM docs WHERE abs_path = ?`)
        .all(absPath) as RawDoc[]
    ).map(toDoc);
  }

  /** Documents that have comments, most recently active first. */
  listDocsWithCounts(limit: number): (DocRow & {
    counts: Record<CommentStatus, number>;
    lastActivity: number;
  })[] {
    const rows = this.db
      .prepare(
        `SELECT d.*,
           SUM(c.status = 'draft') AS draft,
           SUM(c.status = 'sent') AS sent,
           SUM(c.status = 'replied') AS replied,
           SUM(c.status = 'resolved') AS resolved,
           MAX(c.updated_at) AS last_activity
         FROM docs d JOIN comments c ON c.doc_id = d.id
         GROUP BY d.id ORDER BY last_activity DESC LIMIT ?`,
      )
      .all(limit) as (RawDoc & Record<CommentStatus, number> & { last_activity: number })[];
    return rows.map((row) => ({
      ...toDoc(row),
      counts: { draft: row.draft, sent: row.sent, replied: row.replied, resolved: row.resolved },
      lastActivity: row.last_activity,
    }));
  }

  listComments(docId: string): ReviewComment[] {
    return (
      this.db
        .prepare(`SELECT * FROM comments WHERE doc_id = ? ORDER BY seq`)
        .all(docId) as RawComment[]
    ).map(toComment);
  }

  getComment(id: string): CommentWithDoc | null {
    const raw = this.db.prepare(`SELECT * FROM comments WHERE id = ?`).get(id) as
      | RawComment
      | undefined;
    if (!raw) return null;
    const doc = this.getDoc(raw.doc_id);
    if (!doc) return null;
    return { ...toComment(raw), doc };
  }

  /** Comments across documents, newest documents first, for the CLI. */
  queryComments(filter: {
    statuses: CommentStatus[];
    threadId?: string | null;
    docIds?: string[];
    limit: number;
  }): CommentWithDoc[] {
    const clauses = [
      `status IN (${filter.statuses.map(() => "?").join(", ")})`,
    ];
    const params: unknown[] = [...filter.statuses];
    if (filter.threadId) {
      clauses.push(`sent_thread_id = ?`);
      params.push(filter.threadId);
    }
    if (filter.docIds) {
      if (filter.docIds.length === 0) return [];
      clauses.push(`doc_id IN (${filter.docIds.map(() => "?").join(", ")})`);
      params.push(...filter.docIds);
    }
    params.push(filter.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM comments WHERE ${clauses.join(" AND ")}
         ORDER BY doc_id, seq LIMIT ?`,
      )
      .all(...params) as RawComment[];
    const docs = new Map<string, DocRow | null>();
    const result: CommentWithDoc[] = [];
    for (const raw of rows) {
      if (!docs.has(raw.doc_id)) docs.set(raw.doc_id, this.getDoc(raw.doc_id));
      const doc = docs.get(raw.doc_id);
      if (doc) result.push({ ...toComment(raw), doc });
    }
    return result;
  }

  createComment(input: {
    docId: string;
    anchor: Anchor;
    body: string;
    docVersion: string | null;
  }): ReviewComment {
    const create = this.db.transaction(() => {
      const doc = this.db
        .prepare(`SELECT next_seq FROM docs WHERE id = ?`)
        .get(input.docId) as { next_seq: number } | undefined;
      if (!doc) throw new Error(`Unknown document ${input.docId}`);
      const id = newCommentId();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO comments (id, doc_id, seq, status, anchor, body, doc_version, created_at, updated_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.docId,
          doc.next_seq,
          JSON.stringify(input.anchor),
          input.body,
          input.docVersion,
          now,
          now,
        );
      this.db
        .prepare(`UPDATE docs SET next_seq = next_seq + 1 WHERE id = ?`)
        .run(input.docId);
      return id;
    });
    const id = create();
    return this.requireComment(id);
  }

  updateBody(id: string, body: string): ReviewComment {
    this.db
      .prepare(`UPDATE comments SET body = ?, updated_at = ? WHERE id = ?`)
      .run(body, Date.now(), id);
    return this.requireComment(id);
  }

  deleteComment(id: string): boolean {
    return this.db.prepare(`DELETE FROM comments WHERE id = ?`).run(id).changes > 0;
  }

  /** Back to draft so it can be edited and sent again; the agent note stays visible. */
  reopen(id: string): ReviewComment {
    this.db
      .prepare(
        `UPDATE comments SET status = 'draft', resolved_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    return this.requireComment(id);
  }

  markSent(ids: string[], threadId: string | null): number {
    const now = Date.now();
    const statement = this.db.prepare(
      `UPDATE comments SET status = 'sent', sent_at = ?, sent_thread_id = ?,
         agent_note = NULL, resolved_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
    const run = this.db.transaction(() => {
      let changed = 0;
      for (const id of ids) changed += statement.run(now, threadId, now, id).changes;
      return changed;
    });
    return run();
  }

  resolve(id: string, note: string | null): ReviewComment {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE comments SET status = 'resolved', agent_note = ?, resolved_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(note, now, now, id);
    return this.requireComment(id);
  }

  reply(id: string, note: string): ReviewComment {
    this.db
      .prepare(
        `UPDATE comments SET status = 'replied', agent_note = ?, resolved_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(note, Date.now(), id);
    return this.requireComment(id);
  }

  private requireComment(id: string): ReviewComment {
    const comment = this.getComment(id);
    if (!comment) throw new Error(`No comment with id ${id}`);
    const { doc: _doc, ...rest } = comment;
    return rest;
  }
}
