import { z } from "zod";
import {
  elementTransformSchema,
  type ReplayEdits,
  type Target,
} from "./model.js";

export const elementPatchSchema = z
  .object({
    text: z.string().max(30000).nullable().optional(),
    hidden: z.boolean().optional(),
    style: z
      .record(z.string().min(1).max(100), z.string().max(4000).nullable())
      .optional(),
    transform: z
      .object({
        x: elementTransformSchema.shape.x.removeDefault().optional(),
        y: elementTransformSchema.shape.y.removeDefault().optional(),
        scaleX: elementTransformSchema.shape.scaleX.removeDefault().optional(),
        scaleY: elementTransformSchema.shape.scaleY.removeDefault().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    reset: z.boolean().optional(),
  })
  .strict();
export type ElementPatch = z.infer<typeof elementPatchSchema>;
export {
  effectiveElementEdit,
  elementKey,
  patchElement,
  type ElementEdit,
} from "./element-edit-core.js";
