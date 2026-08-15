import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { DemoHunterRunContext, HighlightStyle, ResolvedDemoHunterConfig } from "@demohunter/sdk";
import type { NarrationProviderRegistry } from "@demohunter/tts-core";
import * as playwright from "playwright";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright";

import { collectTimeline } from "./execute/collect-timeline.js";
import type {
  CollectedTimeline,
  GenerationProgressEvent,
  GenerationProgressReporter,
  RecordedNarration,
  TourRuntimeEvent,
} from "./execute/generator-types.js";
import { attachDebugCapture } from "./debug/failure-artifacts.js";
import type { DebugArtifactResult, DebugCapture, DebugPhase } from "./debug/failure-artifacts.js";
import { replayTimeline } from "./execute/replay-timeline.js";
import { prepareOutputDir as prepareOutputDirHelper } from "./output/prepare-output-dir.js";
import { renderOutputVariants } from "./output/render-output-variants.js";
import { writeGenerationOutput } from "./output/write-generation-output.js";
import type { GenerationChapter, WriteGenerationOutputResult } from "./output/write-generation-output.js";
import { showChapterOverlay } from "./overlays/chapter-overlay.js";
import { applyHighlightVisual } from "./overlays/highlight-visual.js";
import { installRecordingEffects } from "./overlays/install-recording-effects.js";
import { muxVideo } from "./record/mux-video.js";
import { startScreencast, stopScreencast } from "./record/screencast.js";
import type { SmokeTourModule } from "./smoke-generate.js";

const CHAPTER_OVERLAY_DURATION_MS = 900;
const DEFAULT_HIGHLIGHT_DURATION_MS = 800;
const DEFAULT_HIGHLIGHT_PADDING_PX = 8;
const DEFAULT_HIGHLIGHT_STYLE: HighlightStyle = "ring";

type BrowserTypeMap = Record<"chromium" | "firefox" | "webkit", Pick<BrowserType, "launch">>;

export type GenerateTourResult = WriteGenerationOutputResult;
export type GenerateLoadedConfig = {
  config: ResolvedDemoHunterConfig;
  configPath: string;
  projectRoot: string;
};
export type GenerateTourFile = SmokeTourModule;

export type GenerateTourInput = {
  /** Caller-owned registry. The generator never closes it. */
  narrationRegistry?: NarrationProviderRegistry;
  /** Compatibility seam for callers that need the generator to own provider lifecycle. */
  createLegacyNarrationRegistry?: () => NarrationProviderRegistry;
  loadedConfig: GenerateLoadedConfig;
  onProgress?: GenerationProgressReporter;
  signal?: AbortSignal;
  tourFile: GenerateTourFile;
};

type GenerateTourDependencies = {
  applyHighlightVisual: typeof applyHighlightVisual;
  attachDebugCapture: typeof attachDebugCapture;
  collectTimeline: typeof collectTimeline;
  installRecordingEffects: typeof installRecordingEffects;
  generateResponsiveVariant: (input: GenerateTourInput) => Promise<GenerateTourResult>;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  muxVideo: typeof muxVideo;
  now: () => number;
  playwright: BrowserTypeMap;
  prepareOutputDir: (tourId: string, outputRoot: string) => Promise<string>;
  rename: typeof rename;
  replayTimeline: typeof replayTimeline;
  renderOutputVariants: typeof renderOutputVariants;
  showChapterOverlay: typeof showChapterOverlay;
  startScreencast: typeof startScreencast;
  stopScreencast: typeof stopScreencast;
  writeGenerationOutput: typeof writeGenerationOutput;
};

const defaultDependencies: GenerateTourDependencies = {
  applyHighlightVisual,
  attachDebugCapture,
  collectTimeline,
  installRecordingEffects,
  generateResponsiveVariant: (input) => generateTour(input),
  mkdir,
  mkdtemp,
  muxVideo,
  now: () => Date.now(),
  playwright,
  prepareOutputDir: (tourId, outputRoot) => prepareOutputDirHelper(tourId, outputRoot),
  rename,
  replayTimeline,
  renderOutputVariants,
  showChapterOverlay,
  startScreencast,
  stopScreencast,
  writeGenerationOutput,
};

export async function generateTour(
  { createLegacyNarrationRegistry, loadedConfig, narrationRegistry, onProgress, signal, tourFile }: GenerateTourInput,
  dependencies: Partial<GenerateTourDependencies> = {},
): Promise<GenerateTourResult> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const { config } = loadedConfig;
  signal?.throwIfAborted();
  let ownedNarrationRegistry: NarrationProviderRegistry | undefined;
  let activeNarrationRegistry = narrationRegistry;
  report(onProgress, {
    phase: "preparing-output",
    message: `Preparing output for ${tourFile.tour.id}`,
  });
  const outputDir = await resolvedDependencies.prepareOutputDir(tourFile.tour.id, config.outputDir);
  const tempScreencastPath = path.join(path.dirname(outputDir), `${tourFile.tour.id}.recording.webm`);
  const browserType = resolvedDependencies.playwright[config.browser];
  report(onProgress, {
    phase: "launching-browser",
    message: `Launching ${config.browser}`,
  });
  let browser: Browser | undefined;
  let passOneContext: BrowserContext | undefined;
  let passTwoContext: BrowserContext | undefined;
  let primaryError: unknown;
  let passOneDebug: DebugCapture | undefined;
  let passTwoDebug: DebugCapture | undefined;
  let lastRuntimeEvent: TourRuntimeEvent | undefined;
  const chapters: GenerationChapter[] = [];
  const recordedNarrations: RecordedNarration[] = [];
  const responsiveCaptureRoots: string[] = [];
  let outputStagingRoot: string | undefined;
  let artifactOutputDir = outputDir;

  try {
    browser = await browserType.launch();
    ownedNarrationRegistry = narrationRegistry === undefined
      ? createLegacyNarrationRegistry?.()
      : undefined;
    activeNarrationRegistry = narrationRegistry ?? ownedNarrationRegistry;

    if (config.output.formats.length > 0) {
      signal?.throwIfAborted();
      outputStagingRoot = await resolvedDependencies.mkdtemp(
        path.join(path.dirname(outputDir), ".demohunter-output-"),
      );
      artifactOutputDir = path.join(outputStagingRoot, "output");
      await resolvedDependencies.mkdir(artifactOutputDir, { recursive: true });
    }

    passOneContext = await browser.newContext({
      baseURL: config.baseURL,
      viewport: config.viewport,
    });

    const passOnePage = await passOneContext.newPage();
    report(onProgress, {
      phase: "collecting-timeline",
      message: `Collecting timeline for ${tourFile.tour.id}`,
    });
    const timeline = await capturePhaseFailure({
      debugCapture: passOneDebug,
      onProgress,
      phase: "collect-timeline",
      run: () =>
        resolvedDependencies.collectTimeline({
          loadedConfig,
          ...(activeNarrationRegistry === undefined ? {} : { narrationRegistry: activeNarrationRegistry }),
          onBeforeRun: () => {
            passOneDebug = resolvedDependencies.attachDebugCapture({
              outputDir,
              page: passOnePage,
            });
          },
          onProgress,
          onRuntimeEvent: (event) => {
            lastRuntimeEvent = event;
            reportRuntimeEvent(onProgress, event);
          },
          page: passOnePage,
          ...(signal === undefined ? {} : { signal }),
          tourFile,
        }),
      getLastRuntimeEvent: () => lastRuntimeEvent,
    });
    passOneDebug?.dispose();
    passOneDebug = undefined;

    await passOneContext.close();
    signal?.throwIfAborted();
    passOneContext = undefined;

    passTwoContext = await browser.newContext({
      baseURL: config.baseURL,
      viewport: config.viewport,
    });

    const showCursor = config.record.cursor === false
      ? false
      : (config.record.cursor === undefined ? (config.record.showCursor ?? true) : true);
    const showClickRipple = config.record.cursor === false
      ? false
      : (typeof config.record.cursor === "object"
          ? config.record.cursor.ripple
          : (config.record.showClickRipple ?? true));

    await resolvedDependencies.installRecordingEffects(passTwoContext, {
      cursor: config.record.cursor,
      showCursor,
      showClickRipple,
    });

    const passTwoPage = await passTwoContext.newPage();
    let recordingStartedAt: number | undefined;
    let screencastStarted = false;

    try {
      report(onProgress, {
        phase: "recording-replay",
        message: `Recording replay for ${tourFile.tour.id}`,
      });
      await resolvedDependencies.replayTimeline({
        loadedConfig,
        onBeforeRun: async () => {
          await resolvedDependencies.startScreencast({
            outputPath: tempScreencastPath,
            page: passTwoPage,
            showActions: config.record.showActions,
            actionCursor: showCursor ? "none" : "pointer",
            viewport: config.viewport,
          });
          screencastStarted = true;
          passTwoDebug = resolvedDependencies.attachDebugCapture({
            outputDir,
            page: passTwoPage,
          });
          recordingStartedAt = resolvedDependencies.now();
        },
        onMatchedEvent: (event, index) => {
          if (recordingStartedAt === undefined) {
            return;
          }

          if (event.kind === "chapter") {
            chapters.push({
              startMs: Math.max(0, resolvedDependencies.now() - recordingStartedAt),
              title: event.title,
            });
            return;
          }

          if (event.kind !== "narrate") {
            return;
          }

          const matchedEntry = timeline.entries[index - 1];

          if (matchedEntry?.kind !== "narration") {
            return;
          }

          const startMs = Math.max(0, resolvedDependencies.now() - recordingStartedAt);
          recordedNarrations.push({
            ...matchedEntry.segment,
            endMs: startMs + matchedEntry.segment.durationMs,
            startMs,
          });
        },
        onRuntimeEvent: (event) => {
          lastRuntimeEvent = event;
          reportRuntimeEvent(onProgress, event);
        },
        page: passTwoPage,
        ...(signal === undefined ? {} : { signal }),
        timeline,
        tourFile: wrapTourForRecording({
          applyHighlightVisual: resolvedDependencies.applyHighlightVisual,
          config,
          page: passTwoPage,
          showChapterOverlay: resolvedDependencies.showChapterOverlay,
          showChapters: config.record.showChapters,
          tourFile,
        }),
      });
    } catch (error) {
      primaryError = error;
      await captureDebugFailure({
        debugCapture: passTwoDebug,
        error,
        getLastRuntimeEvent: () => lastRuntimeEvent,
        onProgress,
        phase: "record-replay",
      });
    }

    if (screencastStarted) {
      await resolvedDependencies.stopScreencast({
        page: passTwoPage,
        primaryError,
      });
    } else if (primaryError !== undefined) {
      throw primaryError;
    }

    passTwoDebug?.dispose();
    passTwoDebug = undefined;
    report(onProgress, {
      phase: "muxing-video",
      message: `Muxing ${config.record.container} video`,
    });
    signal?.throwIfAborted();
    const videos = await resolvedDependencies.muxVideo({
      narrations: recordedNarrations,
      outputDir: artifactOutputDir,
      recordFormat: config.record.container,
      tempScreencastPath,
    });

    report(onProgress, {
      phase: "writing-artifacts",
      message: `Writing artifacts for ${tourFile.tour.id}`,
    });
    signal?.throwIfAborted();
    const workingResult = await resolvedDependencies.writeGenerationOutput({
      tourId: tourFile.tour.id,
      tourTitle: tourFile.tour.title,
      chapters,
      recordedNarrations,
      videos,
      outputDir: artifactOutputDir,
    });

    if (config.output.formats.length > 0) {
      const responsiveSourceDirs: Partial<Record<"standard" | "square" | "mobile", string>> = {};
      for (const format of config.output.formats) {
        signal?.throwIfAborted();
        if (format.preset === "gif" || format.layout !== "responsive") continue;
        const responsiveRoot = await resolvedDependencies.mkdtemp(
          path.join(path.dirname(outputDir), `.demohunter-${format.preset}-`),
        );
        responsiveCaptureRoots.push(responsiveRoot);
        const viewport = responsiveViewport(format.preset);
        report(onProgress, {
          phase: "collecting-timeline",
          message: `Capturing responsive ${format.preset} variant at ${viewport.width}x${viewport.height}`,
        });
        const responsiveResult = await resolvedDependencies.generateResponsiveVariant({
          narrationRegistry: activeNarrationRegistry,
          loadedConfig: {
            ...loadedConfig,
            config: {
              ...config,
              outputDir: responsiveRoot,
              viewport,
              output: { formats: [] },
            },
          },
          onProgress,
          signal,
          tourFile,
        });
        responsiveSourceDirs[format.preset] = responsiveResult.outputDir;
      }

      report(onProgress, {
        phase: "writing-artifacts",
        message: `Rendering ${config.output.formats.length} social output format(s)`,
      });
      await resolvedDependencies.renderOutputVariants({
        formats: config.output.formats,
        outputDir: artifactOutputDir,
        responsiveSourceDirs,
      });
    }

    let result = workingResult;
    if (outputStagingRoot !== undefined) {
      await publishStagedOutput({
        outputDir,
        stagedOutputDir: artifactOutputDir,
        stagingRoot: outputStagingRoot,
      }, resolvedDependencies);
      result = rebaseGenerationResult(workingResult, outputDir);
    }

    report(onProgress, {
      phase: "completed",
      message: `Wrote ${result.videoPath}`,
    });

    return result;
  } catch (error) {
    primaryError ??= error;
    throw error;
  } finally {
    let closeError: unknown;

    try {
      passOneDebug?.dispose();
      passTwoDebug?.dispose();
      await rm(tempScreencastPath, { force: true });
      await Promise.all([
        ...responsiveCaptureRoots.map((root) => rm(root, { recursive: true, force: true })),
        ...(outputStagingRoot === undefined
          ? []
          : [rm(outputStagingRoot, { recursive: true, force: true })]),
      ]);
    } catch (error) {
      closeError ??= error;
    }

    try {
      await passOneContext?.close();
    } catch (error) {
      closeError ??= error;
    }

    try {
      await passTwoContext?.close();
    } catch (error) {
      closeError ??= error;
    }

    try {
      await browser?.close();
    } catch (error) {
      closeError ??= error;
    }

    if (ownedNarrationRegistry !== undefined) {
      await ownedNarrationRegistry.close(primaryError ?? closeError);
    }

    if (primaryError === undefined && closeError !== undefined) {
      throw closeError;
    }
  }
}

async function publishStagedOutput(
  input: { outputDir: string; stagedOutputDir: string; stagingRoot: string },
  dependencies: Pick<GenerateTourDependencies, "rename">,
): Promise<void> {
  const backupDir = path.join(input.stagingRoot, "previous-output");
  await dependencies.rename(input.outputDir, backupDir);

  try {
    await dependencies.rename(input.stagedOutputDir, input.outputDir);
  } catch (error) {
    await dependencies.rename(backupDir, input.outputDir);
    throw error;
  }
}

function rebaseGenerationResult(
  result: WriteGenerationOutputResult,
  outputDir: string,
): WriteGenerationOutputResult {
  return {
    ...result,
    captionsSrtPath: path.join(outputDir, "captions.srt"),
    captionsVttPath: path.join(outputDir, "captions.vtt"),
    chaptersPath: path.join(outputDir, "chapters.json"),
    outputDir,
    videoPath: path.join(outputDir, "video.mp4"),
  };
}

function responsiveViewport(preset: "standard" | "square" | "mobile") {
  switch (preset) {
    case "standard":
      return { width: 1920, height: 1080 };
    case "square":
      return { width: 1080, height: 1080 };
    case "mobile":
      return { width: 390, height: 844 };
  }
}

async function capturePhaseFailure<T>(input: {
  debugCapture: DebugCapture | undefined;
  getLastRuntimeEvent: () => TourRuntimeEvent | undefined;
  onProgress?: GenerationProgressReporter;
  phase: DebugPhase;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.run();
  } catch (error) {
    await captureDebugFailure({
      debugCapture: input.debugCapture,
      error,
      getLastRuntimeEvent: input.getLastRuntimeEvent,
      onProgress: input.onProgress,
      phase: input.phase,
    });
    throw error;
  }
}

async function captureDebugFailure(input: {
  debugCapture: DebugCapture | undefined;
  error: unknown;
  getLastRuntimeEvent: () => TourRuntimeEvent | undefined;
  onProgress?: GenerationProgressReporter;
  phase: DebugPhase;
}): Promise<DebugArtifactResult | undefined> {
  if (input.debugCapture === undefined) {
    return undefined;
  }

  report(input.onProgress, {
    phase: "capturing-debug",
    message: `Capturing debug artifacts for ${input.phase}`,
  });

  try {
    const result = await input.debugCapture.captureFailure({
      error: input.error,
      lastRuntimeEvent: input.getLastRuntimeEvent(),
      phase: input.phase,
    });
    report(input.onProgress, {
      phase: "capturing-debug",
      message: `Wrote debug artifacts to ${result.directory}`,
    });
    return result;
  } catch (debugError) {
    report(input.onProgress, {
      phase: "capturing-debug",
      message: `Could not capture debug artifacts: ${
        debugError instanceof Error ? debugError.message : String(debugError)
      }`,
    });
    return undefined;
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

function wrapTourForRecording(args: {
  applyHighlightVisual: typeof applyHighlightVisual;
  config: ResolvedDemoHunterConfig;
  page: Page;
  showChapterOverlay: typeof showChapterOverlay;
  showChapters: boolean;
  tourFile: SmokeTourModule;
}): SmokeTourModule {
  return {
    ...args.tourFile,
    tour: {
      ...args.tourFile.tour,
      run: async (runtime) => {
        await args.tourFile.tour.run(
          new Proxy(runtime, {
            get(target, property, receiver) {
              if (args.showChapters && property === "chapter") {
                return async (title: string, options?: Parameters<DemoHunterRunContext["chapter"]>[1]) => {
                  const chapter = Reflect.get(
                    target,
                    property,
                    receiver,
                  ) as DemoHunterRunContext["chapter"];
                  await chapter(title, options);
                  await args.showChapterOverlay({
                    durationMs: CHAPTER_OVERLAY_DURATION_MS,
                    page: args.page,
                    title,
                  });
                };
              }

              if (property === "highlight") {
                return async (
                  highlightTarget: Parameters<DemoHunterRunContext["highlight"]>[0],
                  options?: Parameters<DemoHunterRunContext["highlight"]>[1],
                ) => {
                  const highlight = Reflect.get(
                    target,
                    property,
                    receiver,
                  ) as DemoHunterRunContext["highlight"];
                  await highlight(highlightTarget, options);
                  await args.applyHighlightVisual({
                    page: args.page,
                    target: highlightTarget,
                    style: options?.style ?? args.config.record.highlightStyle ?? DEFAULT_HIGHLIGHT_STYLE,
                    paddingPx: options?.paddingPx ?? DEFAULT_HIGHLIGHT_PADDING_PX,
                    durationMs: options?.durationMs ?? DEFAULT_HIGHLIGHT_DURATION_MS,
                  });
                };
              }

              const value = Reflect.get(target, property, receiver);

              if (typeof value === "function") {
                return value.bind(target);
              }

              return value;
            },
          }),
        );
      },
    },
  };
}
