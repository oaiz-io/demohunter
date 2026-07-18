import type {
  AssertVisibleOptions,
  ChapterOptions,
  DemoHunterAuthorRunContext,
  DemoHunterLifecycleContext,
  DemoHunterNarrateWhileTimeline,
  DemoHunterRunContext,
  HighlightOptions,
  NarrateOptions,
  SnapshotOptions,
  WaitForStableOptions,
  ResolvedDemoHunterConfig,
} from "@demohunter/sdk";
import type { Locator, Page } from "playwright";
import type { TourRuntimeEvent } from "../execute/generator-types.js";
import { typeTextIntoLocator } from "./type-text.js";

export type SmokeRuntime = DemoHunterAuthorRunContext & DemoHunterLifecycleContext;

type SnapshotInput = string | SnapshotOptions | undefined;

export type SmokeTourRuntimeEvent = TourRuntimeEvent;

const LIFECYCLE_BLOCKED_HELPERS = new Set<PropertyKey>([
  "chapter",
  "step",
  "narrate",
  "narrateWhile",
  "waitForStable",
  "highlight",
  "snapshot",
  "assertVisible",
]);

export function createSmokeLifecycleContext(runtime: SmokeRuntime): DemoHunterLifecycleContext {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (LIFECYCLE_BLOCKED_HELPERS.has(property)) {
        return undefined;
      }

      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (LIFECYCLE_BLOCKED_HELPERS.has(property)) {
        return false;
      }

      return Reflect.has(target, property);
    },
  }) as DemoHunterLifecycleContext;
}

export function createSmokeTourRuntime(args: {
  config: ResolvedDemoHunterConfig;
  page: Page;
  outputDir: string;
  afterNavigation?: () => Promise<void>;
  onEvent?: (event: SmokeTourRuntimeEvent) => void;
  waitForTimeout?: (durationMs: number) => Promise<void>;
}): SmokeRuntime {
  let currentChapter: string | undefined;

  const emit = (event: TourRuntimeEvent): void => {
    args.onEvent?.(event);
  };
  const emitNarration = (text: string, options?: NarrateOptions): void => {
    emit({
      chapterTitle: currentChapter,
      kind: "narrate",
      text,
      ...options,
    });
  };
  const sleep = async (durationMs: number): Promise<void> => {
    assertNonNegativeFiniteDuration(durationMs);
    emit({
      chapterTitle: currentChapter,
      durationMs,
      kind: "narration-sleep",
    });
    await (args.waitForTimeout ?? ((ms: number) => args.page.waitForTimeout(ms)))(durationMs);
  };
  const goto: DemoHunterRunContext["goto"] = async (url, options) => {
    const resolvedUrl = new URL(url, args.config.baseURL).href;
    const response = await args.page.goto(resolvedUrl, options);
    await args.afterNavigation?.();
    return response;
  };

  const runtime: SmokeRuntime = {
    config: args.config,
    goto,
    page: args.page,
    async chapter(title: string, options?: ChapterOptions): Promise<void> {
      currentChapter = title;
      emit({
        chapterTitle: title,
        id: options?.id,
        kind: "chapter",
        outputDir: args.outputDir,
        title,
      });
    },
    async step<T>(title: string, fn: () => Promise<T> | T): Promise<T> {
      emit({
        chapterTitle: currentChapter,
        kind: "step-start",
        title,
      });

      try {
        const result = await fn();
        emit({
          chapterTitle: currentChapter,
          kind: "step-end",
          title,
        });
        return result;
      } catch (error) {
        emit({
          chapterTitle: currentChapter,
          kind: "step-end",
          title,
        });
        throw error;
      }
    },
    async narrate(text: string, options?: NarrateOptions): Promise<void> {
      emitNarration(text, options);
    },
    async narrateWhile<T>(
      text: string,
      fn: (timeline: DemoHunterNarrateWhileTimeline) => Promise<T> | T,
      options?: NarrateOptions,
    ): Promise<T> {
      emitNarration(text, options);
      return fn({
        sleep,
        typeText: async (target, text, options) => {
          await typeTextIntoLocator(target, text, options, sleep, (action) => {
            emit({
              chapterTitle: currentChapter,
              delaysMs: action.delaysMs,
              kind: "type-text",
              text: action.text,
              ...action.options,
            });
          });
        },
      });
    },
    async waitForStable(options?: WaitForStableOptions): Promise<void> {
      const state = options?.state ?? "networkidle";
      const waitOptions = options?.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs };

      await args.page.waitForLoadState(state, waitOptions);
      emit({
        chapterTitle: currentChapter,
        kind: "wait-for-stable",
        state,
        timeoutMs: options?.timeoutMs,
      });
    },
    async highlight(target: Locator, options?: HighlightOptions): Promise<void> {
      await target.waitFor({ state: "visible" });
      await target.scrollIntoViewIfNeeded();
      emit({
        chapterTitle: currentChapter,
        kind: "highlight",
        ...options,
      });
    },
    async snapshot(nameOrOptions?: SnapshotInput): Promise<void> {
      const options =
        typeof nameOrOptions === "string"
          ? {
              name: nameOrOptions,
            }
          : nameOrOptions;

      emit({
        chapterTitle: currentChapter,
        kind: "snapshot",
        ...options,
      });
    },
    async assertVisible(target: Locator, options?: AssertVisibleOptions): Promise<void> {
      await target.waitFor(
        options?.timeoutMs === undefined
          ? { state: "visible" }
          : { state: "visible", timeout: options.timeoutMs },
      );
      emit({
        chapterTitle: currentChapter,
        kind: "assert-visible",
        timeoutMs: options?.timeoutMs,
      });
    },
  };

  return runtime;
}

function assertNonNegativeFiniteDuration(durationMs: number): void {
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    return;
  }

  throw new Error(`narrateWhile sleep duration must be a non-negative finite number: ${durationMs}`);
}
