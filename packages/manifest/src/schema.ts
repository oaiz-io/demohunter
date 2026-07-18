import { z } from "zod";

export const PORTABLE_OUTPUT_MANIFEST_V1_VERSION = 1;
export const PORTABLE_OUTPUT_MANIFEST_V2_VERSION = 2;
/** Current legacy manifest version. Kept for source compatibility with v1 consumers. */
export const PORTABLE_OUTPUT_MANIFEST_VERSION = PORTABLE_OUTPUT_MANIFEST_V1_VERSION;

const portableChecksumSchema = z
  .object({
    algorithm: z.literal("sha256"),
    byteSize: z.int().nonnegative(),
    hex: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const portableArtifactDescriptorSchema = z
  .object({
    path: z.string().min(1),
    mediaType: z.string().min(1),
    checksum: portableChecksumSchema,
  })
  .strict();

const portableRelativePathSchema = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\\")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "Artifact paths must be safe output-root-relative POSIX paths.");

const flexibleArtifactDescriptorSchema = portableArtifactDescriptorSchema.extend({
  path: portableRelativePathSchema,
}).strict();

const portableAudioPathSchema = portableRelativePathSchema.refine(
  (value) => value.startsWith("audio/") && value.length > "audio/".length,
  "Audio artifact paths must stay under audio/.",
);

const timelineChapterSchema = z
  .object({
    title: z.string().min(1),
    startMs: z.int().nonnegative(),
  })
  .strict();

const timelineNarrationSchema = z
  .object({
    cacheKey: z.string().min(1),
    text: z.string().min(1),
    chapterTitle: z.string().min(1).optional(),
    startMs: z.int().nonnegative(),
    endMs: z.int().nonnegative(),
    durationMs: z.int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => value.endMs >= value.startMs && value.durationMs === value.endMs - value.startMs,
    {
      message: "Narration timing must be internally consistent.",
    },
  );

const literalArtifactDescriptor = (artifactPath: string) =>
  portableArtifactDescriptorSchema.extend({
    path: z.literal(artifactPath),
  });

const audioArtifactDescriptorSchema = portableArtifactDescriptorSchema
  .extend({
    path: portableAudioPathSchema,
    cacheKey: z.string().min(1),
    durationMs: z.int().nonnegative(),
  })
  .strict();

export const portableOutputManifestV1Schema = z
  .object({
    manifestVersion: z.literal(PORTABLE_OUTPUT_MANIFEST_V1_VERSION),
    tour: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
      })
      .strict(),
    playback: z
      .object({
        durationMs: z.int().nonnegative(),
      })
      .strict(),
    artifacts: z
      .object({
        videos: z
          .object({
            mp4: literalArtifactDescriptor("video.mp4"),
            webm: literalArtifactDescriptor("video.webm").optional(),
          })
          .strict(),
        poster: literalArtifactDescriptor("poster.jpg")
          .extend({
            captureTimestampMs: z.int().nonnegative(),
          })
          .strict(),
        captions: z
          .object({
            srt: literalArtifactDescriptor("captions.srt"),
            vtt: literalArtifactDescriptor("captions.vtt"),
          })
          .strict(),
        chapters: literalArtifactDescriptor("chapters.json"),
        audio: z.array(audioArtifactDescriptorSchema),
      })
      .strict(),
    timeline: z
      .object({
        chapters: z.array(timelineChapterSchema),
        narrations: z.array(timelineNarrationSchema),
      })
      .strict(),
  })
  .strict();

const portableAudioArtifactV2Schema = flexibleArtifactDescriptorSchema.extend({
  cacheKey: z.string().min(1),
  durationMs: z.int().nonnegative(),
}).strict();

export const portableOutputVariantV2Schema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  language: z.string().min(1).optional(),
  preset: z.enum(["standard", "square", "mobile"]),
  width: z.int().positive(),
  height: z.int().positive(),
  playback: z.object({
    durationMs: z.int().nonnegative(),
  }).strict(),
  artifacts: z.object({
    videos: z.object({
      mp4: flexibleArtifactDescriptorSchema,
      webm: flexibleArtifactDescriptorSchema.optional(),
    }).strict(),
    gif: flexibleArtifactDescriptorSchema.optional(),
    poster: flexibleArtifactDescriptorSchema.extend({
      captureTimestampMs: z.int().nonnegative(),
    }).strict(),
    captions: z.object({
      srt: flexibleArtifactDescriptorSchema,
      vtt: flexibleArtifactDescriptorSchema,
    }).strict(),
    chapters: flexibleArtifactDescriptorSchema,
    audio: z.array(portableAudioArtifactV2Schema),
  }).strict(),
  features: z.object({
    captionsBurnedIn: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const portableOutputManifestV2Schema = z.object({
  manifestVersion: z.literal(PORTABLE_OUTPUT_MANIFEST_V2_VERSION),
  tour: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
  }).strict(),
  defaultVariantId: z.string().min(1),
  variants: z.array(portableOutputVariantV2Schema).min(1),
  timeline: z.object({
    chapters: z.array(timelineChapterSchema),
    narrations: z.array(timelineNarrationSchema),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>();
  for (const variant of manifest.variants) {
    if (ids.has(variant.id)) {
      context.addIssue({ code: "custom", message: `Duplicate variant id: ${variant.id}` });
    }
    ids.add(variant.id);
  }
  if (!ids.has(manifest.defaultVariantId)) {
    context.addIssue({ code: "custom", message: "defaultVariantId must reference a variant" });
  }
});

/** @deprecated Use portableOutputManifestV1Schema or portableOutputManifestV2Schema explicitly. */
export const portableOutputManifestSchema = portableOutputManifestV1Schema;

const portableOutputManifestUnionSchema = z.discriminatedUnion("manifestVersion", [
  portableOutputManifestV1Schema,
  portableOutputManifestV2Schema,
]);

export type PortableChecksum = z.infer<typeof portableChecksumSchema>;
export type PortableArtifactDescriptor = z.infer<typeof portableArtifactDescriptorSchema>;
export type PortableOutputManifestV1 = z.infer<typeof portableOutputManifestV1Schema>;
export type PortableOutputVariantV2 = z.infer<typeof portableOutputVariantV2Schema>;
export type PortableOutputManifestV2 = z.infer<typeof portableOutputManifestV2Schema>;
export type PortableOutputManifest = PortableOutputManifestV1 | PortableOutputManifestV2;

export function parsePortableOutputManifest(value: unknown): PortableOutputManifest {
  return portableOutputManifestUnionSchema.parse(value);
}
