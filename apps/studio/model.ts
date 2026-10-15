import { z } from "zod";

const ms = z.number().finite().nonnegative();
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p
        .split("/")
        .some((part) => part === ".." || part === "." || part === ""),
    "Use a project-relative path without traversal.",
  );
const voiceSettings = z
  .object({
    stability: z.number().optional(),
    similarityBoost: z.number().optional(),
    style: z.number().optional(),
    useSpeakerBoost: z.boolean().optional(),
    speed: z.number().optional(),
  })
  .strict();
export const ttsSchema = z
  .object({
    provider: z.enum(["openai", "elevenlabs"]),
    model: z.string().min(1),
    voice: z.string().min(1),
    format: z.string().min(1),
    instructions: z.string(),
    language: z.string().optional(),
    voiceSettings: voiceSettings.optional(),
  })
  .strict();
export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    title: z.string().min(1),
    viewport: z
      .object({
        width: z.number().int().min(100).max(8192),
        height: z.number().int().min(100).max(8192),
      })
      .strict(),
    durationMs: ms.positive(),
    createdAt: z.string(),
    tts: ttsSchema,
    capture: z
      .object({
        eventCount: z.number().int().nonnegative(),
        assetCount: z.number().int().nonnegative(),
        warnings: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export const clipSchema = z
  .object({
    id,
    sourceStartMs: ms,
    sourceEndMs: ms,
    rate: z.number().finite().min(0.1).max(10).default(1),
    holdMs: ms.default(0),
  })
  .strict()
  .refine(
    (clip) => clip.sourceEndMs > clip.sourceStartMs,
    "Clip end must be after start.",
  );
export const targetSchema = z
  .object({
    ref: id.optional(),
    nodeId: z.number().int().positive().optional(),
    selector: z.string().min(1).optional(),
    documentId: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (t) =>
      [t.ref, t.nodeId, t.selector].filter((v) => v !== undefined).length === 1,
    "Choose exactly one ref, nodeId or selector.",
  );
export const editsSchema = z
  .object({
    clips: z.array(clipSchema).min(1),
    elements: z
      .array(
        z
          .object({
            id,
            target: targetSchema,
            text: z.string().optional(),
            hidden: z.boolean().optional(),
            style: z.record(z.string(), z.string()).optional(),
          })
          .strict(),
      )
      .default([]),
    camera: z
      .array(
        z
          .object({
            id,
            startMs: ms,
            endMs: ms,
            target: targetSchema.optional(),
            scale: z.number().finite().min(1).max(4),
            x: z.number().finite().optional(),
            y: z.number().finite().optional(),
          })
          .strict()
          .refine(
            (e) => e.endMs > e.startMs,
            "Camera end must be after start.",
          ),
      )
      .default([]),
    highlights: z
      .array(
        z
          .object({
            id,
            startMs: ms,
            endMs: ms,
            target: targetSchema,
            color: z.string().default("#a3e635"),
            padding: ms.default(8),
          })
          .strict()
          .refine(
            (e) => e.endMs > e.startMs,
            "Highlight end must be after start.",
          ),
      )
      .default([]),
    animations: z
      .array(
        z
          .object({
            id,
            target: targetSchema,
            startMs: ms,
            endMs: ms,
            from: z
              .object({
                opacity: z.number().min(0).max(1).optional(),
                x: z.number().finite().optional(),
                y: z.number().finite().optional(),
                scale: z.number().min(0.01).max(10).optional(),
                rotate: z.number().finite().optional(),
              })
              .strict(),
            to: z
              .object({
                opacity: z.number().min(0).max(1).optional(),
                x: z.number().finite().optional(),
                y: z.number().finite().optional(),
                scale: z.number().min(0.01).max(10).optional(),
                rotate: z.number().finite().optional(),
              })
              .strict(),
            easing: z.enum(["linear", "ease-in-out"]).default("ease-in-out"),
            fill: z.enum(["none", "forwards"]).default("none"),
          })
          .strict()
          .refine(
            (e) => e.endMs > e.startMs,
            "Animation end must be after start.",
          ),
      )
      .optional(),
  })
  .strict();
export const narrationSchema = z
  .object({
    segments: z.array(
      z
        .object({
          id,
          title: z.string().optional(),
          clipId: id,
          offsetMs: ms.default(0),
          text: z.string(),
          voice: z.string().optional(),
          model: z.string().optional(),
          instructions: z.string().optional(),
          language: z.string().optional(),
          audio: z
            .object({
              path: relativePath,
              durationMs: ms,
              cacheKey: z.string(),
              requestKey: z.string(),
              origin: z.enum(["provider", "local-demo"]).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const commentsSchema = z
  .object({
    threads: z.array(
      z
        .object({
          id,
          elementRef: id.optional(),
          timeMs: ms,
          body: z.string().trim().min(1).max(10000),
          author: z.string().trim().min(1).max(100),
          status: z.enum(["open", "resolved"]),
          createdAt: z.string(),
          updatedAt: z.string(),
          replies: z
            .array(
              z
                .object({
                  id,
                  body: z.string().trim().min(1).max(10000),
                  author: z.string().trim().min(1).max(100),
                  createdAt: z.string(),
                })
                .strict(),
            )
            .default([]),
        })
        .strict(),
    ),
  })
  .strict();
export type ReplayComments = z.infer<typeof commentsSchema>;

export type ReplayProject = z.infer<typeof projectSchema>;
export type ReplayEdits = z.infer<typeof editsSchema>;
export type ReplayNarration = z.infer<typeof narrationSchema>;
export type NarrationSegment = ReplayNarration["segments"][number];
export type Clip = z.infer<typeof clipSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Animation = NonNullable<ReplayEdits["animations"]>[number];
export function sampleAnimation(
  effect: Animation,
  outputMs: number,
):
  | { opacity: number; x: number; y: number; scale: number; rotate: number }
  | undefined {
  if (
    outputMs < effect.startMs ||
    (outputMs >= effect.endMs && effect.fill !== "forwards")
  )
    return undefined;
  let t = Math.max(
    0,
    Math.min(1, (outputMs - effect.startMs) / (effect.endMs - effect.startMs)),
  );
  if (effect.easing === "ease-in-out") t = t * t * (3 - 2 * t);
  const result = { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0 };
  for (const key of Object.keys(result) as (keyof typeof result)[])
    result[key] =
      (effect.from[key] ?? result[key]) +
      ((effect.to[key] ?? result[key]) - (effect.from[key] ?? result[key])) * t;
  return result;
}
export type ReplayBundle = {
  project: ReplayProject;
  edits: ReplayEdits;
  narration: ReplayNarration;
  css: string;
  comments: ReplayComments;
  revision: string;
};

export function clipDuration(clip: Clip): number {
  return (clip.sourceEndMs - clip.sourceStartMs) / clip.rate + clip.holdMs;
}
export function totalDuration(edits: ReplayEdits): number {
  return edits.clips.reduce((sum, clip) => sum + clipDuration(clip), 0);
}
export function outputToSource(edits: ReplayEdits, outputMs: number): number {
  let remaining = Math.max(0, outputMs);
  for (const clip of edits.clips) {
    const duration = clipDuration(clip);
    if (remaining < duration)
      return Math.min(
        clip.sourceEndMs,
        clip.sourceStartMs + remaining * clip.rate,
      );
    remaining -= duration;
  }
  return edits.clips.at(-1)!.sourceEndMs;
}
export function sourceToOutput(
  edits: ReplayEdits,
  sourceMs: number,
): number | undefined {
  let output = 0;
  for (const clip of edits.clips) {
    if (sourceMs >= clip.sourceStartMs && sourceMs <= clip.sourceEndMs)
      return output + (sourceMs - clip.sourceStartMs) / clip.rate;
    output += clipDuration(clip);
  }
  return undefined;
}
export function clipStart(
  edits: ReplayEdits,
  clipId: string,
): number | undefined {
  let time = 0;
  for (const clip of edits.clips) {
    if (clip.id === clipId) return time;
    time += clipDuration(clip);
  }
  return undefined;
}
export function narrationStart(
  edits: ReplayEdits,
  segment: NarrationSegment,
): number | undefined {
  const start = clipStart(edits, segment.clipId);
  return start === undefined ? undefined : start + segment.offsetMs;
}
// Identical in Node and browser; a request identity, not a cryptographic checksum.
export function narrationRequestKey(
  project: ReplayProject,
  segment: NarrationSegment,
): string {
  return JSON.stringify({
    text: segment.text,
    ...project.tts,
    voice: segment.voice ?? project.tts.voice,
    model: segment.model ?? project.tts.model,
    instructions: segment.instructions ?? project.tts.instructions,
    language: segment.language ?? project.tts.language,
  });
}
export function audioIsCurrent(
  project: ReplayProject,
  segment: NarrationSegment,
): boolean {
  return segment.audio?.requestKey === narrationRequestKey(project, segment);
}

export function validateBundle(value: {
  project: unknown;
  edits: unknown;
  narration: unknown;
  css: string;
  comments?: unknown;
  revision?: string;
}): ReplayBundle {
  const project = projectSchema.parse(value.project);
  const edits = editsSchema.parse(value.edits);
  const narration = narrationSchema.parse(value.narration);
  const comments = commentsSchema.parse(value.comments ?? { threads: [] });
  for (const [name, entries] of [
    ["clips", edits.clips],
    ["elements", edits.elements],
    ["camera", edits.camera],
    ["highlights", edits.highlights],
    ["narration", narration.segments],
    ["animations", edits.animations ?? []],
    ["comments", comments.threads],
  ] as const) {
    if (new Set(entries.map((e) => e.id)).size !== entries.length)
      throw new Error(`Duplicate id in ${name}.`);
  }
  if (edits.clips.some((clip) => clip.sourceEndMs > project.durationMs + 1))
    throw new Error("A clip extends beyond the captured duration.");
  // Narration anchored to a deleted clip is intentionally omitted from playback.
  return {
    project,
    edits,
    narration,
    css: value.css,
    comments,
    revision: value.revision ?? "",
  };
}
