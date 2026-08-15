import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { createNarrationProviderRegistry, type NarrationProviderPlugin } from "@demohunter/tts-core";

import type { CollectedTimeline } from "./execute/generator-types.js";
import { ReplayTimelineError } from "./execute/replay-timeline.js";
import { generateTour } from "./generate.js";
import type { GenerateLoadedConfig } from "./generate.js";

describe("generateTour", () => {
  test("runs pass 1, recorded replay, muxing, and output writing in order", async () => {
    const calls: string[] = [];
    const passOnePage = { goto: mock(async () => {}) };
    const passTwoPage = { goto: mock(async () => {}) };
    const passOneContext = {
      close: mock(async () => {
        calls.push("close-pass-1");
      }),
      newPage: mock(async () => {
        calls.push("new-page-pass-1");
        return passOnePage;
      }),
    };
    const passTwoContext = {
      close: mock(async () => {
        calls.push("close-pass-2");
      }),
      newPage: mock(async () => {
        calls.push("new-page-pass-2");
        return passTwoPage;
      }),
    };
    const browser = {
      close: mock(async () => {
        calls.push("close-browser");
      }),
      newContext: mock(async () => {
        calls.push("new-context");
        return browser.newContext.mock.calls.length === 1 ? passOneContext : passTwoContext;
      }),
    };
    const collectTimeline = mock(async () => {
      calls.push("collect");
      return createTimeline();
    });
    const replayTimeline = mock(async ({ onBeforeRun, onMatchedEvent, tourFile }) => {
      calls.push("replay");
      await onBeforeRun?.();
      onMatchedEvent?.(
        {
          chapterTitle: "Billing",
          id: "billing",
          kind: "chapter",
          outputDir: "/tmp/project/.demohunter/billing-overview",
          title: "Billing",
        },
        1,
      );
      onMatchedEvent?.(
        {
          chapterTitle: "Billing",
          kind: "narrate",
          text: "Explain billing",
        },
        2,
      );
      onMatchedEvent?.(
        {
          chapterTitle: "Invoices",
          id: "invoices",
          kind: "chapter",
          outputDir: "/tmp/project/.demohunter/billing-overview",
          title: "Invoices",
        },
        3,
      );
      await tourFile.tour.run({
        chapter: mock(async () => {
          calls.push("chapter");
        }),
      });
    });
    const startScreencast = mock(async () => {
      calls.push("start");
    });
    const stopScreencast = mock(async () => {
      calls.push("stop");
    });
    const muxVideo = mock(async () => {
      calls.push("mux");
      return {
        mp4: {
          fileName: "video.mp4" as const,
          format: "mp4" as const,
          path: "/tmp/video.mp4",
        },
      };
    });
    const writeGenerationOutput = mock(async () => {
      calls.push("write");
      return {
        captionsSrtPath: "/tmp/project/.demohunter/billing-overview/captions.srt",
        captionsVttPath: "/tmp/project/.demohunter/billing-overview/captions.vtt",
        outputDir: "/tmp/project/.demohunter/billing-overview",
        videoPath: "/tmp/project/.demohunter/billing-overview/video.mp4",
      };
    });
    const showChapterOverlay = mock(async () => {
      calls.push("show-chapter-overlay");
    });
    const timestamps = [1_000, 1_100, 1_250, 2_750];
    const now = mock(() => {
      const next = timestamps.shift();
      return next ?? 2_750;
    });
    const progress: string[] = [];

    const result = await generateTour(
      {
        loadedConfig: createLoadedConfig("/tmp/project"),
        onProgress: (event) => {
          progress.push(event.phase);
        },
        tourFile: createTourFile("/tmp/project"),
      },
      {
        applyHighlightVisual: mock(async () => {
          calls.push("apply-highlight");
        }),
        attachDebugCapture: mock(() => createDebugCapture()),
        collectTimeline,
        installRecordingEffects: mock(async () => {
          calls.push("install-effects");
        }),
        muxVideo,
        now,
        playwright: {
          chromium: {
            launch: mock(async () => {
              calls.push("launch");
              return browser;
            }),
          },
          firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
        },
        prepareOutputDir: mock(async () => {
          calls.push("prepare-output");
          return "/tmp/project/.demohunter/billing-overview";
        }),
        replayTimeline,
        showChapterOverlay,
        startScreencast,
        stopScreencast,
        writeGenerationOutput,
      },
    );

    expect(result).toEqual({
      captionsSrtPath: "/tmp/project/.demohunter/billing-overview/captions.srt",
      captionsVttPath: "/tmp/project/.demohunter/billing-overview/captions.vtt",
      outputDir: "/tmp/project/.demohunter/billing-overview",
      videoPath: "/tmp/project/.demohunter/billing-overview/video.mp4",
    });
    expect(progress).toEqual([
      "preparing-output",
      "launching-browser",
      "collecting-timeline",
      "recording-replay",
      "muxing-video",
      "writing-artifacts",
      "completed",
    ]);
    expect(calls).toEqual([
      "prepare-output",
      "launch",
      "new-context",
      "new-page-pass-1",
      "collect",
      "close-pass-1",
      "new-context",
      "install-effects",
      "new-page-pass-2",
      "replay",
      "start",
      "chapter",
      "show-chapter-overlay",
      "stop",
      "mux",
      "write",
      "close-pass-2",
      "close-browser",
    ]);
    expect(startScreencast).toHaveBeenCalledWith({
      outputPath: "/tmp/project/.demohunter/billing-overview.recording.webm",
      page: passTwoPage,
      showActions: true,
      actionCursor: "none",
      viewport: { height: 720, width: 1280 },
    });
    expect(browser.newContext).toHaveBeenNthCalledWith(1, {
      baseURL: "http://localhost:3000",
      viewport: { height: 720, width: 1280 },
    });
    expect(browser.newContext).toHaveBeenNthCalledWith(2, {
      baseURL: "http://localhost:3000",
      viewport: { height: 720, width: 1280 },
    });
    expect(writeGenerationOutput).toHaveBeenCalledWith({
      chapters: [
        { startMs: 100, title: "Billing" },
        { startMs: 1750, title: "Invoices" },
      ],
      recordedNarrations: [
        {
          audioPath: "/tmp/project/.demohunter/cache/explain-billing.mp3",
          cacheKey: "explain-billing",
          chapterTitle: "Billing",
          durationMs: 1200,
          endMs: 1450,
          startMs: 250,
          text: "Explain billing",
        },
      ],
      tourId: "billing-overview",
      tourTitle: "Billing overview",
      videos: {
        mp4: {
          fileName: "video.mp4",
          format: "mp4",
          path: "/tmp/video.mp4",
        },
      },
      outputDir: "/tmp/project/.demohunter/billing-overview",
    });
    expect(showChapterOverlay).toHaveBeenCalledWith({
      durationMs: 900,
      page: passTwoPage,
      title: "Billing",
    });
    expect(muxVideo).toHaveBeenCalledWith({
      narrations: [
        {
          audioPath: "/tmp/project/.demohunter/cache/explain-billing.mp3",
          cacheKey: "explain-billing",
          chapterTitle: "Billing",
          durationMs: 1200,
          endMs: 1450,
          startMs: 250,
          text: "Explain billing",
        },
      ],
      outputDir: "/tmp/project/.demohunter/billing-overview",
      recordFormat: "mp4",
      tempScreencastPath: "/tmp/project/.demohunter/billing-overview.recording.webm",
    });
    expect(now).toHaveBeenCalledTimes(4);
  });

  test("runs responsive presets through their own two-pass generation before variant rendering", async () => {
    const page = { goto: mock(async () => {}) };
    const context = {
      close: mock(async () => {}),
      newPage: mock(async () => page),
    };
    const browser = {
      close: mock(async () => {}),
      newContext: mock(async () => context),
    };
    const outputDir = "/tmp/project/.demohunter/billing-overview";
    const outputStagingRoot = "/tmp/project/.demohunter-output-fixture";
    const stagedOutputDir = `${outputStagingRoot}/output`;
    const mobileRoot = "/tmp/project/.demohunter-mobile-fixture";
    const mobileOutputDir = `${mobileRoot}/billing-overview`;
    const formats = [
      { preset: "square" as const, layout: "fit" as const },
      { preset: "mobile" as const, layout: "responsive" as const },
      { preset: "gif" as const, layout: "fit" as const, durationMs: 8_000 },
    ];
    const generateResponsiveVariant = mock(async () => ({
      captionsSrtPath: `${mobileOutputDir}/captions.srt`,
      captionsVttPath: `${mobileOutputDir}/captions.vtt`,
      chaptersPath: `${mobileOutputDir}/chapters.json`,
      outputDir: mobileOutputDir,
      videoPath: `${mobileOutputDir}/video.mp4`,
    }));
    const renderOutputVariants = mock(async () => {});
    const rename = mock(async () => {});

    await generateTour({
      loadedConfig: createLoadedConfig("/tmp/project", { output: { formats } }),
      tourFile: createTourFile("/tmp/project"),
    }, {
      attachDebugCapture: mock(() => createDebugCapture()),
      collectTimeline: mock(async () => ({ entries: [], narrations: [] })),
      generateResponsiveVariant,
      installRecordingEffects: mock(async () => {}),
      mkdir: mock(async () => undefined),
      mkdtemp: mock(async (prefix) => prefix.includes(".demohunter-output-")
        ? outputStagingRoot
        : mobileRoot),
      muxVideo: mock(async () => ({
        mp4: { fileName: "video.mp4", format: "mp4", path: "/tmp/video.mp4" },
      })),
      playwright: {
        chromium: { launch: mock(async () => browser) },
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
      },
      prepareOutputDir: mock(async () => outputDir),
      rename,
      renderOutputVariants,
      replayTimeline: mock(async ({ onBeforeRun }) => { await onBeforeRun?.(); }),
      startScreencast: mock(async () => {}),
      stopScreencast: mock(async () => {}),
      writeGenerationOutput: mock(async () => ({
        captionsSrtPath: `${stagedOutputDir}/captions.srt`,
        captionsVttPath: `${stagedOutputDir}/captions.vtt`,
        chaptersPath: `${stagedOutputDir}/chapters.json`,
        outputDir: stagedOutputDir,
        videoPath: `${stagedOutputDir}/video.mp4`,
      })),
    });

    expect(generateResponsiveVariant).toHaveBeenCalledTimes(1);
    expect(generateResponsiveVariant.mock.calls[0]?.[0].loadedConfig.config.viewport).toEqual({
      width: 390,
      height: 844,
    });
    expect(generateResponsiveVariant.mock.calls[0]?.[0].loadedConfig.config.output).toEqual({ formats: [] });
    expect(renderOutputVariants).toHaveBeenCalledWith({
      formats,
      outputDir: stagedOutputDir,
      responsiveSourceDirs: { mobile: mobileOutputDir },
    });
    expect(rename.mock.calls).toEqual([
      [outputDir, `${outputStagingRoot}/previous-output`],
      [stagedOutputDir, outputDir],
    ]);
  });

  test("does not publish staged baseline artifacts when variant rendering fails", async () => {
    const page = { goto: mock(async () => {}) };
    const context = {
      close: mock(async () => {}),
      newPage: mock(async () => page),
    };
    const browser = {
      close: mock(async () => {}),
      newContext: mock(async () => context),
    };
    const outputDir = "/tmp/project/.demohunter/billing-overview";
    const stagingRoot = "/tmp/project/.demohunter-output-failure";
    const stagedOutputDir = `${stagingRoot}/output`;
    const rename = mock(async () => {});
    const muxVideo = mock(async () => ({
      mp4: { fileName: "video.mp4" as const, format: "mp4" as const, path: `${stagedOutputDir}/video.mp4` },
    }));
    const writeGenerationOutput = mock(async () => ({
      captionsSrtPath: `${stagedOutputDir}/captions.srt`,
      captionsVttPath: `${stagedOutputDir}/captions.vtt`,
      chaptersPath: `${stagedOutputDir}/chapters.json`,
      outputDir: stagedOutputDir,
      videoPath: `${stagedOutputDir}/video.mp4`,
    }));

    await expect(generateTour({
      loadedConfig: createLoadedConfig("/tmp/project", {
        output: { formats: [{ preset: "square", layout: "fit" }] },
      }),
      tourFile: createTourFile("/tmp/project"),
    }, {
      attachDebugCapture: mock(() => createDebugCapture()),
      collectTimeline: mock(async () => ({ entries: [], narrations: [] })),
      installRecordingEffects: mock(async () => {}),
      mkdir: mock(async () => undefined),
      mkdtemp: mock(async () => stagingRoot),
      muxVideo,
      playwright: {
        chromium: { launch: mock(async () => browser) },
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
      },
      prepareOutputDir: mock(async () => outputDir),
      rename,
      renderOutputVariants: mock(async () => {
        throw new Error("synthetic variant failure");
      }),
      replayTimeline: mock(async ({ onBeforeRun }) => { await onBeforeRun?.(); }),
      startScreencast: mock(async () => {}),
      stopScreencast: mock(async () => {}),
      writeGenerationOutput,
    })).rejects.toThrow("synthetic variant failure");

    expect(muxVideo).toHaveBeenCalledWith(expect.objectContaining({ outputDir: stagedOutputDir }));
    expect(writeGenerationOutput).toHaveBeenCalledWith(
      expect.objectContaining({ outputDir: stagedOutputDir }),
    );
    expect(rename).not.toHaveBeenCalled();
  });

  test("applies highlight visuals after the base highlight, resolving style and duration defaults", async () => {
    const events: string[] = [];
    const baseHighlight = mock(async () => {
      events.push("base-highlight");
    });
    const applyHighlightVisual = mock(async () => {
      events.push("apply-highlight");
    });
    const ringTarget = { id: "ring-target" };
    const spotlightTarget = { id: "spotlight-target" };
    const passTwoPage = { goto: mock(async () => {}) };
    const replayTimeline = mock(async ({ onBeforeRun, tourFile }) => {
      await onBeforeRun?.();
      await tourFile.tour.run({ highlight: baseHighlight });
    });

    await generateTour(
      {
        loadedConfig: createLoadedConfig("/tmp/project"),
        tourFile: {
          path: "/tmp/project/demos/billing.tour.ts",
          tour: {
            id: "billing-overview",
            title: "Billing overview",
            run: async ({ highlight }: { highlight: (target: unknown, options?: unknown) => Promise<void> }) => {
              await highlight(ringTarget);
              await highlight(spotlightTarget, { style: "spotlight", paddingPx: 20, durationMs: 500 });
            },
          },
        },
      },
      {
        applyHighlightVisual,
        attachDebugCapture: mock(() => createDebugCapture()),
        collectTimeline: mock(async () => createTimeline()),
        installRecordingEffects: mock(async () => {}),
        muxVideo: mock(async () => ({
          mp4: { fileName: "video.mp4" as const, format: "mp4" as const, path: "/tmp/video.mp4" },
        })),
        playwright: {
          chromium: {
            launch: mock(async () => ({
              close: mock(async () => {}),
              newContext: mock(async () => ({
                addInitScript: mock(async () => {}),
                close: mock(async () => {}),
                newPage: mock(async () => passTwoPage),
              })),
            })),
          },
          firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
        },
        prepareOutputDir: mock(async () => "/tmp/project/.demohunter/billing-overview"),
        replayTimeline,
        startScreencast: mock(async () => {}),
        stopScreencast: mock(async () => {}),
        writeGenerationOutput: mock(async () => ({
          captionsSrtPath: "/tmp/captions.srt",
          captionsVttPath: "/tmp/captions.vtt",
          outputDir: "/tmp/project/.demohunter/billing-overview",
          videoPath: "/tmp/video.mp4",
        })),
      },
    );

    expect(events).toEqual([
      "base-highlight",
      "apply-highlight",
      "base-highlight",
      "apply-highlight",
    ]);
    expect(applyHighlightVisual).toHaveBeenNthCalledWith(1, {
      page: passTwoPage,
      target: ringTarget,
      style: "ring",
      paddingPx: 8,
      durationMs: 800,
    });
    expect(applyHighlightVisual).toHaveBeenNthCalledWith(2, {
      page: passTwoPage,
      target: spotlightTarget,
      style: "spotlight",
      paddingPx: 20,
      durationMs: 500,
    });
  });

  test("installs highlight effects even when cursor and ripple are disabled", async () => {
    const installRecordingEffects = mock(async () => {});
    const startScreencast = mock(async () => {});

    await generateTour(
      {
        loadedConfig: createLoadedConfig("/tmp/project", {
          record: {
            format: "mp4",
            showActions: true,
            showChapters: true,
            showCursor: false,
            showClickRipple: false,
            highlightStyle: "ring",
          },
        }),
        tourFile: createTourFile("/tmp/project"),
      },
      {
        attachDebugCapture: mock(() => createDebugCapture()),
        collectTimeline: mock(async () => createTimeline()),
        installRecordingEffects,
        muxVideo: mock(async () => ({
          mp4: { fileName: "video.mp4" as const, format: "mp4" as const, path: "/tmp/video.mp4" },
        })),
        playwright: {
          chromium: {
            launch: mock(async () => ({
              close: mock(async () => {}),
              newContext: mock(async () => ({
                close: mock(async () => {}),
                newPage: mock(async () => ({ goto: mock(async () => {}) })),
              })),
            })),
          },
          firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
        },
        prepareOutputDir: mock(async () => "/tmp/project/.demohunter/billing-overview"),
        replayTimeline: mock(async ({ onBeforeRun }) => {
          await onBeforeRun?.();
        }),
        startScreencast,
        stopScreencast: mock(async () => {}),
        writeGenerationOutput: mock(async () => ({
          captionsSrtPath: "/tmp/captions.srt",
          captionsVttPath: "/tmp/captions.vtt",
          outputDir: "/tmp/project/.demohunter/billing-overview",
          videoPath: "/tmp/video.mp4",
        })),
      },
    );

    expect(installRecordingEffects).toHaveBeenCalledWith(
      expect.any(Object),
      {
        showCursor: false,
        showClickRipple: false,
      },
    );
    expect(startScreencast).toHaveBeenCalledWith(
      expect.objectContaining({
        actionCursor: "pointer",
        showActions: true,
      }),
    );
  });

  test("fails directly when pass 1 navigation fails instead of retrying readiness checks", async () => {
    const navigationError = new Error("page.goto: net::ERR_CONNECTION_REFUSED http://localhost:3000/");
    const collectTimeline = mock(async () => {
      throw navigationError;
    });
    const replayTimeline = mock(async () => {});

    await expect(
      generateTour(
        {
          loadedConfig: createLoadedConfig("/tmp/project"),
          tourFile: createTourFile("/tmp/project"),
        },
      {
          attachDebugCapture: mock(() => createDebugCapture()),
          collectTimeline,
          playwright: {
            chromium: {
              launch: mock(async () => ({
                close: mock(async () => {}),
                newContext: mock(async () => ({
                  close: mock(async () => {}),
                  newPage: mock(async () => ({ goto: mock(async () => {}) })),
                })),
              })),
            },
            firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
            webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          },
          prepareOutputDir: mock(async () => "/tmp/project/.demohunter/billing-overview"),
          replayTimeline,
        },
      ),
    ).rejects.toBe(navigationError);

    expect(collectTimeline).toHaveBeenCalledTimes(1);
    expect(replayTimeline).not.toHaveBeenCalled();
  });

  test("surfaces narration resolution failures before the recorded pass starts", async () => {
    const narrationError = new Error(
      'Unable to resolve narration segment "Explain billing" because OPENAI_API_KEY is required.',
    );
    const collectTimeline = mock(async () => {
      throw narrationError;
    });
    const replayTimeline = mock(async () => {});

    await expect(
      generateTour(
        {
          loadedConfig: createLoadedConfig("/tmp/project"),
          tourFile: createTourFile("/tmp/project"),
        },
      {
          attachDebugCapture: mock(() => createDebugCapture()),
          collectTimeline,
          playwright: {
            chromium: {
              launch: mock(async () => ({
                close: mock(async () => {}),
                newContext: mock(async () => ({
                  close: mock(async () => {}),
                  newPage: mock(async () => ({ goto: mock(async () => {}) })),
                })),
              })),
            },
            firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
            webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          },
          prepareOutputDir: mock(async () => "/tmp/project/.demohunter/billing-overview"),
          replayTimeline,
        },
      ),
    ).rejects.toBe(narrationError);

    expect(collectTimeline).toHaveBeenCalledTimes(1);
    expect(replayTimeline).not.toHaveBeenCalled();
  });

  test("rethrows recorded-pass divergence and preserves it through screencast shutdown", async () => {
    const divergenceError = new ReplayTimelineError("Recorded pass diverged at entry 2", {
      actual: {
        chapterTitle: "Billing",
        kind: "step-start",
        title: "Actual step",
      },
      expected: {
        chapterTitle: "Billing",
        kind: "step-start",
        title: "Expected step",
      },
      index: 2,
      reason: "mismatch",
    });
    const stopScreencast = mock(async ({ primaryError }) => {
      throw primaryError;
    });
    const muxVideo = mock(async () => {
      throw new Error("should not mux after divergence");
    });
    const writeGenerationOutput = mock(async () => {
      throw new Error("should not write after divergence");
    });

    await expect(
      generateTour(
        {
          loadedConfig: createLoadedConfig("/tmp/project"),
          tourFile: createTourFile("/tmp/project"),
        },
      {
          attachDebugCapture: mock(() => createDebugCapture()),
          collectTimeline: mock(async () => createTimeline()),
          installRecordingEffects: mock(async () => {}),
          muxVideo,
          playwright: {
            chromium: {
              launch: mock(async () => ({
                close: mock(async () => {}),
                newContext: mock(async () => ({
                  close: mock(async () => {}),
                  newPage: mock(async () => ({ goto: mock(async () => {}) })),
                })),
              })),
            },
            firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
            webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          },
          prepareOutputDir: mock(async () => "/tmp/project/.demohunter/billing-overview"),
          replayTimeline: mock(async ({ onBeforeRun }) => {
            await onBeforeRun?.();
            throw divergenceError;
          }),
          startScreencast: mock(async () => {}),
          stopScreencast,
          writeGenerationOutput,
        },
      ),
    ).rejects.toBe(divergenceError);

    expect(stopScreencast).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryError: divergenceError,
      }),
    );
    expect(muxVideo).not.toHaveBeenCalled();
    expect(writeGenerationOutput).not.toHaveBeenCalled();
  });

  test("does not start recording or write debug artifacts when pre-record setup fails", async () => {
    const beforeRecordError = new Error("beforeRecord failed");
    const debugCapture = createDebugCapture();
    const attachDebugCapture = mock(() => debugCapture);
    const startScreencast = mock(async () => {});
    const stopScreencast = mock(async () => {});
    const muxVideo = mock(async () => {
      throw new Error("should not mux after pre-record failure");
    });
    const writeGenerationOutput = mock(async () => {
      throw new Error("should not write after pre-record failure");
    });

    await expect(
      generateTour(
        {
          loadedConfig: createLoadedConfig("/tmp/project"),
          tourFile: createTourFile("/tmp/project"),
        },
        {
          attachDebugCapture,
          collectTimeline: mock(async () => createTimeline()),
          installRecordingEffects: mock(async () => {}),
          muxVideo,
          playwright: {
            chromium: {
              launch: mock(async () => ({
                close: mock(async () => {}),
                newContext: mock(async () => ({
                  close: mock(async () => {}),
                  newPage: mock(async () => ({ goto: mock(async () => {}) })),
                })),
              })),
            },
            firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
            webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          },
          prepareOutputDir: mock(async () => "/tmp/project/.demohunter/billing-overview"),
          replayTimeline: mock(async () => {
            throw beforeRecordError;
          }),
          startScreencast,
          stopScreencast,
          writeGenerationOutput,
        },
      ),
    ).rejects.toBe(beforeRecordError);

    expect(startScreencast).not.toHaveBeenCalled();
    expect(stopScreencast).not.toHaveBeenCalled();
    expect(debugCapture.captureFailure).not.toHaveBeenCalled();
    expect(muxVideo).not.toHaveBeenCalled();
    expect(writeGenerationOutput).not.toHaveBeenCalled();
  });

  test("never closes a caller-owned narration registry", async () => {
    const failure = new Error("collect failed");
    const close = mock(async () => {});
    const registry = {
      close,
      has: () => true,
      names: () => ["custom"],
      register() { return this; },
      resolve() { throw new Error("not used"); },
    };

    await expect(generateTour(
      {
        loadedConfig: createLoadedConfig("/tmp/project"),
        narrationRegistry: registry,
        tourFile: createTourFile("/tmp/project"),
      },
      createFailingDependencies(failure),
    )).rejects.toBe(failure);
    expect(close).not.toHaveBeenCalled();
  });

  test("closes an internally-owned compatibility registry and aggregates close failure", async () => {
    const failure = new Error("collect failed");
    const closeFailure = new Error("provider close failed");
    const plugin: NarrationProviderPlugin = {
      name: "custom",
      capabilities: {
        offlineSynthesis: true,
        languages: "provider-defined",
        outputFormats: "provider-defined",
        sampleRates: "provider-defined",
        instructions: "provider-defined",
      },
      prepareRequest: (request) => request,
      async synthesize() { throw new Error("not used"); },
      async close() { throw closeFailure; },
    };

    const caught = await generateTour(
      {
        createLegacyNarrationRegistry: () => createNarrationProviderRegistry([plugin]),
        loadedConfig: createLoadedConfig("/tmp/project"),
        tourFile: createTourFile("/tmp/project"),
      },
      createFailingDependencies(failure),
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([failure, closeFailure]);
    expect((caught as Error).cause).toBe(failure);
  });

  test("does not launch or create a compatibility registry when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancel generation", "AbortError"));
    const createLegacyNarrationRegistry = mock(() => createNarrationProviderRegistry());
    const launch = mock(async () => { throw new Error("should not launch"); });

    await expect(generateTour(
      {
        createLegacyNarrationRegistry,
        loadedConfig: createLoadedConfig("/tmp/project"),
        signal: controller.signal,
        tourFile: createTourFile("/tmp/project"),
      },
      {
        playwright: {
          chromium: { launch },
          firefox: { launch },
          webkit: { launch },
        },
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(launch).not.toHaveBeenCalled();
    expect(createLegacyNarrationRegistry).not.toHaveBeenCalled();
  });
});

function createFailingDependencies(failure: Error) {
  return {
    attachDebugCapture: mock(() => createDebugCapture()),
    collectTimeline: mock(async () => { throw failure; }),
    playwright: {
      chromium: {
        launch: mock(async () => ({
          close: mock(async () => {}),
          newContext: mock(async () => ({
            close: mock(async () => {}),
            newPage: mock(async () => ({ goto: mock(async () => {}) })),
          })),
        })),
      },
      firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
      webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
    },
    prepareOutputDir: mock(async () => "/tmp/project/.demohunter/billing-overview"),
  };
}

function createLoadedConfig(
  projectRoot: string,
  overrides: Partial<GenerateLoadedConfig["config"]> = {},
) {
  const config = {
    baseURL: "http://localhost:3000",
    outputDir: path.join(projectRoot, ".demohunter"),
    cacheDir: path.join(projectRoot, ".demohunter/cache"),
    browser: "chromium" as const,
    viewport: { height: 720, width: 1280 },
    holdPaddingMs: 300,
    record: { container: "mp4" as const, format: "mp4" as const, showActions: true, showChapters: true },
    output: { formats: [] },
    tts: {
      provider: "openai" as const,
      model: "gpt-4o-mini-tts",
      voice: "marin",
      format: "mp3",
      instructions: "Speak clearly.",
    },
    ...overrides,
  };

  return {
    config,
    configPath: path.join(projectRoot, "demohunter.config.ts"),
    projectRoot,
  };
}

function createTimeline(): CollectedTimeline {
  return {
    entries: [
      {
        event: {
          chapterTitle: "Billing",
          id: "billing",
          kind: "chapter",
          outputDir: "/tmp/project/.demohunter/billing-overview",
          title: "Billing",
        },
        kind: "event",
        order: 1,
      },
      {
        event: {
          chapterTitle: "Billing",
          kind: "narrate",
          text: "Explain billing",
        },
        kind: "narration",
        order: 2,
        segment: {
          audioPath: "/tmp/project/.demohunter/cache/explain-billing.mp3",
          cacheKey: "explain-billing",
          chapterTitle: "Billing",
          durationMs: 1200,
          text: "Explain billing",
        },
      },
      {
        event: {
          chapterTitle: "Invoices",
          id: "invoices",
          kind: "chapter",
          outputDir: "/tmp/project/.demohunter/billing-overview",
          title: "Invoices",
        },
        kind: "event",
        order: 3,
      },
    ],
    narrations: [
      {
        chapterTitle: "Billing",
        audioPath: "/tmp/project/.demohunter/cache/explain-billing.mp3",
        cacheKey: "explain-billing",
        durationMs: 1200,
        text: "Explain billing",
      },
    ],
  };
}

function createDebugCapture() {
  return {
    captureFailure: mock(async () => ({
      directory: "/tmp/project/.demohunter/billing-overview/debug/failure",
      failureJsonPath: "/tmp/project/.demohunter/billing-overview/debug/failure/failure.json",
    })),
    dispose: mock(() => {}),
  };
}

function createTourFile(projectRoot: string) {
  return {
    path: path.join(projectRoot, "demos", "billing.tour.ts"),
    tour: {
      id: "billing-overview",
      title: "Billing overview",
      run: async ({ chapter }: { chapter: (title: string) => Promise<void> }) => {
        await chapter("Billing");
      },
    },
  };
}
