// The wire contract between the sidebar page, the in-thread controls and the
// server. The app imports only its types; the schemas run on the server.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NAME_MAX } from "./lib/links";

const idSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "Expected a Claude Design project id",
  );
/** bb ids (`proj_*`, `thr_*`) are opaque here; bounded, never parsed. */
const bbIdSchema = z.string().trim().min(1).max(200);

/** A saved project as the page, the CLI and the agent see it. */
export const designProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    bbProjectId: z.string().nullable(),
    /** Null when the linked bb project no longer exists. */
    bbProjectName: z.string().nullable(),
    isDefault: z.boolean(),
    addedAt: z.string(),
    linkedAt: z.string().nullable(),
  })
  .strict();
export type DesignProject = z.infer<typeof designProjectSchema>;

export const bbProjectSchema = z
  .object({ id: z.string(), name: z.string() })
  .strict();
export type BbProject = z.infer<typeof bbProjectSchema>;

/** Where a thread or composer sits, and the Claude Design project it opens. */
export const contextSchema = z
  .object({
    /** Null when the thread is unknown or the scope has no project. */
    bbProject: bbProjectSchema.nullable(),
    /** False for bb's personal project, which cannot be linked. */
    linkable: z.boolean(),
    project: designProjectSchema.nullable(),
  })
  .strict();
export type DesignContext = z.infer<typeof contextSchema>;

export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({ projects: z.array(designProjectSchema) }).strict(),
  },
  bb_projects: {
    input: z.null(),
    output: z.object({ projects: z.array(bbProjectSchema) }).strict(),
  },
  /** Saves a project by link or id; an existing one only gets the new name. */
  add: {
    input: z
      .object({
        ref: z.string().trim().min(1).max(2048),
        name: z.string().max(NAME_MAX * 4).nullable(),
        bbProjectId: bbIdSchema.nullable(),
        makeDefault: z.boolean(),
      })
      .strict(),
    output: designProjectSchema,
  },
  link: {
    input: z
      .object({ id: idSchema, bbProjectId: bbIdSchema, makeDefault: z.boolean() })
      .strict(),
    output: designProjectSchema,
  },
  unlink: {
    input: z.object({ id: idSchema }).strict(),
    output: designProjectSchema,
  },
  set_default: {
    input: z.object({ id: idSchema }).strict(),
    output: designProjectSchema,
  },
  remove: {
    input: z.object({ id: idSchema }).strict(),
    output: z.object({ removed: designProjectSchema }).strict(),
  },
  context: {
    input: z
      .object({
        threadId: bbIdSchema.nullable(),
        projectId: bbIdSchema.nullable(),
      })
      .strict(),
    output: contextSchema,
  },
  /** How to send Claude's traffic from the Mac through this server. */
  route_info: {
    input: z.null(),
    output: z
      .object({
        target: z.string().nullable(),
        installCommand: z.string().nullable(),
        uninstallCommand: z.string(),
        domains: z.array(z.string()),
        /** Last time a Mac fetched the routing rule through its tunnel. */
        lastPacFetchAt: z.number().nullable(),
      })
      .strict(),
  },
  route_set_target: {
    input: z.object({ target: z.string().trim().max(255) }).strict(),
    output: z.object({ target: z.string().nullable() }).strict(),
  },
});
