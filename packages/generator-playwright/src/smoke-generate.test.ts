import { afterEach, describe, expect, mock, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { smokeGenerate } from "./smoke-generate.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("smokeGenerate", () => {
  test("runs setup, run, and teardown in order on a shared page and writes the smoke artifact", async () => {
    const cwd = await makeTempRoot();
    const waitForLoadState = mock(async () => {});
    const page = { goto: mock(async () => {}), waitForLoadState };
    const newPage = mock(async () => page);
    const closeContext = mock(async () => {});
    const closeBrowser = mock(async () => {});
    const newContext = mock(async () => ({
      close: closeContext,
      newPage,
    }));
    const launch = mock(async () => ({
      close: closeBrowser,
      newContext,
    }));
    const locator = {
      scrollIntoViewIfNeeded: mock(async () => {}),
      waitFor: mock(async () => {}),
    };
    const calls: string[] = [];
    const setup = mock(async ({ page: lifecyclePage }) => {
      calls.push(`setup:${lifecyclePage === page}`);
    });
    const beforeRecord = mock(async ({ page: lifecyclePage }) => {
      calls.push(`beforeRecord:${lifecyclePage === page}`);
    });
    const run = mock(async ({ page: runtimePage, chapter, step, narrate, waitForStable, highlight, snapshot, assertVisible }) => {
      calls.push(`run:${runtimePage === page}`);
      expect(typeof chapter).toBe("function");
      expect(typeof step).toBe("function");
      expect(typeof narrate).toBe("function");
      expect(typeof waitForStable).toBe("function");
      expect(typeof highlight).toBe("function");
      expect(typeof snapshot).toBe("function");
      expect(typeof assertVisible).toBe("function");
      await chapter("Billing");
      await step("demo", async () => {
        calls.push("step");
        return "done";
      });
      await narrate("ignored");
      await waitForStable({ state: "load", timeoutMs: 123 });
      await highlight(locator as never, { name: "CTA" });
      await snapshot({ name: "hero" });
      await assertVisible(locator as never, { timeoutMs: 456 });
    });
    const teardown = mock(async ({ page: lifecyclePage }) => {
      calls.push(`teardown:${lifecyclePage === page}`);
    });

    const result = await smokeGenerate(
      {
        loadedConfig: {
          config: {
            baseURL: "http://localhost:3000",
            outputDir: path.join(cwd, ".demohunter"),
            cacheDir: path.join(cwd, ".demohunter/cache"),
            browser: "chromium",
            viewport: { width: 1280, height: 720 },
            holdPaddingMs: 300,
            record: { format: "mp4" as const, showActions: true, showChapters: true },
            tts: {
              provider: "openai",
              model: "gpt-4o-mini-tts",
              voice: "marin",
              format: "mp3",
              instructions: "Speak clearly.",
            },
          },
          configPath: path.join(cwd, "demohunter.config.ts"),
          projectRoot: cwd,
        },
        tourFile: {
          path: path.join(cwd, "demos/sample.tour.ts"),
          tour: {
            id: "sample-smoke",
            beforeRecord,
            setup,
            title: "Sample demo",
            teardown,
            run,
          },
        },
      },
      {
        attachDebugCapture: mock(() => createDebugCapture()),
        now: () => new Date("2026-04-10T00:00:00.000Z"),
        playwright: {
          chromium: { launch },
          firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
        },
      },
    );

    expect(launch).toHaveBeenCalledTimes(1);
    expect(newContext).toHaveBeenCalledWith({
      baseURL: "http://localhost:3000",
      viewport: { width: 1280, height: 720 },
    });
    expect(page.goto).toHaveBeenCalledWith("http://localhost:3000/");
    expect(calls).toEqual(["setup:true", "beforeRecord:true", "run:true", "step", "teardown:true"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(beforeRecord).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(waitForLoadState).toHaveBeenCalledWith("load", { timeout: 123 });
    expect(locator.waitFor).toHaveBeenCalledTimes(2);
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);

    expect(result.outputPath).toBe(path.join(cwd, ".demohunter/sample-smoke/smoke-run.json"));

    await access(result.outputPath);
    await expect(access(path.join(cwd, ".demohunter/sample-smoke/video.mp4"))).rejects.toThrow();
    await expect(access(path.join(cwd, ".demohunter/sample-smoke/manifest.json"))).rejects.toThrow();

    const artifact = JSON.parse(await readFile(result.outputPath, "utf8"));
    expect(artifact).toEqual({
      status: "ok",
      tourId: "sample-smoke",
      title: "Sample demo",
      baseURL: "http://localhost:3000",
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      generatedAt: "2026-04-10T00:00:00.000Z",
    });
  });

  test("loads a configured session into the validation context and redacts debug capture", async () => {
    const cwd = await makeTempRoot();
    const newContext = mock(async () => ({
      close: mock(async () => {}),
      newPage: mock(async () => ({ goto: mock(async () => {}) })),
    }));
    const attachDebugCapture = mock(() => createDebugCapture());

    await smokeGenerate(
      {
        loadedConfig: {
          config: {
            baseURL: "http://localhost:3000",
            outputDir: path.join(cwd, ".demohunter"),
            cacheDir: path.join(cwd, ".demohunter/cache"),
            browser: "chromium",
            viewport: { width: 1280, height: 720 },
            holdPaddingMs: 300,
            record: { format: "mp4" as const, showActions: true, showChapters: true },
            session: { storageState: "/home/demo/.demohunter-sessions/app.json", source: "config" },
            tts: {
              provider: "openai",
              model: "gpt-4o-mini-tts",
              voice: "marin",
              format: "mp3",
              instructions: "Speak clearly.",
            },
          },
          configPath: path.join(cwd, "demohunter.config.ts"),
          projectRoot: cwd,
        },
        tourFile: {
          path: path.join(cwd, "demos/sample.tour.ts"),
          tour: { id: "sample-smoke", title: "Sample demo", run: async () => {} },
        },
      },
      {
        attachDebugCapture,
        now: () => new Date("2026-04-10T00:00:00.000Z"),
        playwright: {
          chromium: { launch: mock(async () => ({ close: mock(async () => {}), newContext })) },
          firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
        },
      },
    );

    expect(newContext).toHaveBeenCalledWith({
      baseURL: "http://localhost:3000",
      viewport: { width: 1280, height: 720 },
      storageState: "/home/demo/.demohunter-sessions/app.json",
    });
    expect(attachDebugCapture).toHaveBeenCalledWith(expect.objectContaining({ redact: true }));
  });

  test("still runs teardown when run fails and rethrows the primary error", async () => {
    const cwd = await makeTempRoot();
    const page = { goto: mock(async () => {}) };
    const closeContext = mock(async () => {});
    const closeBrowser = mock(async () => {});
    const launch = mock(async () => ({
      close: closeBrowser,
      newContext: mock(async () => ({
        close: closeContext,
        newPage: mock(async () => page),
      })),
    }));
    const calls: string[] = [];
    const failure = new Error("run failed");

    await expect(
      smokeGenerate(
        {
          loadedConfig: {
            config: {
              baseURL: "http://localhost:3000",
              outputDir: path.join(cwd, ".demohunter"),
              cacheDir: path.join(cwd, ".demohunter/cache"),
              browser: "chromium",
              viewport: { width: 1280, height: 720 },
              holdPaddingMs: 300,
              record: { format: "mp4" as const, showActions: true, showChapters: true },
              tts: {
                provider: "openai",
                model: "gpt-4o-mini-tts",
                voice: "marin",
                format: "mp3",
                instructions: "Speak clearly.",
              },
            },
            configPath: path.join(cwd, "demohunter.config.ts"),
            projectRoot: cwd,
          },
          tourFile: {
            path: path.join(cwd, "demos/sample.tour.ts"),
            tour: {
              id: "sample-smoke",
              title: "Sample demo",
              setup: mock(async () => {
                calls.push("setup");
              }),
              run: mock(async () => {
                calls.push("run");
                throw failure;
              }),
              teardown: mock(async () => {
                calls.push("teardown");
              }),
            },
          },
        },
        {
          attachDebugCapture: mock(() => createDebugCapture()),
          playwright: {
            chromium: { launch },
            firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
            webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          },
        },
      ),
    ).rejects.toThrow("run failed");

    expect(calls).toEqual(["setup", "run", "teardown"]);
    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  test("preserves the primary tour failure when cleanup also fails", async () => {
    const cwd = await makeTempRoot();
    const page = { goto: mock(async () => {}) };
    const closeContextError = new Error("context close failed");
    const closeBrowserError = new Error("browser close failed");
    const closeContext = mock(async () => {
      throw closeContextError;
    });
    const closeBrowser = mock(async () => {
      throw closeBrowserError;
    });
    const launch = mock(async () => ({
      close: closeBrowser,
      newContext: mock(async () => ({
        close: closeContext,
        newPage: mock(async () => page),
      })),
    }));
    const failure = new Error("run failed");

    await expect(
      smokeGenerate(
        {
          loadedConfig: {
            config: {
              baseURL: "http://localhost:3000",
              outputDir: path.join(cwd, ".demohunter"),
              cacheDir: path.join(cwd, ".demohunter/cache"),
              browser: "chromium",
              viewport: { width: 1280, height: 720 },
              holdPaddingMs: 300,
              record: { format: "mp4" as const, showActions: true, showChapters: true },
              tts: {
                provider: "openai",
                model: "gpt-4o-mini-tts",
                voice: "marin",
                format: "mp3",
                instructions: "Speak clearly.",
              },
            },
            configPath: path.join(cwd, "demohunter.config.ts"),
            projectRoot: cwd,
          },
          tourFile: {
            path: path.join(cwd, "demos/sample.tour.ts"),
            tour: {
              id: "sample-smoke",
              title: "Sample demo",
              run: mock(async () => {
                throw failure;
              }),
            },
          },
        },
        {
          attachDebugCapture: mock(() => createDebugCapture()),
          playwright: {
            chromium: { launch },
            firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
            webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          },
        },
      ),
    ).rejects.toBe(failure);

    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  test("rejects unsafe tour ids before generating output", async () => {
    const cwd = await makeTempRoot();
    const goto = mock(async () => {});
    const closeContext = mock(async () => {});
    const closeBrowser = mock(async () => {});
    const launch = mock(async () => ({
      close: closeBrowser,
      newContext: mock(async () => ({
        close: closeContext,
        newPage: mock(async () => ({ goto })),
      })),
    }));
    const mkdir = mock(async () => {
      throw new Error("mkdir should not run");
    });
    const writeFile = mock(async () => {
      throw new Error("writeFile should not run");
    });
    const tourPath = path.join(cwd, "demos/unsafe.tour.ts");

    await expect(
      smokeGenerate(
        {
          loadedConfig: {
            config: {
              baseURL: "http://localhost:3000",
              outputDir: path.join(cwd, ".demohunter"),
              cacheDir: path.join(cwd, ".demohunter/cache"),
              browser: "chromium",
              viewport: { width: 1280, height: 720 },
              holdPaddingMs: 300,
              record: { format: "mp4" as const, showActions: true, showChapters: true },
              tts: {
                provider: "openai",
                model: "gpt-4o-mini-tts",
                voice: "marin",
                format: "mp3",
                instructions: "Speak clearly.",
              },
            },
            configPath: path.join(cwd, "demohunter.config.ts"),
            projectRoot: cwd,
          },
          tourFile: {
            path: tourPath,
            tour: {
              id: "../escape",
              title: "Unsafe demo",
              run: mock(async () => {}),
            },
          },
        },
        {
          attachDebugCapture: mock(() => createDebugCapture()),
          mkdir,
          playwright: {
            chromium: { launch },
            firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
            webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          },
          writeFile,
        },
      ),
    ).rejects.toThrow(`Tour id must be a lowercase filesystem-safe slug: ${tourPath}`);

    expect(goto).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(closeContext).not.toHaveBeenCalled();
    expect(closeBrowser).not.toHaveBeenCalled();
  });

  test("rejects uppercase tour ids before generating output", async () => {
    const cwd = await makeTempRoot();
    const launch = mock(async () => {
      throw new Error("launch should not run");
    });
    const mkdir = mock(async () => {
      throw new Error("mkdir should not run");
    });
    const writeFile = mock(async () => {
      throw new Error("writeFile should not run");
    });
    const tourPath = path.join(cwd, "demos/unsafe-uppercase.tour.ts");

    await expect(
      smokeGenerate(
        {
          loadedConfig: {
            config: {
              baseURL: "http://localhost:3000",
              outputDir: path.join(cwd, ".demohunter"),
              cacheDir: path.join(cwd, ".demohunter/cache"),
              browser: "chromium",
              viewport: { width: 1280, height: 720 },
              holdPaddingMs: 300,
              record: { format: "mp4" as const, showActions: true, showChapters: true },
              tts: {
                provider: "openai",
                model: "gpt-4o-mini-tts",
                voice: "marin",
                format: "mp3",
                instructions: "Speak clearly.",
              },
            },
            configPath: path.join(cwd, "demohunter.config.ts"),
            projectRoot: cwd,
          },
          tourFile: {
            path: tourPath,
            tour: {
              id: "Sample-Smoke",
              title: "Unsafe uppercase demo",
              run: mock(async () => {}),
            },
          },
        },
        {
          attachDebugCapture: mock(() => createDebugCapture()),
          mkdir,
          playwright: {
            chromium: { launch },
            firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
            webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) },
          },
          writeFile,
        },
      ),
    ).rejects.toThrow(`Tour id must be a lowercase filesystem-safe slug: ${tourPath}`);

    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});

async function makeTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-smoke-generate-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function createDebugCapture() {
  return {
    captureFailure: mock(async () => ({
      directory: "/tmp/project/.demohunter/sample-smoke/debug/failure",
      failureJsonPath: "/tmp/project/.demohunter/sample-smoke/debug/failure/failure.json",
    })),
    dispose: mock(() => {}),
  };
}
