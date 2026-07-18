import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_COOKIE_BANNER_CONFIG,
  type CookieBannerConfig,
  type DemoHunterTour,
  type ResolvedDemoHunterConfig,
} from "@demohunter/sdk";
import * as playwright from "playwright";
import type { BrowserType, Page } from "playwright";

import { attachDebugCapture } from "./debug/failure-artifacts.js";
import type { DebugCapture } from "./debug/failure-artifacts.js";
import type { GenerationProgressEvent, GenerationProgressReporter, TourRuntimeEvent } from "./execute/generator-types.js";
import { createSmokeLifecycleContext, createSmokeTourRuntime } from "./runtime/create-smoke-tour-runtime.js";
import {
  createCookieBannerMiddleware,
  type CookieBannerMiddleware,
} from "./middleware/cookie-banner-middleware.js";

export type SmokeGenerateInput = {
  loadedConfig: {
    projectRoot: string;
    configPath: string;
    config: ResolvedDemoHunterConfig;
  };
  tourFile: SmokeTourModule;
  onProgress?: GenerationProgressReporter;
  signal?: AbortSignal;
};

export type SmokeTourModule = {
  path: string;
  tour: DemoHunterTour;
};

export type SmokeGenerateResult = {
  outputPath: string;
};

export type SmokeGenerateProgressEvent = GenerationProgressEvent;

type BrowserTypeMap = Record<"chromium" | "firefox" | "webkit", Pick<BrowserType, "launch">>;

type SmokeGenerateDependencies = {
  attachDebugCapture: typeof attachDebugCapture;
  mkdir: typeof mkdir;
  now: () => Date;
  playwright: BrowserTypeMap;
  writeFile: typeof writeFile;
  createCookieBannerMiddleware: (config: CookieBannerConfig) => CookieBannerMiddleware;
};

const TOUR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const defaultDependencies: SmokeGenerateDependencies = {
  attachDebugCapture,
  mkdir,
  now: () => new Date(),
  playwright,
  writeFile,
  createCookieBannerMiddleware: (config) => createCookieBannerMiddleware({ config }),
};

export async function smokeGenerate(
  { loadedConfig, onProgress, signal, tourFile }: SmokeGenerateInput,
  dependencies: Partial<SmokeGenerateDependencies> = {},
): Promise<SmokeGenerateResult> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const { config } = loadedConfig;
  signal?.throwIfAborted();

  if (!TOUR_ID_PATTERN.test(tourFile.tour.id)) {
    throw new Error(`Tour id must be a lowercase filesystem-safe slug: ${tourFile.path}`);
  }

  const browserType = resolvedDependencies.playwright[config.browser];
  report(onProgress, {
    phase: "launching-browser",
    message: `Launching ${config.browser}`,
  });
  const browser = await browserType.launch();
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let primaryError: unknown;
  let debugCapture: DebugCapture | undefined;
  let lastRuntimeEvent: TourRuntimeEvent | undefined;

  try {
    context = await browser.newContext({
      baseURL: config.baseURL,
      viewport: config.viewport,
    });
    const page = await context.newPage();
    const cookieMiddleware = resolvedDependencies.createCookieBannerMiddleware(
      config.record.cookieBanners ?? DEFAULT_COOKIE_BANNER_CONFIG,
    );
    let middlewareArmed = false;
    const outputDir = path.join(config.outputDir, tourFile.tour.id);
    debugCapture = resolvedDependencies.attachDebugCapture({
      outputDir,
      page,
    });
    const runtime = createSmokeTourRuntime({
      afterNavigation: async () => {
        if (middlewareArmed) {
          await cookieMiddleware.afterNavigation(page);
        }
      },
      config,
      onEvent: (event) => {
        lastRuntimeEvent = event;
        reportRuntimeEvent(onProgress, event);
      },
      outputDir,
      page,
    });
    const lifecycleContext = createSmokeLifecycleContext(runtime);

    try {
      await abortable(page.goto(new URL(config.baseURL).href), signal);
      report(onProgress, {
        phase: "running-flow",
        message: `Validating ${tourFile.tour.id}`,
      });
      await abortable(Promise.resolve(tourFile.tour.setup?.(lifecycleContext)), signal);
      middlewareArmed = true;
      await abortable(cookieMiddleware.afterSetup(page), signal);
      await abortable(Promise.resolve(tourFile.tour.beforeRecord?.(lifecycleContext)), signal);
      await abortable(Promise.resolve(tourFile.tour.run(runtime)), signal);
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        await Promise.resolve(tourFile.tour.teardown?.(runtime));
      } catch (teardownError) {
        if (primaryError === undefined) {
          throw teardownError;
        }
      }

      if (primaryError !== undefined) {
        await captureSmokeDebugFailure({
          debugCapture,
          error: primaryError,
          lastRuntimeEvent,
          onProgress,
        });
        throw primaryError;
      }
    }

    const outputPath = path.join(outputDir, "smoke-run.json");

    report(onProgress, {
      phase: "writing-artifacts",
      message: `Writing ${path.relative(loadedConfig.projectRoot, outputPath)}`,
    });
    await resolvedDependencies.mkdir(outputDir, { recursive: true });
    await resolvedDependencies.writeFile(
      outputPath,
      JSON.stringify(
        {
          status: "ok",
          tourId: tourFile.tour.id,
          title: tourFile.tour.title,
          baseURL: config.baseURL,
          browser: config.browser,
          viewport: config.viewport,
          generatedAt: resolvedDependencies.now().toISOString(),
        },
        null,
        2,
      ),
    );

    report(onProgress, {
      phase: "completed",
      message: `Validated ${tourFile.tour.id}`,
    });

    return { outputPath };
  } catch (error) {
    primaryError ??= error;
    throw error;
  } finally {
    let closeError: unknown;

    try {
      debugCapture?.dispose();
      await context?.close();
    } catch (error) {
      closeError ??= error;
    }

    try {
      await browser.close();
    } catch (error) {
      closeError ??= error;
    }

    if (primaryError === undefined && closeError !== undefined) {
      throw closeError;
    }
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  signal.throwIfAborted();

  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function captureSmokeDebugFailure(input: {
  debugCapture: DebugCapture | undefined;
  error: unknown;
  lastRuntimeEvent?: TourRuntimeEvent;
  onProgress?: GenerationProgressReporter;
}): Promise<void> {
  if (input.debugCapture === undefined) {
    return;
  }

  report(input.onProgress, {
    phase: "capturing-debug",
    message: "Capturing debug artifacts for dry-run",
  });

  try {
    const result = await input.debugCapture.captureFailure({
      error: input.error,
      lastRuntimeEvent: input.lastRuntimeEvent,
      phase: "dry-run",
    });
    report(input.onProgress, {
      phase: "capturing-debug",
      message: `Wrote debug artifacts to ${result.directory}`,
    });
  } catch (error) {
    report(input.onProgress, {
      phase: "capturing-debug",
      message: `Could not capture debug artifacts: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function report(
  onProgress: GenerationProgressReporter | undefined,
  event: GenerationProgressEvent,
): void {
  onProgress?.(event);
}

function reportRuntimeEvent(
  onProgress: GenerationProgressReporter | undefined,
  event: TourRuntimeEvent,
): void {
  if (event.kind === "step-start") {
    report(onProgress, {
      phase: "runtime-event",
      message: `Step: ${event.title}`,
      runtimeEvent: event,
    });
    return;
  }

  if (event.kind === "chapter") {
    report(onProgress, {
      phase: "runtime-event",
      message: `Chapter: ${event.title}`,
      runtimeEvent: event,
    });
  }
}
