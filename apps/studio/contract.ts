/** Portable, browser-safe Studio contracts. Files are canonical; adapters
 * must reject unknown major versions and require revisions for mutations. */
import { z } from "zod";
export const FORMAT_VERSION = 2 as const;
export const PROTOCOL_VERSION = 1 as const;
const manifestSchema = z
  .object({
    format: z.literal("demohunter.studio"),
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
      .object({
        tour: z.string(),
        config: z.string().optional(),
        /** SHA-256 of the tour file when captured; lets a library show that
         * the source tour changed after recording. Optional and additive. */
        tourSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const legacyFormatSchema = manifestSchema.extend({
  formatVersion: z.literal(1),
});
export const bundledFormatSchema = manifestSchema.extend({
  formatVersion: z.literal(2),
  capture: z
    .object({
      file: z.literal("capture.dhcapture"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
});
export const formatSchema = z.discriminatedUnion("formatVersion", [
  legacyFormatSchema,
  bundledFormatSchema,
]);
export type StudioFormat = z.infer<typeof formatSchema>;
export const contract = {
  format: "demohunter.studio",
  formatVersion: FORMAT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  manifest: "studio.json",
  schemas: "schemas/",
  content:
    "project.json, edits.json, narration.json, comments.json, overrides.css",
  immutable:
    "capture.dhcapture (ZIP: events.json, elements.json, assets/); v1 loose captures remain readable",
  times:
    "Clip ranges use source milliseconds; narration offsets and effects use output milliseconds.",
  concurrency:
    "Content revisions are opaque hashes. UI/MCP mutations require expectedRevision. On conflict reread and merge. Direct file writers use atomic replacement and coordinate writes; runtime state never changes content revisions.",
  compatibility:
    "v2 uses a checksummed capture bundle. v1 loose projects remain readable; studio pack migrates explicitly and preserves event bytes and element refs. Unknown versions fail without rewriting.",
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
