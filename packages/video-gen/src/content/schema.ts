import { z } from "zod";

import { isValidTourId } from "../util/slug.js";

export const CONTENT_SPEC_VERSION = 1 as const;

const DISPLAY_TEXT_MAX = 200;
const NARRATION_MAX = 2_000;
const CODE_MAX = 4_000;
const PARAGRAPH_MAX = 1_500;
const BULLET_ITEM_MAX = 300;
const BULLET_ITEMS_MAX = 12;
const SLIDES_MAX = 20;
const BODY_ELEMENTS_MAX = 12;

const trimmedNonEmpty = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max);

export const DurationSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?(?:s|m)$/, "duration must look like 90s or 3m");

export const ParagraphBodySchema = z
  .object({
    type: z.literal("paragraph"),
    text: trimmedNonEmpty(PARAGRAPH_MAX),
  })
  .passthrough();

export const BulletListBodySchema = z
  .object({
    type: z.literal("bullet_list"),
    items: z
      .array(trimmedNonEmpty(BULLET_ITEM_MAX))
      .min(1)
      .max(BULLET_ITEMS_MAX),
  })
  .passthrough();

export const CodeBlockBodySchema = z
  .object({
    type: z.literal("code_block"),
    language: trimmedNonEmpty(40),
    code: trimmedNonEmpty(CODE_MAX),
  })
  .passthrough();

export const BodyElementSchema = z.discriminatedUnion("type", [
  ParagraphBodySchema,
  BulletListBodySchema,
  CodeBlockBodySchema,
]);

export const SlideSpecSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isValidTourId, "slide id must be a lowercase filesystem-safe slug"),
    heading: trimmedNonEmpty(DISPLAY_TEXT_MAX),
    body: z.array(BodyElementSchema).min(1).max(BODY_ELEMENTS_MAX),
    narration: trimmedNonEmpty(NARRATION_MAX),
    transition: z.enum(["fade", "slide-left", "slide-up", "zoom-in", "none"]),
  })
  .strict();

export const ContentSpecSchema = z
  .object({
    version: z.number().int().positive(),
    title: trimmedNonEmpty(DISPLAY_TEXT_MAX),
    duration: DurationSchema,
    slides: z.array(SlideSpecSchema).min(1).max(SLIDES_MAX),
  })
  .strict()
  .refine((s) => s.version === CONTENT_SPEC_VERSION, {
    message: `version must be ${CONTENT_SPEC_VERSION}`,
  });

export type ParagraphBody = z.infer<typeof ParagraphBodySchema>;
export type BulletListBody = z.infer<typeof BulletListBodySchema>;
export type CodeBlockBody = z.infer<typeof CodeBlockBodySchema>;
export type BodyElement = z.infer<typeof BodyElementSchema>;
export type SlideSpec = z.infer<typeof SlideSpecSchema>;
export type ContentSpec = z.infer<typeof ContentSpecSchema>;

export function serializeContentSpec(spec: ContentSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}
