import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_DEMOHUNTER_CONFIG,
  DEFAULT_KOKORO_TTS_CONFIG,
  DEFAULT_RECORD_CONFIG,
  DEFAULT_TTS_CONFIG,
} from "../../../sdk/src/index.js";
import type { NarrationProviderPlugin } from "../../../tts-core/src/index.js";
import { generateCommand, locateBundledKokoroWorker } from "./generate.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("generateCommand", () => {
  test("applies cookie dismissal overrides without mutating the loaded config", async () => {
    const cwd = await makeTempProject();
    const loadedConfig = makeLoadedConfig(cwd);
    const generateTour = mock(async () => ({
      outputDir: path.join(cwd, ".demohunter/sample-smoke"),
      videoPath: path.join(cwd, ".demohunter/sample-smoke/video.mp4"),
    }));

    await generateCommand(
      cwd,
      "demos/sample.tour.ts",
      { cookieDismiss: "accept" },
      {
        generateTour,
        loadConfig: async () => loadedConfig,
        log: () => {},
      },
    );

    expect(generateTour.mock.calls[0]?.[0].loadedConfig.config.record.cookieBanners).toEqual({
      enabled: true,
      action: "accept",
      timeoutMs: 750,
      additionalSelectors: [],
    });
    expect(loadedConfig.config.record.cookieBanners?.enabled).toBe(false);
  });

  test("resolves cursor presets as immutable generation overrides", async () => {
    const cwd = await makeTempProject();
    const loadedConfig = makeLoadedConfig(cwd);
    const generateTour = mock(async () => ({
      outputDir: path.join(cwd, ".demohunter/sample-smoke"),
      videoPath: path.join(cwd, ".demohunter/sample-smoke/video.mp4"),
    }));

    await generateCommand(
      cwd,
      "demos/sample.tour.ts",
      { cursor: "smooth" },
      { generateTour, loadConfig: async () => loadedConfig, log: () => {} },
    );

    expect(generateTour.mock.calls[0]?.[0].loadedConfig.config.record.cursor).toEqual({
      mode: "smooth",
      shape: "pointer",
      color: "#3b82f6",
      sizePx: 20,
      minDurationMs: 400,
      maxDurationMs: 1200,
      pixelsPerMs: 1.4,
      arcHeightPx: 56,
      ripple: false,
    });

    await generateCommand(
      cwd,
      "demos/sample.tour.ts",
      { cursor: "none" },
      { generateTour, loadConfig: async () => loadedConfig, log: () => {} },
    );

    expect(generateTour.mock.calls[1]?.[0].loadedConfig.config.record.cursor).toBe(false);
    expect(loadedConfig.config.record.cursor).toEqual(DEFAULT_RECORD_CONFIG.cursor);
  });

  test("applies output format overrides without mutating config formats", async () => {
    const cwd = await makeTempProject();
    const loadedConfig = makeLoadedConfig(cwd);
    const generateTour = mock(async () => ({
      outputDir: path.join(cwd, ".demohunter/sample-smoke"),
      videoPath: path.join(cwd, ".demohunter/sample-smoke/video.mp4"),
    }));

    await generateCommand(
      cwd,
      "demos/sample.tour.ts",
      { formats: [{ preset: "square" }, { preset: "gif", durationMs: 10_000 }] },
      { generateTour, loadConfig: async () => loadedConfig, log: () => {} },
    );

    expect(generateTour.mock.calls[0]?.[0].loadedConfig.config.output.formats).toEqual([
      { preset: "square", layout: "fit" },
      { preset: "gif", layout: "fit", durationMs: 10_000 },
    ]);
    expect(loadedConfig.config.output.formats).toEqual([]);
  });

  test("loads the requested tour file and forwards a valid phase 3 tour to generateTour", async () => {
    const cwd = await makeTempProject();
    const tourPath = path.join(cwd, "demos", "sample.tour.ts");
    const generateTour = mock(async () => ({
      outputDir: path.join(cwd, ".demohunter/sample-smoke"),
      videoPath: path.join(cwd, ".demohunter/sample-smoke/video.mp4"),
    }));
    const log = mock(() => {});

    await generateCommand(cwd, "demos/sample.tour.ts", {
      generateTour,
      loadConfig: async () => makeLoadedConfig(cwd),
      log,
    });

    expect(generateTour).toHaveBeenCalledTimes(1);
    expect(generateTour.mock.calls[0]?.[0]).toEqual({
      loadedConfig: makeLoadedConfig(cwd),
      narrationRegistry: expect.objectContaining({
        close: expect.any(Function),
        register: expect.any(Function),
        resolve: expect.any(Function),
      }),
      onProgress: expect.any(Function),
      tourFile: {
        path: tourPath,
        tour: {
          id: "sample-smoke",
          beforeRecord: expect.any(Function),
          setup: expect.any(Function),
          title: "Sample",
          teardown: expect.any(Function),
          run: expect.any(Function),
        },
      },
    });
    expect(log).toHaveBeenCalledWith(`Generated video: ${path.join(cwd, ".demohunter/sample-smoke/video.mp4")}`);
  });

  test("runs dry-run generation through the flow validator", async () => {
    const cwd = await makeTempProject();
    const generateTour = mock(async () => {
      throw new Error("full generation should not run");
    });
    const smokeGenerate = mock(async () => ({
      outputPath: path.join(cwd, ".demohunter/sample-smoke/smoke-run.json"),
    }));
    const log = mock(() => {});

    await generateCommand(
      cwd,
      "demos/sample.tour.ts",
      { dryRun: true },
      {
        generateTour,
        loadConfig: async () => makeLoadedConfig(cwd),
        log,
        smokeGenerate,
      },
    );

    expect(smokeGenerate).toHaveBeenCalledWith({
      loadedConfig: makeLoadedConfig(cwd),
      onProgress: expect.any(Function),
      tourFile: {
        path: path.join(cwd, "demos", "sample.tour.ts"),
        tour: {
          id: "sample-smoke",
          beforeRecord: expect.any(Function),
          setup: expect.any(Function),
          title: "Sample",
          teardown: expect.any(Function),
          run: expect.any(Function),
        },
      },
    });
    expect(generateTour).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      `Validated flow: ${path.join(cwd, ".demohunter/sample-smoke/smoke-run.json")}`,
    );
  });

  test("throws a clear error for invalid default exports", async () => {
    const cwd = await makeTempProject();

    await expect(
      generateCommand(cwd, "demos/invalid.tour.ts", {
        generateTour: async () => ({ outputDir: "", videoPath: "" }),
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow(
      `Tour file must default export an object with string id/title and a run function: ${path.join(cwd, "demos/invalid.tour.ts")}. Export a default tour like { id: "product-overview", title: "Product overview", async run(runtime) {} }.`,
    );
  });

  test("rejects a non-function setup export with the tour path", async () => {
    const cwd = await makeTempProject();

    await expect(
      generateCommand(cwd, "demos/invalid-setup.tour.ts", {
        generateTour: async () => ({ outputDir: "", videoPath: "" }),
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow(
      `Tour file has invalid setup export; expected a function when provided: ${path.join(cwd, "demos/invalid-setup.tour.ts")}. Keep setup as async setup(runtime) {} or remove it.`,
    );
  });

  test("rejects a non-function teardown export with the tour path", async () => {
    const cwd = await makeTempProject();

    await expect(
      generateCommand(cwd, "demos/invalid-teardown.tour.ts", {
        generateTour: async () => ({ outputDir: "", videoPath: "" }),
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow(
      `Tour file has invalid teardown export; expected a function when provided: ${path.join(cwd, "demos/invalid-teardown.tour.ts")}. Keep teardown as async teardown(runtime) {} or remove it.`,
    );
  });

  test("rejects a non-function beforeRecord export with the tour path", async () => {
    const cwd = await makeTempProject();

    await expect(
      generateCommand(cwd, "demos/invalid-before-record.tour.ts", {
        generateTour: async () => ({ outputDir: "", videoPath: "" }),
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow(
      `Tour file has invalid beforeRecord export; expected a function when provided: ${path.join(cwd, "demos/invalid-before-record.tour.ts")}. Keep beforeRecord as async beforeRecord(runtime) {} or remove it.`,
    );
  });

  test("turns missing Playwright browser runtime errors into a first-run install hint", async () => {
    const cwd = await makeTempProject();

    await expect(
      generateCommand(cwd, "demos/sample.tour.ts", {
        generateTour: async () => {
          throw new Error(
            "browserType.launch: Executable doesn't exist at /tmp/ms-playwright/chromium/chrome\nPlease run bun x playwright install chromium",
          );
        },
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow(
      'Playwright could not launch the local browser runtime for DemoHunter. Run "bun x playwright install chromium" and retry.',
    );
  });

  test("turns missing ffmpeg binaries into an actionable prerequisite error", async () => {
    const cwd = await makeTempProject();

    await expect(
      generateCommand(cwd, "demos/sample.tour.ts", {
        generateTour: async () => {
          throw new Error("ffmpeg failed: spawn ffmpeg ENOENT");
        },
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow(
      'DemoHunter could not find ffmpeg/ffprobe on your PATH. Install ffmpeg, then confirm "ffmpeg -version" and "ffprobe -version" both work before retrying.',
    );
  });

  test("turns missing uncached narration credentials into an export hint", async () => {
    const cwd = await makeTempProject();

    await expect(
      generateCommand(cwd, "demos/sample.tour.ts", {
        generateTour: async () => {
          throw new Error(
            'Unable to resolve narration segment "Explain billing" because OPENAI_API_KEY is required.',
          );
        },
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow(
      'Narration requires uncached OpenAI speech, but OPENAI_API_KEY is not set. Export OPENAI_API_KEY and retry, or rerun after the narration cache has already been populated.',
    );

    await expect(
      generateCommand(cwd, "demos/sample.tour.ts", {
        generateTour: async () => {
          throw new Error(
            'Unable to resolve narration segment "Explain billing" because ELEVENLABS_API_KEY is required.',
          );
        },
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow(
      'Narration requires uncached ElevenLabs speech, but ELEVENLABS_API_KEY is not set. Export ELEVENLABS_API_KEY and retry, or rerun after the narration cache has already been populated.',
    );
  });

  test("turns unreachable baseURL navigation failures into an app-readiness hint", async () => {
    const cwd = await makeTempProject();
    const loadedConfig = {
      ...makeLoadedConfig(cwd),
      config: {
        ...makeLoadedConfig(cwd).config,
        baseURL: "http://127.0.0.1:4173/",
      },
    };

    await expect(
      generateCommand(cwd, "demos/sample.tour.ts", {
        generateTour: async () => {
          throw new Error("page.goto: net::ERR_CONNECTION_REFUSED http://127.0.0.1:4173/");
        },
        loadConfig: async () => loadedConfig,
        log: () => {},
      }),
    ).rejects.toThrow(
      'DemoHunter could not reach baseURL http://127.0.0.1:4173/. Start your app yourself, confirm that URL is reachable, and then rerun "demohunter generate".',
    );
  });

  test("preserves generic page.goto timeouts instead of relabeling them as baseURL outages", async () => {
    const cwd = await makeTempProject();

    await expect(
      generateCommand(cwd, "demos/sample.tour.ts", {
        generateTour: async () => {
          throw new Error("page.goto: Timeout 30000ms exceeded.");
        },
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      }),
    ).rejects.toThrow("page.goto: Timeout 30000ms exceeded.");
  });

  test("registers Kokoro with literal command arguments and closes the invocation registry", async () => {
    const cwd = await makeTempProject();
    const createKokoroPlugin = mock((options) => makePlugin("kokoro"));
    const close = mock(async () => {});
    const loadedConfig = {
      ...makeLoadedConfig(cwd),
      config: {
        ...makeLoadedConfig(cwd).config,
        providers: {
          tts: [{
            name: "kokoro",
            options: {
              runtime: "command" as const,
              executable: "/opt/kokoro;touch /tmp/pwned",
              args: ["--literal=$(touch nope)", "voice;rm -rf nope"],
              modelPath: "/models/kokoro.onnx",
              voicesPath: "/models/voices.bin",
            },
          }],
        },
        tts: DEFAULT_KOKORO_TTS_CONFIG,
      },
    };

    await generateCommand(cwd, "demos/sample.tour.ts", {
      createKokoroPlugin,
      generateTour: async ({ narrationRegistry }) => {
        expect(narrationRegistry?.names()).toEqual(["openai", "elevenlabs", "kokoro"]);
        return { outputDir: "out", videoPath: "out/video.mp4" };
      },
      loadConfig: async () => loadedConfig,
      log: () => {},
      createRegistry: () => {
        const plugins = new Map<string, NarrationProviderPlugin>();
        return {
          register(plugin) { plugins.set(plugin.name, plugin); return this; },
          resolve(name) { const plugin = plugins.get(name); if (!plugin) throw new Error("missing"); return plugin; },
          has(name) { return plugins.has(name); },
          names() { return [...plugins.keys()]; },
          close,
        };
      },
    });

    expect(createKokoroPlugin).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/opt/kokoro;touch /tmp/pwned",
      args: ["--literal=$(touch nope)", "voice;rm -rf nope"],
    }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(undefined);
  });

  test("keeps the generation error primary when provider cleanup also fails", async () => {
    const cwd = await makeTempProject();
    const generationError = new Error("generation failed");
    const cleanupError = new Error("cleanup failed");

    try {
      await generateCommand(cwd, "demos/sample.tour.ts", {
        createOpenAIPlugin: () => ({ ...makePlugin("openai"), close: async () => { throw cleanupError; } }),
        generateTour: async () => { throw generationError; },
        loadConfig: async () => makeLoadedConfig(cwd),
        log: () => {},
      });
      throw new Error("expected generateCommand to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([generationError, cleanupError]);
      expect((error as Error).cause).toBe(generationError);
    }
  });

  test("closes a partially initialized registry when a built-in plugin factory fails", async () => {
    const cwd = await makeTempProject();
    const factoryError = new Error("factory failed");
    const close = mock(async (primaryError?: unknown) => { if (primaryError) throw primaryError; });

    await expect(generateCommand(cwd, "demos/sample.tour.ts", {
      createOpenAIPlugin: () => { throw factoryError; },
      createRegistry: () => ({
        register() { return this; },
        resolve() { throw new Error("unused"); },
        has() { return false; },
        names() { return []; },
        close,
      }),
      loadConfig: async () => makeLoadedConfig(cwd),
      log: () => {},
    })).rejects.toBe(factoryError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(factoryError);
  });

  test("resolves authored Kokoro filesystem paths against the loaded project root", async () => {
    const cwd = await makeTempProject();
    const createKokoroPlugin = mock(() => makePlugin("kokoro"));
    const loadedConfig = {
      ...makeLoadedConfig(cwd),
      config: {
        ...makeLoadedConfig(cwd).config,
        providers: { tts: [{
          name: "kokoro",
          options: {
            runtime: "command" as const,
            executable: "./bin/kokoro-worker",
            cwd: "runtime",
            modelPath: "models/kokoro.onnx",
            voicesPath: "models/voices.bin",
          },
        }] },
        tts: DEFAULT_KOKORO_TTS_CONFIG,
      },
    };

    await generateCommand(cwd, "demos/sample.tour.ts", {
      createKokoroPlugin,
      generateTour: async () => ({ outputDir: "out", videoPath: "out/video.mp4" }),
      loadConfig: async () => loadedConfig,
      log: () => {},
    });

    expect(createKokoroPlugin).toHaveBeenCalledWith(expect.objectContaining({
      executable: path.join(cwd, "bin/kokoro-worker"),
      cwd: path.join(cwd, "runtime"),
      modelPath: path.join(cwd, "models/kokoro.onnx"),
      voicesPath: path.join(cwd, "models/voices.bin"),
    }));
  });

  test("discovers the bundled worker from source, dist library, and dist bin layouts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-worker-discovery-"));
    tempRoots.push(root);
    const worker = path.join(root, "dist", "workers", "demohunter_kokoro_worker.py");
    await mkdir(path.dirname(worker), { recursive: true });
    await writeFile(worker, "# worker\n");

    expect(await locateBundledKokoroWorker(pathToFileURL(path.join(root, "dist", "index.js")).href)).toBe(worker);
    expect(await locateBundledKokoroWorker(pathToFileURL(path.join(root, "dist", "bin", "demohunter.js")).href)).toBe(worker);

    const sourceWorker = path.join(root, "packages", "tts-kokoro", "worker", "demohunter_kokoro_worker.py");
    await mkdir(path.dirname(sourceWorker), { recursive: true });
    await writeFile(sourceWorker, "# source worker\n");
    expect(await locateBundledKokoroWorker(
      pathToFileURL(path.join(root, "packages", "cli", "src", "commands", "generate.ts")).href,
    )).toBe(sourceWorker);
  });

  test("rejects an authored descriptor without a CLI implementation", async () => {
    const cwd = await makeTempProject();
    const loadedConfig = {
      ...makeLoadedConfig(cwd),
      config: {
        ...makeLoadedConfig(cwd).config,
        providers: { tts: [{ name: "acme-local", options: {} }] },
        tts: { ...DEFAULT_TTS_CONFIG, provider: "acme-local" },
      },
    };

    await expect(generateCommand(cwd, "demos/sample.tour.ts", {
      loadConfig: async () => loadedConfig,
      log: () => {},
    })).rejects.toThrow('Narration provider descriptor "acme-local" has no installed CLI implementation');
  });
});

function makePlugin(name: string): NarrationProviderPlugin {
  return {
    name,
    capabilities: {
      offlineSynthesis: name === "kokoro",
      languages: "provider-defined",
      outputFormats: "provider-defined",
      sampleRates: "provider-defined",
      instructions: "provider-defined",
    },
    prepareRequest: (request) => request,
    synthesize: async () => { throw new Error("not used"); },
  };
}

async function makeTempProject(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-generate-command-"));
  tempRoots.push(tempRoot);
  await mkdir(path.join(tempRoot, "demos"), { recursive: true });
  await writeFile(
    path.join(tempRoot, "demos", "sample.tour.ts"),
    'export default { id: "sample-smoke", title: "Sample", async setup() {}, async beforeRecord() {}, async run() {}, async teardown() {} };\n',
  );
  await writeFile(path.join(tempRoot, "demos", "invalid.tour.ts"), "export default { nope: true };\n");
  await writeFile(
    path.join(tempRoot, "demos", "invalid-setup.tour.ts"),
    'export default { id: "sample-smoke", title: "Sample", setup: true, async run() {} };\n',
  );
  await writeFile(
    path.join(tempRoot, "demos", "invalid-teardown.tour.ts"),
    'export default { id: "sample-smoke", title: "Sample", async run() {}, teardown: \"later\" };\n',
  );
  await writeFile(
    path.join(tempRoot, "demos", "invalid-before-record.tour.ts"),
    'export default { id: "sample-smoke", title: "Sample", beforeRecord: "later", async run() {} };\n',
  );
  return tempRoot;
}

function makeLoadedConfig(cwd: string) {
  return {
    projectRoot: cwd,
    configPath: path.join(cwd, "demohunter.config.ts"),
    config: {
      baseURL: "http://localhost:3000",
      outputDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.outputDir),
      cacheDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.cacheDir),
      browser: DEFAULT_DEMOHUNTER_CONFIG.browser,
      viewport: DEFAULT_DEMOHUNTER_CONFIG.viewport,
      holdPaddingMs: DEFAULT_DEMOHUNTER_CONFIG.holdPaddingMs,
      record: DEFAULT_RECORD_CONFIG,
      output: DEFAULT_DEMOHUNTER_CONFIG.output,
      tts: DEFAULT_TTS_CONFIG,
    },
  };
}
