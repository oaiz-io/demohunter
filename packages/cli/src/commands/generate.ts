import path from "node:path";

import { generateTour, smokeGenerate } from "@demohunter/generator-playwright";
import type { GenerationProgressEvent } from "@demohunter/generator-playwright";
import {
  DEFAULT_COOKIE_BANNER_CONFIG,
  DEFAULT_CURSOR_CONFIG,
  resolveOutputFormatRequests,
  type DemoHunterTour,
  type ResolvedDemoHunterConfig,
} from "@demohunter/sdk";

import { loadConfig } from "../config/load-config.js";
import { loadAuthoredModule } from "../utils/load-authored-module.js";

type TourModule = {
  default: unknown;
};

type GenerateDependencies = {
  generateTour: typeof generateTour;
  importModule: (modulePath: string) => Promise<TourModule>;
  loadConfig: typeof loadConfig;
  log: (message: string) => void;
  smokeGenerate: typeof smokeGenerate;
};

export type GenerateCommandOptions = {
  dryRun?: boolean;
  flowOnly?: boolean;
  cookieDismiss?: false | "reject" | "accept" | "hide";
  cursor?: "none" | "highlight" | "smooth" | "ripple";
  formats?: Array<{ preset: "standard" | "square" | "mobile" | "gif"; layout?: "fit" | "responsive"; durationMs?: number }>;
};

const defaultDependencies: GenerateDependencies = {
  generateTour,
  importModule: loadAuthoredModule,
  loadConfig,
  log: console.log,
  smokeGenerate,
};

export async function generateCommand(
  cwd: string,
  tourPath: string,
  optionsOrDependencies: GenerateCommandOptions | Partial<GenerateDependencies> = {},
  maybeDependencies: Partial<GenerateDependencies> = {},
): Promise<void> {
  const options = isGenerateCommandOptions(optionsOrDependencies) ? optionsOrDependencies : {};
  const dependencies = isGenerateCommandOptions(optionsOrDependencies)
    ? maybeDependencies
    : optionsOrDependencies;
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const resolvedTourPath = path.resolve(cwd, tourPath);
  let loadedConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;

  try {
    resolvedDependencies.log(formatProgress({ phase: "loading-config", message: "Loading demohunter.config.ts" }));
    loadedConfig = await resolvedDependencies.loadConfig(cwd);
    loadedConfig = {
      ...loadedConfig,
      config: applyGenerateOverrides(loadedConfig.config, options),
    };
    resolvedDependencies.log(formatProgress({ phase: "loading-tour", message: `Loading ${tourPath}` }));
    const tourModule = await resolvedDependencies.importModule(resolvedTourPath);
    const tourFile = {
      path: resolvedTourPath,
      tour: readTourDefaultExport(tourModule.default, resolvedTourPath),
    };
    const onProgress = (event: GenerationProgressEvent) => {
      resolvedDependencies.log(formatProgress(event));
    };

    if (options.dryRun || options.flowOnly) {
      const result = await resolvedDependencies.smokeGenerate({
        loadedConfig,
        onProgress,
        tourFile,
      });

      resolvedDependencies.log(`Validated flow: ${result.outputPath}`);
      return;
    }

    const result = await resolvedDependencies.generateTour({
      loadedConfig,
      onProgress,
      tourFile: {
        path: resolvedTourPath,
        tour: tourFile.tour,
      },
    });

    resolvedDependencies.log(`Generated video: ${result.videoPath}`);
  } catch (error) {
    throw improveGenerateError({
      cwd,
      error,
      loadedConfig,
    });
  }
}

function isGenerateCommandOptions(
  value: GenerateCommandOptions | Partial<GenerateDependencies>,
): value is GenerateCommandOptions {
  return "dryRun" in value || "flowOnly" in value || "cookieDismiss" in value || "cursor" in value || "formats" in value;
}

export function applyGenerateOverrides(
  config: ResolvedDemoHunterConfig,
  options: GenerateCommandOptions,
): ResolvedDemoHunterConfig {
  if (options.cookieDismiss === undefined && options.cursor === undefined && options.formats === undefined) {
    return config;
  }

  return {
    ...config,
    output: options.formats === undefined
      ? config.output
      : { formats: resolveOutputFormatRequests(options.formats) },
    record: {
      ...config.record,
      cookieBanners: options.cookieDismiss === undefined
        ? config.record.cookieBanners
        : {
            ...DEFAULT_COOKIE_BANNER_CONFIG,
            ...config.record.cookieBanners,
            enabled: options.cookieDismiss !== false,
            ...(options.cookieDismiss === false ? {} : { action: options.cookieDismiss }),
          },
      cursor: options.cursor === undefined
        ? config.record.cursor
        : resolveCursorOverride(options.cursor),
    },
  };
}

function resolveCursorOverride(
  preset: NonNullable<GenerateCommandOptions["cursor"]>,
): ResolvedDemoHunterConfig["record"]["cursor"] {
  if (preset === "none") {
    return false;
  }

  return {
    ...DEFAULT_CURSOR_CONFIG,
    mode: preset === "highlight" ? "highlight" : "smooth",
    ripple: preset === "ripple",
  };
}

function formatProgress(event: GenerationProgressEvent): string {
  return `[${new Date().toISOString()}] ${event.message}`;
}

type TourLike = DemoHunterTour & {
  beforeRecord?: unknown;
  setup?: unknown;
  teardown?: unknown;
};

function readTourDefaultExport(tourModule: unknown, tourPath: string): DemoHunterTour {
  if (!isTourShape(tourModule)) {
    throw new Error(
      `Tour file must default export an object with string id/title and a run function: ${tourPath}. Export a default tour like { id: "product-overview", title: "Product overview", async run(runtime) {} }.`,
    );
  }

  if (tourModule.setup !== undefined && typeof tourModule.setup !== "function") {
    throw new Error(
      `Tour file has invalid setup export; expected a function when provided: ${tourPath}. Keep setup as async setup(runtime) {} or remove it.`,
    );
  }

  if (tourModule.beforeRecord !== undefined && typeof tourModule.beforeRecord !== "function") {
    throw new Error(
      `Tour file has invalid beforeRecord export; expected a function when provided: ${tourPath}. Keep beforeRecord as async beforeRecord(runtime) {} or remove it.`,
    );
  }

  if (tourModule.teardown !== undefined && typeof tourModule.teardown !== "function") {
    throw new Error(
      `Tour file has invalid teardown export; expected a function when provided: ${tourPath}. Keep teardown as async teardown(runtime) {} or remove it.`,
    );
  }

  return tourModule;
}

function improveGenerateError(input: {
  cwd: string;
  error: unknown;
  loadedConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;
}): Error {
  if (!(input.error instanceof Error)) {
    return new Error(String(input.error));
  }

  const message = input.error.message;

  if (message.includes("Could not find demohunter.config.ts")) {
    return new Error(
      `${message}. Run "demohunter init" from an installed DemoHunter CLI, or add demohunter.config.ts before rerunning "demohunter generate".`,
      { cause: input.error },
    );
  }

  if (message.includes("Executable doesn't exist") || message.includes("playwright install")) {
    const browser = input.loadedConfig?.config.browser ?? "chromium";

    return new Error(
      `Playwright could not launch the local browser runtime for DemoHunter. Run "bun x playwright install ${browser}" and retry. DemoHunter does not install browsers automatically.`,
      { cause: input.error },
    );
  }

  if (
    message.includes("spawn ffmpeg ENOENT") ||
    message.includes("spawn ffprobe ENOENT") ||
    message.includes("ffmpeg ENOENT") ||
    message.includes("ffprobe ENOENT")
  ) {
    return new Error(
      'DemoHunter could not find ffmpeg/ffprobe on your PATH. Install ffmpeg, then confirm "ffmpeg -version" and "ffprobe -version" both work before retrying.',
      { cause: input.error },
    );
  }

  if (message.includes("OPENAI_API_KEY")) {
    return new Error(
      `Narration requires uncached OpenAI speech, but OPENAI_API_KEY is not set. Export OPENAI_API_KEY and retry, or rerun after the narration cache has already been populated.\nOriginal error: ${message}`,
      { cause: input.error },
    );
  }

  if (message.includes("ELEVENLABS_API_KEY")) {
    return new Error(
      `Narration requires uncached ElevenLabs speech, but ELEVENLABS_API_KEY is not set. Export ELEVENLABS_API_KEY and retry, or rerun after the narration cache has already been populated.\nOriginal error: ${message}`,
      { cause: input.error },
    );
  }

  if (isBaseUrlReachabilityError(message)) {
    const baseURL = input.loadedConfig?.config.baseURL ?? readFirstUrl(message) ?? "your configured baseURL";

    return new Error(
      `DemoHunter could not reach baseURL ${baseURL}. Start your app yourself, confirm that URL is reachable, and then rerun "demohunter generate".`,
      { cause: input.error },
    );
  }

  return input.error;
}

const BASE_URL_REACHABILITY_MARKERS = [
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_CONNECTION_RESET",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NETWORK_CHANGED",
] as const;

function isBaseUrlReachabilityError(message: string): boolean {
  return BASE_URL_REACHABILITY_MARKERS.some((marker) => message.includes(marker));
}

function readFirstUrl(message: string): string | undefined {
  return message.match(/https?:\/\/\S+/)?.[0];
}

function isTourShape(value: unknown): value is TourLike {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const maybeTour = value as Partial<TourLike>;
  return (
    typeof maybeTour.id === "string" &&
    typeof maybeTour.title === "string" &&
    typeof maybeTour.run === "function"
  );
}
