// `bb doc-review` — how agents read review comments and report back.
import path from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliRegistration,
} from "@get-bb/plugin-sdk";
import { CLI_NAME } from "./message.js";
import type { CommentWithDoc, ReviewStore } from "./store.js";
import { anchorLabel, anchorQuote, truncate, type CommentStatus } from "./types.js";

const STATUSES = ["draft", "sent", "replied", "resolved"] as const;
const LIST_LIMIT = 200;
const NOTE_MAX = 2000;

function formatComment(comment: CommentWithDoc): string {
  const quote = anchorQuote(comment.anchor);
  const lines = [
    `${comment.id}  #${comment.seq}  [${comment.status}]  ${anchorLabel(comment.anchor, comment.doc.kind)}`,
  ];
  if (quote) lines.push(`  quote: «${truncate(quote, 300)}»`);
  lines.push(`  comment: ${truncate(comment.body, 1000)}`);
  if (comment.agentNote) lines.push(`  note: ${truncate(comment.agentNote, 500)}`);
  return lines.join("\n");
}

function groupByFile(comments: CommentWithDoc[]): string {
  const groups = new Map<string, CommentWithDoc[]>();
  for (const comment of comments) {
    const key = comment.doc.hostId
      ? `${comment.doc.absPath} (host ${comment.doc.hostId})`
      : comment.doc.absPath;
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }
  return [...groups.entries()]
    .map(([file, items]) => [`${file}`, ...items.map(formatComment)].join("\n"))
    .join("\n\n");
}

function publicComment(comment: CommentWithDoc) {
  return {
    id: comment.id,
    seq: comment.seq,
    status: comment.status,
    file: comment.doc.absPath,
    hostId: comment.doc.hostId,
    kind: comment.doc.kind,
    location: anchorLabel(comment.anchor, comment.doc.kind),
    anchor: comment.anchor,
    body: comment.body,
    agentNote: comment.agentNote,
    sentThreadId: comment.sentThreadId,
  };
}

export function reviewCli(options: {
  bb: BbPluginApi;
  store: ReviewStore;
  onChanged: (docIds: string[]) => void;
}): PluginCliRegistration {
  const { store, onChanged } = options;

  function requireComment(id: string): CommentWithDoc {
    const comment = store.getComment(id.trim());
    if (!comment) {
      throw new PluginCliError(`No review comment with id ${id}.`, {
        code: "comment_not_found",
        hint: `Run \`bb ${CLI_NAME} list\` to see ids.`,
      });
    }
    return comment;
  }

  function checkNote(note: string | undefined, required: boolean): string | null {
    const trimmed = note?.trim() ?? "";
    if (!trimmed) {
      if (required) {
        throw new PluginCliError("--note is required.", {
          code: "missing_required",
          hint: 'Add --note "…" with the answer or reason.',
        });
      }
      return null;
    }
    if (trimmed.length > NOTE_MAX) {
      throw new PluginCliError(`--note is longer than ${NOTE_MAX} characters.`, {
        code: "invalid_value",
      });
    }
    return trimmed;
  }

  return defineCli({
    name: CLI_NAME,
    summary: "Read review comments left on files in the Doc Review panel and report fixes",
    description:
      "Comments are left on Markdown, PDF, and PPTX files in bb's Doc Review panel and handed to an agent. Close each handled comment with `resolve`, or answer with `reply` when it cannot be applied.",
    commands: {
      list: cliCommand({
        summary: "List review comments (default: the ones sent to this thread and still waiting)",
        options: {
          file: {
            type: "string",
            description: "Only comments on this file (absolute, or relative to the current directory)",
            aliases: ["path"],
          },
          status: {
            type: "enum",
            values: [...STATUSES, "all"],
            default: "sent",
            description: "Filter by status: draft, sent, replied, resolved, or all",
          },
          "all-threads": {
            type: "boolean",
            description: "Include comments sent to other threads (default: only this thread's when run inside one)",
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input, ctx) {
          const statuses: CommentStatus[] =
            input.options.status === "all" ? [...STATUSES] : [input.options.status as CommentStatus];
          let docIds: string[] | undefined;
          if (input.options.file) {
            const absolute = path.posix.isAbsolute(input.options.file)
              ? path.posix.normalize(input.options.file)
              : path.posix.resolve(ctx.cwd ?? "/", input.options.file);
            docIds = store.findDocsByPath(absolute).map((doc) => doc.id);
          }
          const restrictToThread =
            !input.options["all-threads"] &&
            !input.options.file &&
            input.options.status === "sent" &&
            ctx.threadId
              ? ctx.threadId
              : null;
          const comments = store.queryComments({
            statuses,
            threadId: restrictToThread,
            ...(docIds ? { docIds } : {}),
            limit: LIST_LIMIT,
          });
          if (input.options.json) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ comments: comments.map(publicComment) }),
            };
          }
          if (comments.length === 0) {
            return {
              exitCode: 0,
              stdout: restrictToThread
                ? "No comments are waiting for this thread. Add --all-threads to see every thread."
                : "No matching comments.",
            };
          }
          const more = comments.length === LIST_LIMIT ? `\n\n(showing the first ${LIST_LIMIT})` : "";
          return { exitCode: 0, stdout: groupByFile(comments) + more };
        },
      }),
      show: cliCommand({
        summary: "Show one comment in full",
        positionals: [{ name: "id", description: "Comment id, like c_ab12cd34", required: true }],
        options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
        async run(input) {
          const comment = requireComment(input.positionals.id);
          if (input.options.json) {
            return { exitCode: 0, stdout: JSON.stringify(publicComment(comment)) };
          }
          const quote = anchorQuote(comment.anchor);
          const text = [
            `${comment.id}  #${comment.seq}  [${comment.status}]`,
            `file: ${comment.doc.absPath}`,
            `location: ${anchorLabel(comment.anchor, comment.doc.kind)}`,
            ...(quote ? [`quote: «${quote}»`] : []),
            `comment: ${comment.body}`,
            ...(comment.agentNote ? [`note: ${comment.agentNote}`] : []),
          ].join("\n");
          return { exitCode: 0, stdout: text };
        },
      }),
      resolve: cliCommand({
        summary: "Mark comments as done, with a one-line note on what changed",
        positionals: [
          { name: "ids", description: "One or more comment ids", required: true, variadic: true },
        ],
        options: {
          note: {
            type: "string",
            description: `What you changed, shown to the user next to the comment (max ${NOTE_MAX} chars)`,
            aliases: ["message"],
            short: "m",
            stdin: true,
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input) {
          const note = checkNote(input.options.note, false);
          const comments = input.positionals.ids.map(requireComment);
          const resolved = comments.map((comment) => store.resolve(comment.id, note));
          onChanged([...new Set(comments.map((comment) => comment.doc.id))]);
          if (input.options.json) {
            return { exitCode: 0, stdout: JSON.stringify({ resolved: resolved.map((c) => c.id) }) };
          }
          return {
            exitCode: 0,
            stdout: `Resolved ${resolved.map((c) => `${c.id} (#${c.seq})`).join(", ")}.`,
          };
        },
      }),
      reply: cliCommand({
        summary: "Answer a comment without resolving it (a question or why it was not applied)",
        positionals: [{ name: "id", description: "Comment id", required: true }],
        options: {
          note: {
            type: "string",
            required: true,
            description: `The answer shown to the user (max ${NOTE_MAX} chars)`,
            aliases: ["message"],
            short: "m",
            stdin: true,
          },
          json: { type: "boolean", description: "Emit machine-readable JSON" },
        },
        async run(input) {
          const note = checkNote(input.options.note, true)!;
          const comment = requireComment(input.positionals.id);
          const replied = store.reply(comment.id, note);
          onChanged([comment.doc.id]);
          if (input.options.json) {
            return { exitCode: 0, stdout: JSON.stringify({ replied: replied.id }) };
          }
          return { exitCode: 0, stdout: `Replied on ${replied.id} (#${replied.seq}).` };
        },
      }),
    },
  });
}
