import { z } from "zod";
import {
  isScene,
  sampleAnimation,
  clipDuration,
  totalDuration,
  outputToSource,
  sceneAt,
  sourceToOutput,
  clipStart,
  narrationStart,
  narrationRequestKey,
  audioIsCurrent,
  voiceSpans,
  musicGain,
} from "./timeline-math.js";
export {
  isScene,
  sampleAnimation,
  clipDuration,
  totalDuration,
  outputToSource,
  sceneAt,
  sourceToOutput,
  clipStart,
  narrationStart,
  narrationRequestKey,
  audioIsCurrent,
  voiceSpans,
  musicGain,
} from "./timeline-math.js";

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
    provider: z.enum(["openai", "elevenlabs", "kokoro"]),
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
export const recordingClipSchema = z
  .object({
    id,
    kind: z.literal("recording").optional(),
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
/** An HTML scene in the sequence (intro, outro, chapter card). Its page is a
 * pure function of time: Studio seeks its animations on every frame. */
export const sceneClipSchema = z
  .object({
    id,
    kind: z.literal("scene"),
    src: relativePath,
    durationMs: ms.positive().max(120_000),
    title: z.string().optional(),
  })
  .strict();
export const clipSchema = z.union([sceneClipSchema, recordingClipSchema]);
const overlaySchema = z
  .object({
    id,
    src: relativePath,
    startMs: ms,
    endMs: ms,
    title: z.string().optional(),
    // Blur/dim the recording under the overlay (eased in and out).
    backdrop: z
      .object({
        blur: z.number().finite().min(0).max(40).default(0),
        dim: z.number().finite().min(0).max(1).default(0),
        easeMs: ms.max(3000).default(450),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((o) => o.endMs > o.startMs, "Overlay end must be after start.");
const volume = z.number().finite().min(0).max(1);
export const audioSchema = z
  .object({
    music: z
      .array(
        z
          .object({
            id,
            src: relativePath,
            startMs: ms.default(0),
            endMs: ms.optional(),
            offsetMs: ms.default(0),
            volume: volume.default(0.3),
            fadeInMs: ms.default(800),
            fadeOutMs: ms.default(1500),
            // Gain multiplier while narration plays.
            duck: volume.default(0.35),
          })
          .strict(),
      )
      .default([]),
    sfx: z
      .array(
        z
          .object({
            id,
            src: relativePath,
            atMs: ms,
            volume: volume.default(0.7),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const targetSchema = z
  .object({
    ref: id.optional(),
    nodeId: z.number().int().positive().optional(),
    selector: z.string().min(1).optional(),
    documentId: z.number().int().positive().optional(),
    scene: relativePath
      .refine((p) => p.startsWith("scenes/"), "Use a scene file under scenes/.")
      .optional(),
  })
  .strict()
  .refine(
    (t) =>
      [t.ref, t.nodeId, t.selector].filter((v) => v !== undefined).length === 1,
    "Choose exactly one ref, nodeId or selector.",
  )
  .refine(
    (t) => !t.scene || (!!t.selector && t.documentId === undefined),
    "Scene targets need a selector, without a recording document ID.",
  );
export const elementTransformSchema = z
  .object({
    x: z.number().finite().min(-100000).max(100000).default(0),
    y: z.number().finite().min(-100000).max(100000).default(0),
    scaleX: z.number().finite().min(0.05).max(20).default(1),
    scaleY: z.number().finite().min(0.05).max(20).default(1),
  })
  .strict();
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
            transform: elementTransformSchema.optional(),
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
            // Ease in/out duration; slow push-ins read as camera moves.
            easeMs: ms.max(5000).optional(),
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
    overlays: z.array(overlaySchema).optional(),
    audio: audioSchema.optional(),
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
export type RecordingClip = z.infer<typeof recordingClipSchema>;
export type SceneClip = z.infer<typeof sceneClipSchema>;
export type Overlay = NonNullable<ReplayEdits["overlays"]>[number];
export type ReplayAudio = z.infer<typeof audioSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Animation = NonNullable<ReplayEdits["animations"]>[number];
export type ReplayBundle = {
  project: ReplayProject;
  edits: ReplayEdits;
  narration: ReplayNarration;
  css: string;
  comments: ReplayComments;
  revision: string;
  /** Like `revision`, without scene pages and audio: exactly what history
   * snapshots, so undo can tell tracked from outside changes. */
  contentRevision?: string;
  /** Changes only when scene pages or audio files change. */
  assetsRevision?: string;
  /** Changes only when scene pages change (visuals, thumbnails). */
  scenesRevision?: string;
  /** Per-file stamp of scenes/ and audio/ files, so one changed file
   * reloads only itself. */
  assetStamps?: Record<string, string>;
};


export function validateBundle(value: {
  project: unknown;
  edits: unknown;
  narration: unknown;
  css: string;
  comments?: unknown;
  revision?: string;
  contentRevision?: string;
  assetsRevision?: string;
  scenesRevision?: string;
  assetStamps?: Record<string, string>;
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
    ["overlays", edits.overlays ?? []],
    ["music", edits.audio?.music ?? []],
    ["sfx", edits.audio?.sfx ?? []],
    ["comments", comments.threads],
  ] as const) {
    if (new Set(entries.map((e) => e.id)).size !== entries.length)
      throw new Error(`Duplicate id in ${name}.`);
  }
  if (
    edits.clips.some(
      (clip) => !isScene(clip) && clip.sourceEndMs > project.durationMs + 1,
    )
  )
    throw new Error("A clip extends beyond the captured duration.");
  // Narration anchored to a deleted clip is intentionally omitted from playback.
  return {
    project,
    edits,
    narration,
    css: value.css,
    comments,
    revision: value.revision ?? "",
    contentRevision: value.contentRevision,
    assetsRevision: value.assetsRevision,
    scenesRevision: value.scenesRevision,
    assetStamps: value.assetStamps,
  };
}

