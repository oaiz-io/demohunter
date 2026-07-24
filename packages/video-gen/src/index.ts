export { generateVideo } from "./api/index.js";
export type { GenerateVideoOptions, GenerateVideoResult } from "./api/index.js";

export {
  CONTENT_SPEC_VERSION,
  ContentSpecSchema,
  BodyElementSchema,
  SlideSpecSchema,
  serializeContentSpec,
} from "./content/schema.js";
export type {
  BodyElement,
  BulletListBody,
  CodeBlockBody,
  ContentSpec,
  ParagraphBody,
  SlideSpec,
} from "./content/schema.js";

export { DEFAULT_CONTENT_MODEL } from "./content/generator.js";

export { STYLE_PRESET_NAMES, VIDEO_GENERATION_PHASES } from "./pipeline/types.js";
export type {
  StylePresetName,
  VideoGenerationPhase,
  VideoGenerationProgressEvent,
} from "./pipeline/types.js";

export { VideoGenError, formatCliError, redactSecrets } from "./pipeline/errors.js";
export type { VideoGenErrorCode } from "./pipeline/errors.js";
