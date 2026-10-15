/** Portable, browser-safe Studio v1 contracts. Files are canonical; adapters
 * must reject unknown major versions and require revisions for mutations. */
import { z } from "zod";
export const FORMAT_VERSION = 1 as const;
export const PROTOCOL_VERSION = 1 as const;
export const formatSchema = z
  .object({
    format: z.literal("demohunter.studio"),
    formatVersion: z.literal(FORMAT_VERSION),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    projectId: z.string().uuid(),
    captureId: z.string().regex(/^[a-f0-9]{16}$/),
    createdAt: z.string().datetime(),
    files: z
      .object({
        project: z.literal("project.json"),
        events: z.literal("events.json"),
        elements: z.literal("elements.json"),
        edits: z.literal("edits.json"),
        narration: z.literal("narration.json"),
        comments: z.literal("comments.json"),
        css: z.literal("overrides.css"),
      })
      .strict(),
    source: z
      .object({ tour: z.string(), config: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();
export type StudioFormat = z.infer<typeof formatSchema>;
export const contract = {
  format: "demohunter.studio",
  formatVersion: FORMAT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  manifest: "studio.json",
  schemas: "schemas/",
  content:
    "project.json, edits.json, narration.json, comments.json, overrides.css",
  immutable: "events.json, assets/, elements.json, sources/",
  times:
    "Clip ranges use source milliseconds; narration offsets and effects use output milliseconds.",
  concurrency:
    "Content revisions are opaque hashes. UI/MCP mutations require expectedRevision. On conflict reread and merge. Direct file writers use atomic replacement and coordinate writes; runtime state never changes content revisions.",
  compatibility:
    "Unknown major versions fail without rewriting. Legacy projects without studio.json remain readable and get a v1 manifest on first open. New optional features require explicit reader support; existing v1 field semantics cannot change.",
  activity:
    "Observed MCP tool operations only; no model reasoning. .studio runtime data is disposable and excluded from content revision/export.",
};
export const activitySchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  actor: z.string().max(100),
  tool: z.string(),
  label: z.string(),
  elementRef: z.string().optional(),
  segmentId: z.string().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  status: z.enum(["running", "succeeded", "failed", "interrupted"]),
  error: z.string().max(500).optional(),
});
export type AgentActivity = z.infer<typeof activitySchema>;
