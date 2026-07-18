import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright";

import type {
  AssertVisibleOptions,
  ChapterOptions,
  DemoHunterAuthorNarrateWhile,
  DemoHunterAuthorRunContext,
  DemoHunterLifecycleContext,
  DemoHunterRunContext,
  HighlightOptions,
  NarrateOptions,
  DemoHunterNarrateWhile,
  DemoHunterNarrationTimeline,
  DemoHunterNarrateWhileTimeline,
  SnapshotOptions,
  TypeTextOptions,
  TypeTextPace,
  WaitForStableOptions,
} from "./runtime-types.js";
import * as sdk from "./index.js";
import { defineTour } from "./tour.js";

function expectType<T>(_value: T): void {}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function buildSdk(): Promise<void> {
  const processResult = Bun.spawn({
    cmd: [process.execPath, "x", "tsc", "-b", "packages/sdk/tsconfig.json", "--pretty", "false"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "SDK build failed");
  }
}

describe("defineTour", () => {
  test("ships a dedicated runtime types module for the authored contract", async () => {
    await expect(import("./runtime-types.js")).resolves.toBeDefined();
  });

  test("re-exports defineTour from the sdk entrypoint and exposes runtime types in dist declarations", async () => {
    expect(sdk.defineTour).toBe(defineTour);
    await buildSdk();

    const declarationPath = path.join(repoRoot, "packages/sdk/dist/index.d.ts");
    const declarations = await readFile(declarationPath, "utf8");

    expect(declarations).toContain('from "./runtime-types.js"');
    expect(declarations).toContain("DemoHunterLifecycleContext");
    expect(declarations).toContain("DemoHunterRunContext");
    expect(declarations).toContain("DemoHunterAuthorRunContext");
    expect(declarations).toContain("ChapterOptions");
    expect(declarations).toContain("NarrateOptions");
    expect(declarations).toContain("DemoHunterNarrateWhile");
    expect(declarations).toContain("DemoHunterAuthorNarrateWhile");
    expect(declarations).toContain("DemoHunterNarrationTimeline");
    expect(declarations).toContain("DemoHunterNarrateWhileTimeline");
    expect(declarations).toContain("TypeTextOptions");
    expect(declarations).toContain("TypeTextPace");
    expect(declarations).toContain("WaitForStableOptions");
    expect(declarations).toContain("HighlightOptions");
    expect(declarations).toContain("SnapshotOptions");
    expect(declarations).toContain("AssertVisibleOptions");
    expect(declarations).toContain("DemoHunterTour");

    await typecheckSdkConsumerTour();
  });

  test("returns the authored object unchanged while supporting top-level lifecycle hooks", async () => {
    const setup = async (_context: DemoHunterLifecycleContext) => {};
    const beforeRecord = async (_context: DemoHunterLifecycleContext) => {};
    const run = async (_context: DemoHunterAuthorRunContext) => {};
    const teardown = async (_context: DemoHunterLifecycleContext) => {};

    const authored = { id: "billing-overview", title: "Billing overview", setup, beforeRecord, run, teardown };
    const tour = defineTour(authored);

    expect(tour).toBe(authored);
    expect(tour.setup).toBe(setup);
    expect(tour.beforeRecord).toBe(beforeRecord);
    expect(tour.run).toBe(run);
    expect(tour.teardown).toBe(teardown);
  });

  test("exposes Playwright-native helper types directly on the run context", async () => {
    const locator = {} as Locator;
    const page = {} as Page;
    const config = {
      baseURL: "http://localhost:3000",
      browser: "chromium" as const,
      cacheDir: ".demohunter/cache",
      holdPaddingMs: 300,
      outputDir: ".demohunter",
      record: {
        container: "mp4" as const,
        format: "mp4" as const,
        showActions: true,
        showChapters: true,
      },
      output: { formats: [] },
      tts: {
        format: "mp3",
        instructions: "Speak clearly.",
        model: "gpt-4o-mini-tts",
        provider: "openai" as const,
        voice: "marin",
      },
      viewport: {
        height: 900,
        width: 1440,
      },
    };
    const goto = async () => null;

    const run = async ({
      config,
      goto,
      page,
      chapter,
      step,
      narrate,
      narrateWhile,
      waitForStable,
      highlight,
      snapshot,
      assertVisible,
    }: DemoHunterAuthorRunContext) => {
      expectType<typeof config>(config);
      expectType<(url: string | URL, options?: Parameters<Page["goto"]>[1]) => ReturnType<Page["goto"]>>(goto);
      expectType<Page>(page);
      expectType<(title: string, options?: ChapterOptions) => Promise<void>>(chapter);
      expectType<(title: string, fn: () => Promise<void> | void) => Promise<void>>(step);
      expectType<(text: string, options?: NarrateOptions) => Promise<void>>(narrate);
      expectType<DemoHunterAuthorNarrateWhile>(narrateWhile);
      expectType<(options?: WaitForStableOptions) => Promise<void>>(waitForStable);
      expectType<(target: Locator, options?: HighlightOptions) => Promise<void>>(highlight);
      expectType<(options?: SnapshotOptions) => Promise<void>>(snapshot);
      expectType<(target: Locator, options?: AssertVisibleOptions) => Promise<void>>(assertVisible);

      await chapter("Billing", { id: "billing" });
      await step("Open billing", async () => {
        await narrate("This is the billing dashboard.", {
          cacheKeyHint: "billing-dashboard",
          format: "mp3_44100_128",
          instructions: "Speak clearly.",
          model: "eleven_multilingual_v2",
          voice: "marin",
          voiceSettings: {
            stability: 0.45,
          },
        });
        await narrateWhile("Now the dashboard updates while narration continues.", async ({ sleep, typeText }) => {
          expectType<DemoHunterNarrationTimeline["sleep"]>(sleep);
          expectType<DemoHunterNarrateWhileTimeline["typeText"]>(typeText);
          expectType<TypeTextPace>("natural");
          expectType<TypeTextOptions>({ pace: "natural", replace: true, seed: "billing", timeoutMs: 1500 });
          await sleep(750);
          await typeText(locator, "Acme", { pace: "natural", replace: true });
        });
        await waitForStable({ state: "networkidle", timeoutMs: 5000 });
        await highlight(locator, { name: "Primary CTA", paddingPx: 12 });
        await snapshot({ name: "billing-dashboard" });
        await assertVisible(locator, { timeoutMs: 1500 });
      });
    };

    const setup = async ({ page }: DemoHunterLifecycleContext) => {
      expectType<Page>(page);
    };

    const beforeRecord = async ({ goto, page }: DemoHunterLifecycleContext) => {
      expectType<Page>(page);
      expectType<DemoHunterLifecycleContext["goto"]>(goto);
    };

    const teardown = async ({ page }: DemoHunterLifecycleContext) => {
      expectType<Page>(page);
    };

    const sleepOnlyTimeline: DemoHunterNarrationTimeline = {
      sleep: async () => undefined,
    };
    expectType<DemoHunterNarrationTimeline>(sleepOnlyTimeline);

    const legacyNarrateWhile: DemoHunterNarrateWhile = async (_text, fn) => fn(sleepOnlyTimeline);
    const legacyRunContext: DemoHunterRunContext = {
      config,
      goto,
      page,
      chapter: async () => undefined,
      step: async (_title, fn) => {
        await fn();
      },
      narrate: async () => undefined,
      narrateWhile: legacyNarrateWhile,
      waitForStable: async () => undefined,
      highlight: async () => undefined,
      snapshot: async () => undefined,
      assertVisible: async () => undefined,
      click: async () => undefined,
    };
    expectType<DemoHunterRunContext>(legacyRunContext);

    await run({
      config,
      goto,
      page,
      chapter: async () => undefined,
      step: async (_title, fn) => {
        await fn();
      },
      narrate: async () => undefined,
      narrateWhile: async (_text, fn) =>
        fn({
          sleep: async () => undefined,
          typeText: async () => undefined,
        }),
      waitForStable: async () => undefined,
      highlight: async () => undefined,
      snapshot: async () => undefined,
      assertVisible: async () => undefined,
      click: async () => undefined,
    });

    await setup({ config, goto, page });
    await beforeRecord({ config, goto, page });
    await teardown({ config, goto, page });
  });
});

async function typecheckSdkConsumerTour(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "demohunter-sdk-entrypoint-"));

  try {
    const fixturePath = path.join(tempDir, "consumer.tour.ts");
    const tsconfigPath = path.join(tempDir, "tsconfig.json");
    await writeFile(
      fixturePath,
      `import {
  defineTour,
  type DemoHunterNarrateWhile,
  type DemoHunterNarrationTimeline,
  type DemoHunterRunContext,
  type TypeTextOptions,
} from "@demohunter/sdk";

const sleepOnlyTimeline: DemoHunterNarrationTimeline = {
  sleep: async () => undefined,
};

const legacyNarrateWhile: DemoHunterNarrateWhile = async (_text, fn) => fn(sleepOnlyTimeline);

export default defineTour({
  id: "sdk-consumer-natural-typing",
  title: "SDK consumer natural typing",
  async run({ page, narrateWhile }) {
    await narrateWhile("Enter the customer name.", async ({ sleep, typeText }) => {
      const options: TypeTextOptions = {
        pace: "natural",
        replace: true,
        seed: "sdk-consumer-natural-typing",
        timeoutMs: 1500,
      };

      await sleep(250);
      await typeText(page.getByLabel("Customer"), "Acme", options);
    });
  },
});

const legacyRunContext = {
  config: {
    baseURL: "http://localhost:3000",
    browser: "chromium",
    cacheDir: ".demohunter/cache",
    holdPaddingMs: 300,
    outputDir: ".demohunter",
    record: {
      container: "mp4",
      format: "mp4",
      showActions: true,
      showChapters: true,
    },
    output: { formats: [] },
    tts: {
      format: "mp3",
      instructions: "Speak clearly.",
      model: "gpt-4o-mini-tts",
      provider: "openai",
      voice: "marin",
    },
    viewport: {
      height: 900,
      width: 1440,
    },
  },
  goto: async () => null,
  page: {} as DemoHunterRunContext["page"],
  chapter: async () => undefined,
  step: async (_title, fn) => {
    return fn();
  },
  narrate: async () => undefined,
  narrateWhile: legacyNarrateWhile,
  waitForStable: async () => undefined,
  highlight: async () => undefined,
  snapshot: async () => undefined,
  assertVisible: async () => undefined,
  click: async () => undefined,
} satisfies DemoHunterRunContext;

void legacyRunContext;
`,
    );
    await writeFile(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            noEmit: true,
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ESNext"],
            types: ["node"],
            typeRoots: [path.join(repoRoot, "node_modules", "@types")],
            skipLibCheck: true,
            baseUrl: repoRoot,
            paths: {
              "@demohunter/sdk": ["packages/sdk/dist/index.d.ts"],
            },
          },
          files: [fixturePath],
        },
        null,
        2,
      )}\n`,
    );

    const processResult = Bun.spawn({
      cmd: [process.execPath, "x", "tsc", "-p", tsconfigPath],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(stderr || stdout || "SDK consumer fixture typecheck failed.");
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}
