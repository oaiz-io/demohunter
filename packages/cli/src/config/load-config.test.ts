import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_DEMOHUNTER_CONFIG,
  DEFAULT_ELEVENLABS_TTS_CONFIG,
  DEFAULT_RECORD_CONFIG,
  DEFAULT_TTS_CONFIG,
} from "../../../sdk/src/index.js";
import { loadConfig } from "./load-config.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("loadConfig", () => {
  test("merges defaults when only baseURL is authored", async () => {
    const cwd = await writeConfig('export default { baseURL: "http://localhost:3000" };');

    const loaded = await loadConfig(cwd);

    expect(loaded.projectRoot).toBe(cwd);
    expect(loaded.configPath).toBe(path.join(cwd, "demohunter.config.ts"));
    expect(loaded.config).toEqual({
      baseURL: "http://localhost:3000",
      outputDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.outputDir),
      cacheDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.cacheDir),
      browser: DEFAULT_DEMOHUNTER_CONFIG.browser,
      viewport: DEFAULT_DEMOHUNTER_CONFIG.viewport,
      holdPaddingMs: DEFAULT_DEMOHUNTER_CONFIG.holdPaddingMs,
      record: DEFAULT_RECORD_CONFIG,
      tts: DEFAULT_TTS_CONFIG,
    });
  });

  test("resolves relative outputDir and cacheDir against the current working directory", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        outputDir: "artifacts",
        cacheDir: "tmp/cache"
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.outputDir).toBe(path.join(cwd, "artifacts"));
    expect(loaded.config.cacheDir).toBe(path.join(cwd, "tmp/cache"));
  });

  test("preserves explicit scalar overrides while keeping untouched defaults", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        browser: "webkit",
        viewport: { width: 1280, height: 720 },
        holdPaddingMs: 450
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.browser).toBe("webkit");
    expect(loaded.config.viewport).toEqual({ width: 1280, height: 720 });
    expect(loaded.config.holdPaddingMs).toBe(450);
    expect(loaded.config.record).toEqual(DEFAULT_RECORD_CONFIG);
    expect(loaded.config.tts).toEqual(DEFAULT_TTS_CONFIG);
  });

  test("merges a partial record override for showActions without dropping showChapters", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: { showActions: false }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record).toEqual({
      showActions: false,
      showChapters: true,
      format: "mp4",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
    });
  });

  test("merges a partial record override for showChapters without dropping showActions", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: { showChapters: false }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record).toEqual({
      showActions: true,
      showChapters: false,
      format: "mp4",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
    });
  });

  test("preserves the default mp4 record format when it is omitted", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: { showActions: false }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record.format).toBe("mp4");
  });

  test("resolves an explicit webm record format without generating mp4 by default", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: {
          format: "webm",
          showActions: false
        }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record).toEqual({
      showActions: false,
      showChapters: true,
      format: "webm",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
    });
  });

  test("merges partial record overrides for the visual-effect flags without dropping defaults", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: {
          showCursor: false,
          showClickRipple: false,
          highlightStyle: "spotlight"
        }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record).toEqual({
      showActions: true,
      showChapters: true,
      format: "mp4",
      showCursor: false,
      showClickRipple: false,
      highlightStyle: "spotlight",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
    });
  });

  test("keeps showCursor enabled while overriding only the highlight style", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: { highlightStyle: "spotlight" }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record).toEqual({
      showActions: true,
      showChapters: true,
      format: "mp4",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "spotlight",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
    });
  });

  test("deep-merges cookie banner settings while preserving safe defaults", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: {
          cookieBanners: {
            enabled: true,
            action: "accept",
            additionalSelectors: ["[data-cookie-close]"]
          }
        }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record.cookieBanners).toEqual({
      enabled: true,
      action: "accept",
      timeoutMs: 750,
      additionalSelectors: ["[data-cookie-close]"],
    });
  });

  test.each([
    ["provider", '"provider": "openai"', { provider: "openai" }],
    ["model", '"model": "tts-1"', { model: "tts-1" }],
    ["voice", '"voice": "alloy"', { voice: "alloy" }],
    ["format", '"format": "wav"', { format: "wav" }],
    ["instructions", '"instructions": "Keep it brisk."', { instructions: "Keep it brisk." }],
    ["language", '"language": "sv"', { language: "sv" }],
  ])("merges partial tts overrides for %s while preserving defaults", async (_label, propertyLine, override) => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        tts: { ${propertyLine} }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.tts).toEqual({
      ...DEFAULT_TTS_CONFIG,
      ...override,
    });
  });

  test("uses ElevenLabs provider defaults when tts.provider is elevenlabs", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        tts: {
          provider: "elevenlabs",
          voice: "voice-id-from-library",
          voiceSettings: {
            stability: 0.42,
            similarityBoost: 0.86,
            style: 0.15,
            useSpeakerBoost: false
          }
        }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.tts).toEqual({
      ...DEFAULT_ELEVENLABS_TTS_CONFIG,
      voice: "voice-id-from-library",
      voiceSettings: {
        stability: 0.42,
        similarityBoost: 0.86,
        style: 0.15,
        useSpeakerBoost: false,
      },
    });
  });

  test("does not infer tts language from locale environment variables", async () => {
    const originalDemoLocale = process.env.DEMO_LOCALE;
    process.env.DEMO_LOCALE = "sv";

    try {
      const cwd = await writeConfig(`
        export default {
          baseURL: "http://localhost:4173",
          tts: {
            provider: "elevenlabs",
            voice: "voice-id-from-library"
          }
        };
      `);

      const loaded = await loadConfig(cwd);

      expect(loaded.config.tts).toEqual({
        ...DEFAULT_ELEVENLABS_TTS_CONFIG,
        voice: "voice-id-from-library",
      });
    } finally {
      if (originalDemoLocale === undefined) {
        delete process.env.DEMO_LOCALE;
      } else {
        process.env.DEMO_LOCALE = originalDemoLocale;
      }
    }
  });

  test("throws the exact missing-config error", async () => {
    const cwd = await makeTempProject();

    await expect(loadConfig(cwd)).rejects.toThrow(`Could not find demohunter.config.ts in ${cwd}`);
  });

  test("loads a plain object starter config without requiring sdk imports in the target repo", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: new URL("./demos/sample-site/index.html", import.meta.url).href
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.baseURL).toBe(
      new URL("./demos/sample-site/index.html", pathToFileURL(path.join(cwd, "demohunter.config.ts"))).href,
    );
    expect(loaded.config.outputDir).toBe(path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.outputDir));
  });
});

async function writeConfig(contents: string): Promise<string> {
  const cwd = await makeTempProject();
  await writeFile(path.join(cwd, "demohunter.config.ts"), contents.trimStart());
  return cwd;
}

async function makeTempProject(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-config-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}
