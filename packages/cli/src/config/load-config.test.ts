import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_DEMOHUNTER_CONFIG,
  DEFAULT_CURSOR_CONFIG,
  DEFAULT_ELEVENLABS_TTS_CONFIG,
  DEFAULT_OUTPUT_CONFIG,
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
      output: DEFAULT_OUTPUT_CONFIG,
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
      container: "mp4",
      format: "mp4",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
      cursor: DEFAULT_CURSOR_CONFIG,
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
      container: "mp4",
      format: "mp4",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
      cursor: DEFAULT_CURSOR_CONFIG,
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
    expect(loaded.config.record.container).toBe("mp4");
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
      container: "webm",
      format: "webm",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
      cursor: DEFAULT_CURSOR_CONFIG,
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
      container: "mp4",
      format: "mp4",
      showCursor: false,
      showClickRipple: false,
      highlightStyle: "spotlight",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
      cursor: undefined,
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
      container: "mp4",
      format: "mp4",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "spotlight",
      cookieBanners: DEFAULT_RECORD_CONFIG.cookieBanners,
      cursor: DEFAULT_CURSOR_CONFIG,
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
    [
      "action",
      '{ enabled: true, action: "deny" }',
      "Invalid record.cookieBanners.action: deny. Expected reject, accept, or hide.",
    ],
    [
      "timeout",
      "{ enabled: true, timeoutMs: -1 }",
      "record.cookieBanners.timeoutMs must be a non-negative finite number",
    ],
    [
      "selectors",
      '{ enabled: true, additionalSelectors: ["  "] }',
      "record.cookieBanners.additionalSelectors must contain only non-empty strings",
    ],
  ])("rejects invalid cookie banner %s configuration", async (_label, cookieBanners, message) => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: { cookieBanners: ${cookieBanners} }
      };
    `);

    await expect(loadConfig(cwd)).rejects.toThrow(message);
  });

  test("deep-merges explicit cursor settings", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: { cursor: { color: "#ef4444", shape: "dot", ripple: false } }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record.cursor).toEqual({
      ...DEFAULT_CURSOR_CONFIG,
      color: "#ef4444",
      shape: "dot",
      ripple: false,
    });
  });

  test("maps legacy cursor booleans into the new cursor config", async () => {
    const hiddenCwd = await writeConfig(`
      export default { baseURL: "http://localhost:4173", record: { showCursor: false } };
    `);
    const noRippleCwd = await writeConfig(`
      export default { baseURL: "http://localhost:4173", record: { showClickRipple: false } };
    `);

    const hidden = await loadConfig(hiddenCwd);
    expect(hidden.config.record.cursor).toBeUndefined();
    expect(hidden.config.record.showCursor).toBe(false);
    expect(hidden.config.record.showClickRipple).toBe(true);
    expect((await loadConfig(noRippleCwd)).config.record.cursor).toEqual({
      ...DEFAULT_CURSOR_CONFIG,
      ripple: false,
    });
  });

  test("rejects unsafe cursor timing configuration", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: { cursor: { pixelsPerMs: 0 } }
      };
    `);

    await expect(loadConfig(cwd)).rejects.toThrow(
      "record.cursor.pixelsPerMs must be a positive finite number",
    );
  });

  test.each([
    ["container", '{ container: "avi" }', "record.container must be either mp4 or webm"],
    ["highlight style", '{ highlightStyle: "glow" }', "record.highlightStyle must be either ring or spotlight"],
    ["cursor shape", '{ cursor: { shape: "crosshair" } }', "record.cursor.shape must be either dot or pointer"],
    ["cursor ripple", '{ cursor: { ripple: "yes" } }', "record.cursor.ripple must be a boolean"],
    ["cursor object", '{ cursor: "smooth" }', "record.cursor must be false or an object"],
  ])("rejects invalid authored record %s", async (_label, record, message) => {
    const cwd = await writeConfig(`
      export default { baseURL: "http://localhost:4173", record: ${record} };
    `);

    await expect(loadConfig(cwd)).rejects.toThrow(message);
  });

  test("rejects non-object record and output blocks", async () => {
    const invalidRecord = await writeConfig(`
      export default { baseURL: "http://localhost:4173", record: "mp4" };
    `);
    const invalidOutput = await writeConfig(`
      export default { baseURL: "http://localhost:4173", output: "gif" };
    `);

    await expect(loadConfig(invalidRecord)).rejects.toThrow("record must be an object");
    await expect(loadConfig(invalidOutput)).rejects.toThrow("output must be an object");
  });

  test("resolves output presets and migrates record.format to record.container", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        record: { format: "webm" },
        output: {
          formats: [
            { preset: "standard" },
            { preset: "square" },
            { preset: "mobile" },
            { preset: "gif", durationMs: 12000 }
          ]
        }
      };
    `);

    const loaded = await loadConfig(cwd);

    expect(loaded.config.record.container).toBe("webm");
    expect(loaded.config.output.formats).toEqual([
      { preset: "standard", layout: "fit" },
      { preset: "square", layout: "fit" },
      { preset: "mobile", layout: "responsive" },
      { preset: "gif", layout: "fit", durationMs: 12_000 },
    ]);
  });

  test("prefers record.container and validates invalid output requests", async () => {
    const preferred = await writeConfig(`
      export default { baseURL: "http://localhost:4173", record: { format: "mp4", container: "webm" } };
    `);
    const duplicate = await writeConfig(`
      export default { baseURL: "http://localhost:4173", output: { formats: [{ preset: "square" }, { preset: "square" }] } };
    `);
    const tooLong = await writeConfig(`
      export default { baseURL: "http://localhost:4173", output: { formats: [{ preset: "gif", durationMs: 16000 }] } };
    `);
    const fractionalDuration = await writeConfig(`
      export default { baseURL: "http://localhost:4173", output: { formats: [{ preset: "gif", durationMs: 0.5 }] } };
    `);
    const unknownPreset = await writeConfig(`
      export default { baseURL: "http://localhost:4173", output: { formats: [{ preset: "story" }] } };
    `);
    const unknownLayout = await writeConfig(`
      export default { baseURL: "http://localhost:4173", output: { formats: [{ preset: "square", layout: "crop" }] } };
    `);

    expect((await loadConfig(preferred)).config.record.container).toBe("webm");
    await expect(loadConfig(duplicate)).rejects.toThrow("duplicate preset: square");
    await expect(loadConfig(tooLong)).rejects.toThrow("no greater than 15000");
    await expect(loadConfig(fractionalDuration)).rejects.toThrow("must be a positive integer");
    await expect(loadConfig(unknownPreset)).rejects.toThrow(
      "Invalid output preset: story. Expected standard, square, mobile, or gif.",
    );
    await expect(loadConfig(unknownLayout)).rejects.toThrow(
      "Invalid output layout for square: crop. Expected fit or responsive.",
    );
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

  test("leaves session unset when neither config nor DEMOHUNTER_STORAGE_STATE provides one", async () => {
    const cwd = await writeConfig('export default { baseURL: "http://localhost:3000" };');

    const loaded = await loadConfig(cwd, {});

    expect("session" in loaded.config).toBe(false);
  });

  test("resolves a relative session.storageState from the project root", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "https://www.notion.so",
        session: { storageState: "../.demohunter-sessions/notion-demo.json" }
      };
    `);

    const loaded = await loadConfig(cwd, {});

    expect(loaded.config.session).toEqual({
      storageState: path.resolve(cwd, "../.demohunter-sessions/notion-demo.json"),
      source: "config",
    });
  });

  test("lets DEMOHUNTER_STORAGE_STATE override the configured session path", async () => {
    const configured = await writeConfig(`
      export default {
        baseURL: "https://app.slack.com",
        session: { storageState: "../.demohunter-sessions/from-config.json" }
      };
    `);
    const unconfigured = await writeConfig('export default { baseURL: "https://app.slack.com" };');

    expect((await loadConfig(configured, { DEMOHUNTER_STORAGE_STATE: "/secrets/slack.json" })).config.session).toEqual({
      storageState: "/secrets/slack.json",
      source: "env",
    });
    expect((await loadConfig(unconfigured, { DEMOHUNTER_STORAGE_STATE: "../ci/slack.json" })).config.session).toEqual({
      storageState: path.resolve(unconfigured, "../ci/slack.json"),
      source: "env",
    });
    expect((await loadConfig(configured, { DEMOHUNTER_STORAGE_STATE: "  " })).config.session?.source).toBe("config");
  });

  test.each([
    ["a string", '"../session.json"', "session must be an object with a storageState path"],
    ["an array", '["../session.json"]', "session must be an object with a storageState path"],
    ["an empty path", '{ storageState: "  " }', "session.storageState must be a non-empty path"],
    ["a missing path", "{}", "session.storageState must be a non-empty path"],
    ["an unexpanded home path", '{ storageState: "~/.demohunter-sessions/app.json" }', 'session.storageState starts with "~", which DemoHunter does not expand'],
  ])("rejects session as %s", async (_label, session, message) => {
    const cwd = await writeConfig(`
      export default { baseURL: "http://localhost:4173", session: ${session} };
    `);

    await expect(loadConfig(cwd, {})).rejects.toThrow(message);
  });

  test("rejects a DEMOHUNTER_STORAGE_STATE that starts with ~ instead of resolving it inside the project", async () => {
    const cwd = await writeConfig('export default { baseURL: "http://localhost:4173" };');

    await expect(loadConfig(cwd, { DEMOHUNTER_STORAGE_STATE: "~/.demohunter-sessions/app.json" })).rejects.toThrow(
      'DEMOHUNTER_STORAGE_STATE starts with "~", which DemoHunter does not expand. Use an absolute path or a path relative to the project root.',
    );
  });

  test("rejects session paths inside outputDir or cacheDir, including from the environment", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        cacheDir: "tmp/cache",
        session: { storageState: ".demohunter/sessions/app.json" }
      };
    `);
    const cacheCwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        cacheDir: "tmp/cache",
        session: { storageState: "tmp/cache/app.json" }
      };
    `);
    const envCwd = await writeConfig('export default { baseURL: "http://localhost:4173" };');

    await expect(loadConfig(cwd, {})).rejects.toThrow(
      `session.storageState must not point inside outputDir (${path.join(cwd, ".demohunter")})`,
    );
    await expect(loadConfig(cacheCwd, {})).rejects.toThrow(
      `session.storageState must not point inside cacheDir (${path.join(cacheCwd, "tmp/cache")})`,
    );
    await expect(
      loadConfig(envCwd, { DEMOHUNTER_STORAGE_STATE: path.join(envCwd, ".demohunter", "app.json") }),
    ).rejects.toThrow("DEMOHUNTER_STORAGE_STATE must not point inside outputDir");
  });

  test("accepts a session directory whose name only shares a prefix with outputDir", async () => {
    const cwd = await writeConfig(`
      export default {
        baseURL: "http://localhost:4173",
        session: { storageState: ".demohunter-sessions/app.json" }
      };
    `);

    expect((await loadConfig(cwd, {})).config.session?.storageState).toBe(
      path.join(cwd, ".demohunter-sessions/app.json"),
    );
  });

  test("resolves launch options only when they are authored", async () => {
    const unset = await writeConfig('export default { baseURL: "http://localhost:4173" };');
    const cwd = await writeConfig(`
      export default {
        baseURL: "https://mail.google.com",
        launch: { channel: "chrome", headless: false, locale: "en-US", timezoneId: "Europe/Stockholm" }
      };
    `);

    expect("launch" in (await loadConfig(unset, {})).config).toBe(false);
    expect((await loadConfig(cwd, {})).config.launch).toEqual({
      channel: "chrome",
      headless: false,
      locale: "en-US",
      timezoneId: "Europe/Stockholm",
    });
  });

  test.each([
    ["a non-object block", '"chrome"', "launch must be an object"],
    ["browser arguments", '{ args: ["--disable-blink-features=AutomationControlled"] }', "Unsupported launch option: args. Expected one of channel, headless, locale, timezoneId."],
    ["a non-boolean headless", '{ headless: "false" }', "launch.headless must be a boolean"],
    ["an empty channel", '{ channel: "" }', "launch.channel must be a non-empty string"],
    ["an empty locale", '{ locale: " " }', "launch.locale must be a non-empty string"],
    ["a non-string timezone", "{ timezoneId: 1 }", "launch.timezoneId must be a non-empty string"],
  ])("rejects launch with %s", async (_label, launch, message) => {
    const cwd = await writeConfig(`
      export default { baseURL: "http://localhost:4173", launch: ${launch} };
    `);

    await expect(loadConfig(cwd, {})).rejects.toThrow(message);
  });

  test("rejects launch.channel for non-Chromium browsers", async () => {
    const cwd = await writeConfig(`
      export default { baseURL: "http://localhost:4173", browser: "firefox", launch: { channel: "chrome" } };
    `);

    await expect(loadConfig(cwd, {})).rejects.toThrow(
      'launch.channel requires browser "chromium"; the configured browser is "firefox"',
    );
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
