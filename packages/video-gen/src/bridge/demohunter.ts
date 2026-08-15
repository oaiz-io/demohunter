import {
  DEFAULT_COOKIE_BANNER_CONFIG,
  DEFAULT_CURSOR_CONFIG,
  DEFAULT_DEMOHUNTER_CONFIG,
  DEFAULT_OUTPUT_CONFIG,
  DEFAULT_RECORD_CONFIG,
  DEFAULT_TTS_CONFIG,
  DEFAULT_VIEWPORT_CONFIG,
} from "@demohunter/sdk";
import type { DemoHunterTour, ResolvedDemoHunterConfig } from "@demohunter/sdk";
import {
  generateTour,
  type GenerateTourResult,
  type GenerationProgressEvent,
} from "@demohunter/generator-playwright";
import { access } from "node:fs/promises";
import path from "node:path";

import { VideoGenError } from "../pipeline/errors.js";
import type { BridgeConfigData, VideoGenerationProgressEvent } from "../pipeline/types.js";

export type DemoHunterBridgeInput = {
  baseURL: string;
  outputDir: string;
  cacheDir: string;
  configPath: string;
  projectRoot: string;
  tourPath: string;
  tour: DemoHunterTour;
  onProgress?: (event: VideoGenerationProgressEvent) => void;
};

export type DemoHunterBridgeDependencies = {
  generateTour?: typeof generateTour;
};

export function buildBridgeConfig(input: {
  baseURL: string;
  outputDir: string;
  cacheDir: string;
}): BridgeConfigData {
  const resolved: ResolvedDemoHunterConfig = {
    baseURL: input.baseURL,
    outputDir: path.resolve(input.outputDir),
    cacheDir: path.resolve(input.cacheDir),
    browser: DEFAULT_DEMOHUNTER_CONFIG.browser,
    viewport: DEFAULT_VIEWPORT_CONFIG,
    holdPaddingMs: DEFAULT_DEMOHUNTER_CONFIG.holdPaddingMs,
    record: {
      ...DEFAULT_RECORD_CONFIG,
      showChapters: false,
      cookieBanners: DEFAULT_COOKIE_BANNER_CONFIG,
      cursor: DEFAULT_CURSOR_CONFIG,
    },
    output: {
      formats: DEFAULT_OUTPUT_CONFIG.formats,
    },
    tts: DEFAULT_TTS_CONFIG,
  };

  return {
    baseURL: input.baseURL,
    outputDir: resolved.outputDir,
    cacheDir: resolved.cacheDir,
    resolved,
    configSource: renderConfigSource(resolved),
  };
}

export function renderConfigSource(config: ResolvedDemoHunterConfig): string {
  return `import { defineConfig } from "@demohunter/sdk";

export default defineConfig({
  baseURL: ${JSON.stringify(config.baseURL)},
  outputDir: ${JSON.stringify(config.outputDir)},
  cacheDir: ${JSON.stringify(config.cacheDir)},
  browser: ${JSON.stringify(config.browser)},
  viewport: ${JSON.stringify(config.viewport)},
  holdPaddingMs: ${JSON.stringify(config.holdPaddingMs)},
  record: {
    showActions: ${JSON.stringify(config.record.showActions)},
    showChapters: ${JSON.stringify(config.record.showChapters)},
    container: ${JSON.stringify(config.record.container)},
    format: ${JSON.stringify(config.record.format)},
    showCursor: ${JSON.stringify(config.record.showCursor)},
    showClickRipple: ${JSON.stringify(config.record.showClickRipple)},
    highlightStyle: ${JSON.stringify(config.record.highlightStyle)},
  },
  tts: {
    provider: ${JSON.stringify(config.tts.provider)},
    model: ${JSON.stringify(config.tts.model)},
    voice: ${JSON.stringify(config.tts.voice)},
    format: ${JSON.stringify(config.tts.format)},
  },
});
`;
}

export async function runDemoHunterBridge(
  input: DemoHunterBridgeInput,
  dependencies: DemoHunterBridgeDependencies = {},
): Promise<GenerateTourResult> {
  const generate = dependencies.generateTour ?? generateTour;
  const bridgeConfig = buildBridgeConfig({
    baseURL: input.baseURL,
    outputDir: input.outputDir,
    cacheDir: input.cacheDir,
  });

  try {
    const result = await generate({
      loadedConfig: {
        config: bridgeConfig.resolved,
        configPath: input.configPath,
        projectRoot: input.projectRoot,
      },
      tourFile: {
        path: input.tourPath,
        tour: input.tour,
      },
      onProgress: (event: GenerationProgressEvent) => {
        input.onProgress?.({
          phase: "record",
          message: event.message,
          detail: event,
        });
      },
    });

    const expectedOutputDir = path.resolve(input.outputDir, input.tour.id);
    if (path.resolve(result.outputDir) !== expectedOutputDir) {
      throw new VideoGenError(
        "DEMOHUNTER_FAILED",
        `DemoHunter wrote to unexpected output directory: ${result.outputDir}`,
      );
    }

    await access(result.videoPath);
    return result;
  } catch (error) {
    if (error instanceof VideoGenError) {
      throw error;
    }
    const phaseHint = extractPhaseHint(error);
    throw new VideoGenError(
      "DEMOHUNTER_FAILED",
      phaseHint === undefined
        ? error instanceof Error
          ? error.message
          : String(error)
        : `DemoHunter failed during ${phaseHint}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function extractPhaseHint(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const message = error.message.toLowerCase();
  for (const phase of [
    "collecting-timeline",
    "resolving-narration",
    "recording-replay",
    "muxing-video",
    "writing-artifacts",
  ]) {
    if (message.includes(phase)) {
      return phase;
    }
  }
  return undefined;
}
