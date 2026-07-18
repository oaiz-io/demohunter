import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import { collectTimeline } from "./collect-timeline.js";

describe("collectTimeline", () => {
  test("reuses one runtime across goto, setup, run, and teardown while collecting ordered replay entries", async () => {
    const page = {
      goto: mock(async () => {}),
      waitForTimeout: mock(async () => {}),
      waitForLoadState: mock(async () => {}),
    };
    const locator = {
      scrollIntoViewIfNeeded: mock(async () => {}),
      waitFor: mock(async () => {}),
    };
    const calls: string[] = [];
    const contexts: object[] = [];
    const resolveNarrationSegment = mock(async (event) => ({
      audioPath: "/tmp/workspace/.demohunter/cache/narration.mp3",
      cacheKey: "cache-key",
      chapterTitle: event.chapterTitle,
      durationMs: 1200,
      text: event.text,
    }));
    const setup = mock(async (context) => {
      calls.push(`setup:${context.page === page}`);
      contexts.push(context as object);
      (context as Record<string, unknown>).marker = "shared";
    });
    const beforeRecord = mock(async (context) => {
      calls.push(`beforeRecord:${context.page === page}`);
      contexts.push(context as object);
      expect((context as Record<string, unknown>).marker).toBe("shared");
      expect("narrate" in context).toBe(false);
    });
    const run = mock(
      async (context) => {
        const { page: runtimePage, chapter, step, narrate, waitForStable, highlight, snapshot, assertVisible } =
          context;

        calls.push(`run:${runtimePage === page}`);
        contexts.push(context as object);
        expect((context as Record<string, unknown>).marker).toBe("shared");
        await chapter("Billing", { id: "billing" });
        await step("Open invoice view", async () => {
          calls.push("step");
          await narrate("Explain the invoice screen", { voice: "marin" });
          await waitForStable({ state: "load", timeoutMs: 2500 });
          await context.narrateWhile("Explain the transition", async ({ sleep }) => {
            await sleep(500);
            await snapshot({ name: "during-transition" });
          }, { cacheKeyHint: "transition" });
          await highlight(locator as never, { name: "CTA", paddingPx: 12 });
          await snapshot({ name: "invoice" });
          await assertVisible(locator as never, { timeoutMs: 800 });
        });
      },
    );
    const teardown = mock(async (context) => {
      calls.push(`teardown:${context.page === page}`);
      contexts.push(context as object);
      expect((context as Record<string, unknown>).marker).toBe("shared");
    });
    const cookieMiddleware = {
      afterSetup: mock(async () => {
        calls.push("cookie:after-setup");
      }),
      afterNavigation: mock(async () => {
        calls.push("cookie:after-navigation");
      }),
    };

    const timeline = await collectTimeline({
      loadedConfig: createLoadedConfig("/tmp/workspace"),
      cookieMiddleware,
      onBeforeRun: () => {
        calls.push("before-run");
      },
      page: page as never,
      resolveNarrationSegment,
      tourFile: {
        path: "/tmp/workspace/demos/billing.tour.ts",
        tour: {
          id: "billing-overview",
          beforeRecord,
          run,
          setup,
          teardown,
          title: "Billing overview",
        },
      },
    });

    expect(page.goto).toHaveBeenCalledWith("http://localhost:3000/");
    expect(resolveNarrationSegment).toHaveBeenCalledWith({
      chapterTitle: "Billing",
      kind: "narrate",
      text: "Explain the invoice screen",
      voice: "marin",
    }, undefined);
    expect(calls).toEqual([
      "setup:true",
      "cookie:after-setup",
      "beforeRecord:true",
      "before-run",
      "run:true",
      "step",
      "teardown:true",
    ]);
    expect(contexts).toHaveLength(4);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0]).not.toBe(contexts[2]);
    expect(contexts[2]).toBe(contexts[3]);
    expect(page.waitForLoadState).toHaveBeenCalledWith("load", { timeout: 2500 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
    expect(locator.waitFor).toHaveBeenCalledTimes(2);
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual({
      entries: [
        {
          event: {
            chapterTitle: "Billing",
            id: "billing",
            kind: "chapter",
            outputDir: path.join("/tmp/workspace/.demohunter", "billing-overview"),
            title: "Billing",
          },
          kind: "event",
          order: 1,
        },
        {
          event: {
            chapterTitle: "Billing",
            kind: "step-start",
            title: "Open invoice view",
          },
          kind: "event",
          order: 2,
        },
        {
          event: {
            chapterTitle: "Billing",
            kind: "narrate",
            text: "Explain the invoice screen",
            voice: "marin",
          },
          kind: "narration",
          order: 3,
          segment: {
            audioPath: "/tmp/workspace/.demohunter/cache/narration.mp3",
            cacheKey: "cache-key",
            chapterTitle: "Billing",
            durationMs: 1200,
            text: "Explain the invoice screen",
          },
        },
        {
          event: {
            chapterTitle: "Billing",
            kind: "wait-for-stable",
            state: "load",
            timeoutMs: 2500,
          },
          kind: "event",
          order: 4,
        },
        {
          event: {
            chapterTitle: "Billing",
            cacheKeyHint: "transition",
            kind: "narrate",
            text: "Explain the transition",
          },
          kind: "narration",
          order: 5,
          segment: {
            audioPath: "/tmp/workspace/.demohunter/cache/narration.mp3",
            cacheKey: "cache-key",
            chapterTitle: "Billing",
            durationMs: 1200,
            text: "Explain the transition",
          },
        },
        {
          event: {
            chapterTitle: "Billing",
            durationMs: 500,
            kind: "narration-sleep",
          },
          kind: "event",
          order: 6,
        },
        {
          event: {
            chapterTitle: "Billing",
            kind: "snapshot",
            name: "during-transition",
          },
          kind: "event",
          order: 7,
        },
        {
          event: {
            chapterTitle: "Billing",
            kind: "highlight",
            name: "CTA",
            paddingPx: 12,
          },
          kind: "event",
          order: 8,
        },
        {
          event: {
            chapterTitle: "Billing",
            kind: "snapshot",
            name: "invoice",
          },
          kind: "event",
          order: 9,
        },
        {
          event: {
            chapterTitle: "Billing",
            kind: "assert-visible",
            timeoutMs: 800,
          },
          kind: "event",
          order: 10,
        },
        {
          event: {
            chapterTitle: "Billing",
            kind: "step-end",
            title: "Open invoice view",
          },
          kind: "event",
          order: 11,
        },
      ],
      narrations: [
        {
          chapterTitle: "Billing",
          audioPath: "/tmp/workspace/.demohunter/cache/narration.mp3",
          cacheKey: "cache-key",
          durationMs: 1200,
          text: "Explain the invoice screen",
        },
        {
          chapterTitle: "Billing",
          audioPath: "/tmp/workspace/.demohunter/cache/narration.mp3",
          cacheKey: "cache-key",
          durationMs: 1200,
          text: "Explain the transition",
        },
      ],
    });
  });

  test("fails clearly when uncached narration requires OPENAI_API_KEY", async () => {
    const page = {
      goto: mock(async () => {}),
    };

    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await expect(
        collectTimeline({
          loadedConfig: createLoadedConfig("/tmp/workspace"),
          page: page as never,
          tourFile: {
            path: "/tmp/workspace/demos/billing.tour.ts",
            tour: {
              id: "billing-overview",
              title: "Billing overview",
              run: async ({ narrate }) => {
                await narrate("Resolve real narration");
              },
            },
          },
        }),
      ).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });

  test("passes adjacent ElevenLabs narration text only between compatible resolved identities", async () => {
    const page = {
      goto: mock(async () => {}),
    };
    const calls: Array<{
      text: string;
      context: unknown;
    }> = [];
    const resolveNarrationSegment = mock(async (event, context) => {
      calls.push({
        text: event.text,
        context,
      });

      return {
        audioPath: `/tmp/workspace/.demohunter/cache/${event.text}.mp3`,
        cacheKey: event.text,
        chapterTitle: event.chapterTitle,
        durationMs: 1200,
        text: event.text,
      };
    });

    await collectTimeline({
      loadedConfig: createLoadedConfig("/tmp/workspace", {
        provider: "elevenlabs",
        model: "eleven_multilingual_v2",
        voice: "default-voice",
        format: "mp3_44100_128",
        instructions: "",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          useSpeakerBoost: true,
        },
      }),
      page: page as never,
      resolveNarrationSegment,
      tourFile: {
        path: "/tmp/workspace/demos/billing.tour.ts",
        tour: {
          id: "billing-overview",
          title: "Billing overview",
          run: async ({ narrate }) => {
            await narrate("First");
            await narrate("Second");
            await narrate("Third", { voice: "alternate-voice" });
            await narrate("Fourth", { voice: "alternate-voice" });
            await narrate("Fifth", { model: "eleven_flash_v2_5" });
          },
        },
      },
    });

    expect(calls).toEqual([
      {
        text: "First",
        context: {
          nextText: "Second",
        },
      },
      {
        text: "Second",
        context: {
          previousText: "First",
        },
      },
      {
        text: "Third",
        context: {
          nextText: "Fourth",
        },
      },
      {
        text: "Fourth",
        context: {
          previousText: "Third",
        },
      },
      {
        text: "Fifth",
        context: undefined,
      },
    ]);
  });

  test("still runs teardown when the tour fails and rethrows the primary error", async () => {
    const page = {
      goto: mock(async () => {}),
    };
    const calls: string[] = [];
    const failure = new Error("run failed");

    await expect(
      collectTimeline({
        loadedConfig: createLoadedConfig("/tmp/workspace"),
        page: page as never,
        tourFile: {
          path: "/tmp/workspace/demos/billing.tour.ts",
          tour: {
            id: "billing-overview",
            title: "Billing overview",
            setup: async () => {
              calls.push("setup");
            },
            run: async () => {
              calls.push("run");
              throw failure;
            },
            teardown: async () => {
              calls.push("teardown");
            },
          },
        },
      }),
    ).rejects.toThrow("run failed");

    expect(calls).toEqual(["setup", "run", "teardown"]);
  });
});

function createLoadedConfig(
  projectRoot: string,
  tts: {
    provider: "openai";
    model: string;
    voice: string;
    format: string;
    instructions: string;
    language?: string;
  } | {
    provider: "elevenlabs";
    model: string;
    voice: string;
    format: string;
    instructions: string;
    language?: string;
    voiceSettings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      useSpeakerBoost?: boolean;
      speed?: number;
    };
  } = {
    provider: "openai" as const,
    model: "gpt-4o-mini-tts",
    voice: "marin",
    format: "mp3",
    instructions: "Speak clearly.",
  },
) {
  return {
    config: {
      baseURL: "http://localhost:3000",
      outputDir: path.join(projectRoot, ".demohunter"),
      cacheDir: path.join(projectRoot, ".demohunter/cache"),
      browser: "chromium" as const,
      viewport: { width: 1280, height: 720 },
      holdPaddingMs: 300,
      record: { format: "mp4" as const, showActions: true, showChapters: true },
      tts,
    },
    configPath: path.join(projectRoot, "demohunter.config.ts"),
    projectRoot,
  };
}
