import type { GenerationProgressEvent } from "@demohunter/generator-playwright";
import type { DemoHunterTour, ResolvedDemoHunterConfig } from "@demohunter/sdk";

import type { ContentSpec } from "../content/schema.js";

export const STYLE_PRESET_NAMES = ["minimal", "terminal", "notebook"] as const;
export type StylePresetName = (typeof STYLE_PRESET_NAMES)[number];

export const VIDEO_GENERATION_PHASES = [
  "preflight",
  "content",
  "render",
  "compile",
  "serve",
  "record",
  "cleanup",
  "complete",
] as const;

export type VideoGenerationPhase = (typeof VIDEO_GENERATION_PHASES)[number];

export type VideoGenerationProgressEvent = {
  phase: VideoGenerationPhase;
  message: string;
  detail?: GenerationProgressEvent;
};

export type GenerateVideoOptions = {
  prompt: string;
  style?: StylePresetName;
  outputDir?: string;
  model?: string;
  cleanup?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: VideoGenerationProgressEvent) => void;
};

export type GenerateVideoResult = {
  id: string;
  title: string;
  style: StylePresetName;
  workspaceDir: string;
  contentSpecPath: string;
  siteDir: string;
  tourPath: string;
  configPath: string;
  outputDir: string;
  videoPath: string;
  captionsSrtPath: string;
  captionsVttPath: string;
  chaptersPath: string;
  workspacePreserved: boolean;
};

export type RenderedSite = {
  html: string;
  css: string;
  javascript: string;
};

export type CompiledTour = {
  tourId: string;
  moduleSource: string;
  tour: DemoHunterTour;
};

export type GenerationWorkspace = {
  tourId: string;
  outputDir: string;
  workspaceDir: string;
  siteDir: string;
  contentSpecPath: string;
  tourPath: string;
  configPath: string;
  finalOutputDir: string;
  cacheDir: string;
};

export type PreflightCheckResult = {
  name: string;
  ok: boolean;
  message: string;
};

export type PreflightResult = {
  ok: boolean;
  checks: PreflightCheckResult[];
};

export type BridgeConfigData = {
  baseURL: string;
  outputDir: string;
  cacheDir: string;
  resolved: ResolvedDemoHunterConfig;
  configSource: string;
};

export type GenerateContentSpecInput = {
  prompt: string;
  model?: string;
  signal?: AbortSignal;
};

export type RenderLessonInput = {
  spec: ContentSpec;
  style: StylePresetName;
};

export type CompileTourInput = {
  spec: ContentSpec;
  tourId: string;
};
