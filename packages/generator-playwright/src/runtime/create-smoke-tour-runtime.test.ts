import { describe, expect, mock, test } from "bun:test";

import type {
  CollectedNarration,
  CollectedTimeline,
  CollectedTimelineEntry,
  NarrationSegment,
  NarrationSegmentResolver,
  TourRuntimeEvent,
} from "../execute/generator-types.js";
import {
  COLLECTED_TIMELINE_ENTRY_KINDS,
  TOUR_RUNTIME_EVENT_KINDS,
} from "../execute/generator-types.js";
import { createSmokeLifecycleContext, createSmokeTourRuntime } from "./create-smoke-tour-runtime.js";

const assertTourRuntimeEvent = <T extends TourRuntimeEvent>(event: T): T => event;
const assertCollectedNarration = <T extends CollectedNarration>(entry: T): T => entry;
const assertCollectedTimelineEntry = <T extends CollectedTimelineEntry>(entry: T): T => entry;
const assertCollectedTimeline = <T extends CollectedTimeline>(timeline: T): T => timeline;
const assertNarrationSegment = <T extends NarrationSegment>(segment: T): T => segment;
const assertNarrationSegmentResolver = <T extends NarrationSegmentResolver>(resolver: T): T => resolver;

describe("createSmokeTourRuntime", () => {
  test("creates a lifecycle context that shares custom state without exposing timeline helpers", async () => {
    const events: unknown[] = [];
    const runtime = createSmokeTourRuntime({
      config: createConfig(),
      page: {} as never,
      outputDir: "/tmp/demohunter-output",
      onEvent: (event) => {
        events.push(event);
      },
    });
    const lifecycleContext = createSmokeLifecycleContext(runtime);

    (lifecycleContext as Record<string, unknown>).marker = "shared";

    expect(lifecycleContext.config).toBe(runtime.config);
    expect(lifecycleContext.goto).toBe(runtime.goto);
    expect(lifecycleContext.page).toBe(runtime.page);
    expect((runtime as Record<string, unknown>).marker).toBe("shared");
    expect("narrate" in lifecycleContext).toBe(false);
    expect((lifecycleContext as Record<string, unknown>).narrate).toBeUndefined();

    await runtime.narrate("Runtime narration still works");

    expect(events).toEqual([
      {
        kind: "narrate",
        text: "Runtime narration still works",
      },
    ]);
  });

  test("records chapter markers and runs steps inline", async () => {
    const events: unknown[] = [];
    const runtime = createSmokeTourRuntime({
      config: createConfig(),
      page: {} as never,
      outputDir: "/tmp/demohunter-output",
      onEvent: (event) => {
        events.push(event);
      },
    });

    await runtime.chapter("Billing");
    const result = await runtime.step("Open invoice view", async () => "step-result");

    expect(result).toBe("step-result");
    expect(events).toEqual([
      {
        chapterTitle: "Billing",
        kind: "chapter",
        outputDir: "/tmp/demohunter-output",
        title: "Billing",
      },
      {
        chapterTitle: "Billing",
        kind: "step-start",
        title: "Open invoice view",
      },
      {
        chapterTitle: "Billing",
        kind: "step-end",
        title: "Open invoice view",
      },
    ]);
  });

  test("uses Playwright-native methods for stability, highlighting, snapshots, and visibility", async () => {
    const events: unknown[] = [];
    const waitForTimeout = mock(async () => {});
    const waitForLoadState = mock(async () => {});
    const page = {
      goto: mock(async () => null),
      waitForLoadState,
      waitForTimeout,
    } as never;
    const waitFor = mock(async () => {});
    const scrollIntoViewIfNeeded = mock(async () => {});
    const locator = {
      scrollIntoViewIfNeeded,
      waitFor,
    } as never;
    const runtime = createSmokeTourRuntime({
      config: createConfig(),
      page,
      outputDir: "/tmp/demohunter-output",
      onEvent: (event) => {
        events.push(event);
      },
    });

    await runtime.waitForStable({ state: "load", timeoutMs: 2500 });
    await runtime.highlight(locator, { name: "CTA", paddingPx: 12 });
    await runtime.snapshot({ name: "hero" });
    await runtime.assertVisible(locator, { timeoutMs: 800 });
    await runtime.narrate("Describe the screen", { voice: "marin" });
    await runtime.narrateWhile("Describe the transition", async ({ sleep }) => {
      await sleep(900);
      await runtime.snapshot({ name: "transition" });
    }, { cacheKeyHint: "transition" });
    await runtime.goto("/billing");

    expect(page.goto).toHaveBeenCalledWith("http://localhost:3000/billing", undefined);
    expect(waitForLoadState).toHaveBeenCalledWith("load", { timeout: 2500 });
    expect(waitForTimeout).toHaveBeenCalledWith(900);
    expect(waitFor).toHaveBeenCalledTimes(2);
    expect(waitFor.mock.calls[0]).toEqual([{ state: "visible" }]);
    expect(waitFor.mock.calls[1]).toEqual([{ state: "visible", timeout: 800 }]);
    expect(scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        kind: "wait-for-stable",
        state: "load",
        timeoutMs: 2500,
      },
      {
        kind: "highlight",
        name: "CTA",
        paddingPx: 12,
      },
      {
        kind: "snapshot",
        name: "hero",
      },
      {
        kind: "assert-visible",
        timeoutMs: 800,
      },
      {
        kind: "narrate",
        text: "Describe the screen",
        voice: "marin",
      },
      {
        cacheKeyHint: "transition",
        kind: "narrate",
        text: "Describe the transition",
      },
      {
        durationMs: 900,
        kind: "narration-sleep",
      },
      {
        kind: "snapshot",
        name: "transition",
      },
    ]);
  });

  test("awaits navigation middleware after runtime.goto", async () => {
    const calls: string[] = [];
    const page = {
      goto: mock(async () => {
        calls.push("goto");
        return null;
      }),
    } as never;
    const runtime = createSmokeTourRuntime({
      afterNavigation: async () => {
        calls.push("middleware");
      },
      config: createConfig(),
      page,
      outputDir: "/tmp/demohunter-output",
    });

    await runtime.goto("/after-navigation");

    expect(calls).toEqual(["goto", "middleware"]);
  });

  test("types text incrementally inside narrateWhile with deterministic sleep events", async () => {
    const events: unknown[] = [];
    const waitForTimeout = mock(async () => {});
    const page = {
      waitForTimeout,
    } as never;
    const press = mock(async () => {});
    const pressSequentially = mock(async () => {});
    const locator = {
      press,
      pressSequentially,
    } as never;
    const runtime = createSmokeTourRuntime({
      config: createConfig(),
      page,
      outputDir: "/tmp/demohunter-output",
      onEvent: (event) => {
        events.push(event);
      },
    });

    const pace = {
      maxDelayMs: 10,
      minDelayMs: 10,
      punctuationPauseMs: 7,
      spacePauseMs: 5,
    };

    await runtime.narrateWhile("Type the customer name", async ({ typeText }) => {
      await typeText(locator, "A b.", {
        pace,
        replace: true,
        timeoutMs: 1234,
      });
    });
    pace.maxDelayMs = 999;

    expect(press.mock.calls).toEqual([
      ["ControlOrMeta+A", { timeout: 1234 }],
      ["Backspace", { timeout: 1234 }],
    ]);
    expect(pressSequentially.mock.calls).toEqual([
      ["A", { timeout: 1234 }],
      [" ", { timeout: 1234 }],
      ["b", { timeout: 1234 }],
      [".", { timeout: 1234 }],
    ]);
    expect(waitForTimeout.mock.calls).toEqual([[10], [15], [10]]);
    expect(events).toEqual([
      {
        kind: "narrate",
        text: "Type the customer name",
      },
      {
        delaysMs: [10, 15, 10],
        kind: "type-text",
        pace: {
          maxDelayMs: 10,
          minDelayMs: 10,
          punctuationPauseMs: 7,
          spacePauseMs: 5,
        },
        replace: true,
        text: "A b.",
        timeoutMs: 1234,
      },
      {
        durationMs: 10,
        kind: "narration-sleep",
      },
      {
        durationMs: 15,
        kind: "narration-sleep",
      },
      {
        durationMs: 10,
        kind: "narration-sleep",
      },
    ]);
  });

  test("rejects invalid custom typeText pace options with a clear error", async () => {
    const runtime = createSmokeTourRuntime({
      config: createConfig(),
      page: {} as never,
      outputDir: "/tmp/demohunter-output",
    });
    const locator = {
      press: mock(async () => {}),
      pressSequentially: mock(async () => {}),
    } as never;

    await expect(
      runtime.narrateWhile("Type invalid text", async ({ typeText }) => {
        await typeText(locator, "A", {
          pace: {
            maxDelayMs: 10,
            minDelayMs: 20,
          },
        });
      }),
    ).rejects.toThrow("typeText pace.minDelayMs must be less than or equal to pace.maxDelayMs");

    await expect(
      runtime.narrateWhile("Type missing min delay", async ({ typeText }) => {
        await typeText(locator, "A", {
          pace: {
            maxDelayMs: 10,
          } as never,
        });
      }),
    ).rejects.toThrow("typeText pace.minDelayMs must be a non-negative finite number: undefined");

    await expect(
      runtime.narrateWhile("Type null pace", async ({ typeText }) => {
        await typeText(locator, "A", {
          pace: null as never,
        });
      }),
    ).rejects.toThrow('typeText pace must be "fast", "natural", "slow", or a custom pace object.');

    await expect(
      runtime.narrateWhile("Type non-string text", async ({ typeText }) => {
        await typeText(locator, 123 as never);
      }),
    ).rejects.toThrow("typeText text must be a string: 123");

    await expect(
      runtime.narrateWhile("Type primitive options", async ({ typeText }) => {
        await typeText(locator, "A", "natural" as never);
      }),
    ).rejects.toThrow("typeText options must be an object when provided.");

    await expect(
      runtime.narrateWhile("Type invalid seed", async ({ typeText }) => {
        await typeText(locator, "A", {
          seed: {} as never,
        });
      }),
    ).rejects.toThrow("typeText seed must be a string or number when provided");

    await expect(
      runtime.narrateWhile("Type symbol text", async ({ typeText }) => {
        await typeText(locator, Symbol("bad") as never);
      }),
    ).rejects.toThrow("typeText text must be a string: Symbol(bad)");

    await expect(
      runtime.narrateWhile("Type symbol seed", async ({ typeText }) => {
        await typeText(locator, "A", {
          seed: Symbol("bad") as never,
        });
      }),
    ).rejects.toThrow("typeText seed must be a string or number when provided: Symbol(bad)");

    const unformattableValue = {
      get [Symbol.toStringTag]() {
        throw new Error("toStringTag failed");
      },
      toString() {
        throw new Error("toString failed");
      },
    };

    await expect(
      runtime.narrateWhile("Type unformattable seed", async ({ typeText }) => {
        await typeText(locator, "A", {
          seed: unformattableValue as never,
        });
      }),
    ).rejects.toThrow(
      "typeText seed must be a string or number when provided: [unformattable value]",
    );
  });

  test("shares Phase 3 event and timeline contracts with the runtime helpers", async () => {
    const chapterEvent = assertTourRuntimeEvent({
      chapterTitle: "Billing",
      kind: "chapter",
      outputDir: "/tmp/demohunter-output",
      title: "Billing",
    });
    const segment = assertNarrationSegment({
      audioPath: "/tmp/demohunter-output/cache/describe-invoice.mp3",
      cacheKey: "describe-invoice",
      chapterTitle: "Billing",
      durationMs: 1200,
      text: "Describe the invoice",
    });
    const narration = assertCollectedNarration({
      event: {
        chapterTitle: "Billing",
        kind: "narrate",
        text: "Describe the invoice",
        voice: "marin",
      },
      kind: "narration",
      order: 3,
      segment,
    });
    const entries = [
      assertCollectedTimelineEntry({
        event: chapterEvent,
        kind: "event",
        order: 1,
      }),
      narration,
    ];
    const resolveNarrationSegment = assertNarrationSegmentResolver(async () => segment);
    const timeline = assertCollectedTimeline({
      entries,
      narrations: [segment],
    });

    const resolvedSegment = await resolveNarrationSegment(narration.event);

    expect(TOUR_RUNTIME_EVENT_KINDS).toEqual([
      "chapter",
      "step-start",
      "step-end",
      "narrate",
      "type-text",
      "narration-sleep",
      "wait-for-stable",
      "highlight",
      "snapshot",
      "assert-visible",
    ]);
    expect(COLLECTED_TIMELINE_ENTRY_KINDS).toEqual(["event", "narration"]);
    expect(timeline.entries).toHaveLength(2);
    expect(timeline.narrations).toEqual([segment]);
    expect(timeline.entries[0]).toEqual({
      event: chapterEvent,
      kind: "event",
      order: 1,
    });
    expect(resolvedSegment.durationMs).toBe(1200);
  });
});

function createConfig() {
  return {
    baseURL: "http://localhost:3000",
    browser: "chromium" as const,
    cacheDir: "/tmp/demohunter-output/cache",
    holdPaddingMs: 300,
    outputDir: "/tmp/demohunter-output",
    record: {
      format: "mp4" as const,
      showActions: true,
      showChapters: true,
    },
    tts: {
      format: "mp3",
      instructions: "Speak clearly.",
      model: "gpt-4o-mini-tts",
      provider: "openai" as const,
      voice: "marin",
    },
    viewport: {
      height: 720,
      width: 1280,
    },
  };
}
