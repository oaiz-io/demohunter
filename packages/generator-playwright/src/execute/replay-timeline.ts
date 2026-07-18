import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DEFAULT_COOKIE_BANNER_CONFIG, type DemoHunterNarrateWhileTimeline } from "@demohunter/sdk";
import type { Page } from "playwright";

import type { SmokeGenerateInput, SmokeTourModule } from "../smoke-generate.js";
import {
  createCookieBannerMiddleware,
  createRecordingEffectsSuppressor,
  type CookieBannerMiddleware,
} from "../middleware/cookie-banner-middleware.js";
import { createDeterministicRecordingClickHandler } from "../overlays/recording-effects-control.js";
import { createSmokeLifecycleContext, createSmokeTourRuntime } from "../runtime/create-smoke-tour-runtime.js";
import type { SmokeRuntime } from "../runtime/create-smoke-tour-runtime.js";
import { resolveTypeTextAction } from "../runtime/type-text.js";
import type { CollectedTimeline, CollectedTimelineEntry, TourRuntimeEvent } from "./generator-types.js";

export type ReplayTimelineInput = {
  loadedConfig: SmokeGenerateInput["loadedConfig"];
  onBeforeRun?: () => Promise<void> | void;
  onMatchedEvent?: (event: TourRuntimeEvent, index: number) => void;
  onRuntimeEvent?: (event: TourRuntimeEvent) => void;
  page: Page;
  signal?: AbortSignal;
  timeline: CollectedTimeline;
  tourFile: SmokeTourModule;
  now?: () => number;
  waitForTimeout?: (durationMs: number) => Promise<void>;
  cookieMiddleware?: CookieBannerMiddleware;
};

type ReplayTimelineErrorCause = {
  actual?: TourRuntimeEvent;
  expected?: TourRuntimeEvent;
  index: number;
  reason: "extra-event" | "mismatch" | "missing-event";
};

export class ReplayTimelineError extends Error {
  override cause: ReplayTimelineErrorCause;

  constructor(message: string, cause: ReplayTimelineErrorCause) {
    super(message, { cause });
    this.name = "ReplayTimelineError";
    this.cause = cause;
  }
}

export async function replayTimeline({
  loadedConfig,
  onBeforeRun,
  onMatchedEvent,
  onRuntimeEvent,
  page,
  signal,
  timeline,
  tourFile,
  now = () => Date.now(),
  waitForTimeout,
  cookieMiddleware = createCookieBannerMiddleware({
    config: loadedConfig.config.record.cookieBanners ?? DEFAULT_COOKIE_BANNER_CONFIG,
    suppressActivity: createRecordingEffectsSuppressor(page, loadedConfig.config.record),
  }),
}: ReplayTimelineInput): Promise<void> {
  signal?.throwIfAborted();
  const { config } = loadedConfig;
  const outputDir = path.join(config.outputDir, tourFile.tour.id);
  const replayWait = waitForTimeout ?? ((durationMs: number) => page.waitForTimeout(durationMs));
  let nextExpectedIndex = 0;
  let pendingNarrationWaitMs: number | undefined;
  let middlewareArmed = false;
  const runtime = createReplayRuntime({
    afterNavigation: async () => {
      if (middlewareArmed) {
        await cookieMiddleware.afterNavigation(page);
      }
    },
    config,
    outputDir,
    now,
    page,
    replayWait,
    timeline,
    onMatchedEvent,
    onRuntimeEvent,
    updatePendingNarrationWait: (durationMs) => {
      pendingNarrationWaitMs = durationMs;
    },
    updateReplayPosition: () => {
      nextExpectedIndex += 1;
    },
    getReplayPosition: () => nextExpectedIndex,
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

    assertReplayComplete(timeline.entries, nextExpectedIndex);

    if (pendingNarrationWaitMs !== undefined) {
      pendingNarrationWaitMs = undefined;
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

function createReplayRuntime(args: {
  afterNavigation?: () => Promise<void>;
  config: ReplayTimelineInput["loadedConfig"]["config"];
  onMatchedEvent?: (event: TourRuntimeEvent, index: number) => void;
  onRuntimeEvent?: (event: TourRuntimeEvent) => void;
  outputDir: string;
  now: () => number;
  page: Page;
  replayWait: (durationMs: number) => Promise<void>;
  timeline: CollectedTimeline;
  getReplayPosition: () => number;
  updateReplayPosition: () => void;
  updatePendingNarrationWait: (durationMs: number | undefined) => void;
}): SmokeRuntime {
  const runtime = createSmokeTourRuntime({
    afterNavigation: args.afterNavigation,
    animateCursorTo: async (x, y, durationMs) => {
      await args.page.evaluate(
        async ({ cursorX, cursorY, motionDurationMs }) => {
          await window.__demohunterEffects?.moveCursorTo(cursorX, cursorY, motionDurationMs);
        },
        { cursorX: x, cursorY: y, motionDurationMs: durationMs },
      );
    },
    config: args.config,
    performClick: createDeterministicRecordingClickHandler(args.page, args.config.record),
    onEvent: (actualEvent) => {
      args.onRuntimeEvent?.(actualEvent);
      const expectedEntry = args.timeline.entries[args.getReplayPosition()];
      const index = args.getReplayPosition() + 1;

      if (expectedEntry === undefined) {
        throw new ReplayTimelineError(
          `Recorded pass diverged at entry ${index}: received unexpected ${describeEvent(actualEvent)} after the collected timeline was exhausted.`,
          {
            actual: actualEvent,
            index,
            reason: "extra-event",
          },
        );
      }

      const expectedEvent = expectedEntry.event;

      if (!isDeepStrictEqual(actualEvent, expectedEvent)) {
        throw new ReplayTimelineError(
          `Recorded pass diverged at entry ${index}: expected ${describeEvent(expectedEvent)} but received ${describeEvent(actualEvent)}.`,
          {
            actual: actualEvent,
            expected: expectedEvent,
            index,
            reason: "mismatch",
          },
        );
      }

      args.onMatchedEvent?.(actualEvent, index);
      args.updateReplayPosition();

      if (expectedEntry.kind === "narration") {
        args.updatePendingNarrationWait(expectedEntry.segment.durationMs + args.config.holdPaddingMs);
        return;
      }

      args.updatePendingNarrationWait(undefined);
    },
    outputDir: args.outputDir,
    page: args.page,
    waitForTimeout: args.replayWait,
  });
  const baseNarrate = runtime.narrate.bind(runtime);
  const baseNarrateWhile = runtime.narrateWhile.bind(runtime);

  runtime.narrate = async (text, options) => {
    args.updatePendingNarrationWait(undefined);
    await baseNarrate(text, options);

    const expectedEntry = args.timeline.entries[args.getReplayPosition() - 1];

    if (expectedEntry?.kind !== "narration") {
      throw new ReplayTimelineError(
        `Recorded pass diverged at entry ${args.getReplayPosition()}: narration wait could not be resolved from the collected timeline.`,
        {
          actual: {
            chapterTitle: expectedEntry?.event.chapterTitle,
            kind: "narrate",
            text,
            ...options,
          },
          expected: expectedEntry?.event,
          index: args.getReplayPosition(),
          reason: "mismatch",
        },
      );
    }

    await args.replayWait(expectedEntry.segment.durationMs + args.config.holdPaddingMs);
  };

  runtime.narrateWhile = async (text, fn, options) => {
    args.updatePendingNarrationWait(undefined);
    const startedAt = args.now();
    let sleepElapsedMs = 0;
    let narrationEntry: CollectedTimelineEntry | undefined;

    const result = await baseNarrateWhile(
      text,
      async (timeline) => {
        narrationEntry = args.timeline.entries[args.getReplayPosition() - 1];

        if (narrationEntry?.kind !== "narration") {
          throw new ReplayTimelineError(
            `Recorded pass diverged at entry ${args.getReplayPosition()}: narrateWhile wait could not be resolved from the collected timeline.`,
            {
              actual: {
                chapterTitle: narrationEntry?.event.chapterTitle,
                kind: "narrate",
                text,
                ...options,
              },
              expected: narrationEntry?.event,
              index: args.getReplayPosition(),
              reason: "mismatch",
            },
          );
        }

        const replayTimeline: DemoHunterNarrateWhileTimeline = {
          sleep: async (durationMs) => {
            await timeline.sleep(durationMs);
            sleepElapsedMs += durationMs;
          },
          typeText: async (target, text, options) => {
            const action = resolveTypeTextAction(text, options);
            await timeline.typeText(target, text, options);
            sleepElapsedMs += action.delaysMs.reduce((total, delayMs) => total + delayMs, 0);
          },
        };

        return fn(replayTimeline);
      },
      options,
    );

    if (narrationEntry?.kind !== "narration") {
      throw new ReplayTimelineError(
        `Recorded pass diverged at entry ${args.getReplayPosition()}: narrateWhile wait could not be resolved from the collected timeline.`,
        {
          actual: {
            chapterTitle: narrationEntry?.event.chapterTitle,
            kind: "narrate",
            text,
            ...options,
          },
          expected: narrationEntry?.event,
          index: args.getReplayPosition(),
          reason: "mismatch",
        },
      );
    }

    const realElapsedMs = Math.max(0, args.now() - startedAt);
    const elapsedMs = Math.max(realElapsedMs, sleepElapsedMs);
    const remainingNarrationMs = Math.max(0, narrationEntry.segment.durationMs - elapsedMs);
    await args.replayWait(remainingNarrationMs + args.config.holdPaddingMs);

    return result;
  };

  return runtime;
}

function assertReplayComplete(entries: CollectedTimelineEntry[], nextExpectedIndex: number): void {
  if (nextExpectedIndex === entries.length) {
    return;
  }

  const expectedEntry = entries[nextExpectedIndex];
  const expectedEvent = expectedEntry.event;
  const index = nextExpectedIndex + 1;

  throw new ReplayTimelineError(
    `Recorded pass diverged at entry ${index}: expected ${describeEvent(expectedEvent)} but the recorded pass ended before emitting it.`,
    {
      expected: expectedEvent,
      index,
      reason: "missing-event",
    },
  );
}

function describeEvent(event: TourRuntimeEvent): string {
  const chapter = event.chapterTitle === undefined ? "unscoped" : event.chapterTitle;

  switch (event.kind) {
    case "chapter":
      return `chapter "${event.title}" in chapter "${chapter}"`;
    case "step-start":
    case "step-end":
      return `${event.kind} "${event.title}" in chapter "${chapter}"`;
    case "narrate":
      return `narration "${event.text}" in chapter "${chapter}"`;
    case "narration-sleep":
      return `narration sleep ${event.durationMs}ms in chapter "${chapter}"`;
    case "click":
      return `click after ${event.durationMs}ms cursor motion in chapter "${chapter}"`;
    default:
      return `${event.kind} event in chapter "${chapter}"`;
  }
}
