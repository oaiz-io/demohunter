import path from "node:path";

import type { Page } from "playwright";
import { DEFAULT_COOKIE_BANNER_CONFIG } from "@demohunter/sdk";
import type { NarrationProviderRegistry } from "@demohunter/tts-core";

import { resolveNarrationSegment as defaultResolveNarrationSegment } from "../narration/resolve-narration.js";
import {
  createCookieBannerMiddleware,
  type CookieBannerMiddleware,
} from "../middleware/cookie-banner-middleware.js";
import type { SmokeGenerateInput, SmokeTourModule } from "../smoke-generate.js";
import { createSmokeLifecycleContext, createSmokeTourRuntime } from "../runtime/create-smoke-tour-runtime.js";
import type {
  CollectedNarration,
  CollectedTimeline,
  CollectedTimelineEntry,
  GenerationProgressReporter,
  NarrationResolverContext,
  NarrationSegmentResolver,
  NarrationRuntimeEvent,
  TourRuntimeEvent,
} from "./generator-types.js";

export type CollectTimelineInput = {
  loadedConfig: SmokeGenerateInput["loadedConfig"];
  onBeforeRun?: () => Promise<void> | void;
  onRuntimeEvent?: (event: TourRuntimeEvent) => void;
  onProgress?: GenerationProgressReporter;
  page: Page;
  narrationRegistry?: NarrationProviderRegistry;
  signal?: AbortSignal;
  tourFile: SmokeTourModule;
  resolveNarrationSegment?: NarrationSegmentResolver;
  cookieMiddleware?: CookieBannerMiddleware;
};

export async function collectTimeline({
  loadedConfig,
  onBeforeRun,
  onRuntimeEvent,
  onProgress,
  page,
  narrationRegistry,
  signal,
  resolveNarrationSegment = (event, context) => {
    if (narrationRegistry === undefined) {
      throw new Error("A narration provider registry is required to resolve narration.");
    }
    return defaultResolveNarrationSegment({ event, loadedConfig, context, registry: narrationRegistry, signal });
  },
  cookieMiddleware = createCookieBannerMiddleware({
    config: loadedConfig.config.record.cookieBanners ?? DEFAULT_COOKIE_BANNER_CONFIG,
  }),
  tourFile,
}: CollectTimelineInput): Promise<CollectedTimeline> {
  signal?.throwIfAborted();
  const { config } = loadedConfig;
  const outputDir = path.join(config.outputDir, tourFile.tour.id);
  const events: TourRuntimeEvent[] = [];
  let middlewareArmed = false;
  const runtime = createSmokeTourRuntime({
    afterNavigation: async () => {
      if (middlewareArmed) {
        await cookieMiddleware.afterNavigation(page);
      }
    },
    config,
    onEvent: (event) => {
      events.push(event);
      onRuntimeEvent?.(event);
    },
    outputDir,
    page,
  });
  const lifecycleContext = createSmokeLifecycleContext(runtime);

  await abortable(page.goto(new URL(config.baseURL).href), signal);

  let primaryError: unknown;

  try {
    await abortable(Promise.resolve(tourFile.tour.setup?.(lifecycleContext)), signal);
    middlewareArmed = true;
    await abortable(cookieMiddleware.afterSetup(page), signal);
    await abortable(Promise.resolve(tourFile.tour.beforeRecord?.(lifecycleContext)), signal);
    await abortable(Promise.resolve(onBeforeRun?.()), signal);
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
      throw primaryError;
    }
  }

  return buildCollectedTimeline(events, loadedConfig, resolveNarrationSegment, onProgress, signal);
}

async function buildCollectedTimeline(
  events: TourRuntimeEvent[],
  loadedConfig: SmokeGenerateInput["loadedConfig"],
  resolveNarrationSegment: NarrationSegmentResolver,
  onProgress?: GenerationProgressReporter,
  signal?: AbortSignal,
): Promise<CollectedTimeline> {
  const entries: CollectedTimelineEntry[] = [];
  const narrations: CollectedTimeline["narrations"] = [];

  for (const [index, event] of events.entries()) {
    signal?.throwIfAborted();
    const order = index + 1;

    if (event.kind === "narrate") {
      onProgress?.({
        phase: "resolving-narration",
        message: `Resolving narration ${order}`,
        runtimeEvent: event,
      });
      const segment = await resolveNarrationSegment(
        event,
        buildNarrationResolverContext(events, index, loadedConfig, signal),
      );

      if (!Number.isFinite(segment.durationMs) || segment.durationMs < 0) {
        throw new Error(
          `Narration resolver must return a non-negative finite duration: ${segment.durationMs}`,
        );
      }

      const entry: CollectedNarration = {
        event,
        kind: "narration",
        order,
        segment,
      };

      entries.push(entry);
      narrations.push(segment);
      continue;
    }

    entries.push({
      event,
      kind: "event",
      order,
    });
  }

  return {
    entries,
    narrations,
  };
}

function buildNarrationResolverContext(
  events: TourRuntimeEvent[],
  index: number,
  loadedConfig: SmokeGenerateInput["loadedConfig"],
  signal?: AbortSignal,
): NarrationResolverContext | undefined {
  const event = events[index];

  if (event?.kind !== "narrate") {
    return undefined;
  }

  const context: NarrationResolverContext = {
    ...(signal === undefined ? {} : { signal }),
  };
  const previousNarration = findAdjacentNarration(events, index, -1);
  const nextNarration = findAdjacentNarration(events, index, 1);

  if (
    previousNarration !== undefined
    && narrationsUseSameResolvedIdentity(event, previousNarration, loadedConfig)
  ) {
    context.previousText = previousNarration.text;
  }

  if (
    nextNarration !== undefined
    && narrationsUseSameResolvedIdentity(event, nextNarration, loadedConfig)
  ) {
    context.nextText = nextNarration.text;
  }

  return context.previousText === undefined && context.nextText === undefined
    ? undefined
    : context;
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

function findAdjacentNarration(
  events: TourRuntimeEvent[],
  startIndex: number,
  direction: -1 | 1,
): NarrationRuntimeEvent | undefined {
  for (
    let index = startIndex + direction;
    index >= 0 && index < events.length;
    index += direction
  ) {
    const candidate = events[index];

    if (candidate.kind === "narrate") {
      return candidate;
    }
  }

  return undefined;
}

function narrationsUseSameResolvedIdentity(
  left: NarrationRuntimeEvent,
  right: NarrationRuntimeEvent,
  loadedConfig: SmokeGenerateInput["loadedConfig"],
): boolean {
  return JSON.stringify(resolveNarrationIdentity(left, loadedConfig))
    === JSON.stringify(resolveNarrationIdentity(right, loadedConfig));
}

function resolveNarrationIdentity(
  event: NarrationRuntimeEvent,
  loadedConfig: SmokeGenerateInput["loadedConfig"],
): Record<string, unknown> {
  const { tts } = loadedConfig.config;

  return {
    provider: tts.provider,
    model: event.model ?? tts.model,
    voice: event.voice ?? tts.voice,
    format: event.format ?? tts.format,
    language: normalizeOptionalString(event.language ?? tts.language),
    voiceSettings: sortPlainObject(
      event.voiceSettings ?? ("voiceSettings" in tts ? tts.voiceSettings : undefined),
    ),
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();

  return normalized === "" ? undefined : normalized;
}

function sortPlainObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortPlainObject);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortPlainObject(child)]),
  );
}
