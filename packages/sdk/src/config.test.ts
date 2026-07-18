import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DEMOHUNTER_CONFIG,
  DEFAULT_ELEVENLABS_TTS_CONFIG,
  DEFAULT_KOKORO_TTS_CONFIG,
  DEFAULT_RECORD_CONFIG,
  DEFAULT_TTS_CONFIG,
  defineConfig,
  kokoro,
  kokoroTTS,
} from "./config.js";
import * as sdk from "./index.js";

describe("defineConfig", () => {
  test("returns the authored config object unchanged", () => {
    const authored = {
      baseURL: "http://localhost:3000",
    };

    const config = defineConfig(authored);

    expect(config).toBe(authored);
    expect(config).toEqual({
      baseURL: "http://localhost:3000",
    });
    expect("outputDir" in config).toBe(false);
  });
});

describe("sdk entrypoint", () => {
  test("re-exports config helpers and defaults", () => {
    expect(sdk.defineConfig).toBe(defineConfig);
    expect(sdk.DEFAULT_DEMOHUNTER_CONFIG).toBe(DEFAULT_DEMOHUNTER_CONFIG);
    expect(sdk.DEFAULT_ELEVENLABS_TTS_CONFIG).toBe(DEFAULT_ELEVENLABS_TTS_CONFIG);
    expect(sdk.DEFAULT_RECORD_CONFIG).toBe(DEFAULT_RECORD_CONFIG);
    expect(sdk.DEFAULT_TTS_CONFIG).toBe(DEFAULT_TTS_CONFIG);
  });
});

describe("tts defaults", () => {
  test("keeps OpenAI as the default while exporting ElevenLabs defaults", () => {
    expect(DEFAULT_TTS_CONFIG.provider).toBe("openai");
    expect(DEFAULT_ELEVENLABS_TTS_CONFIG).toEqual({
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      voice: "JBFqnCBsd6RMkjVDRZzb",
      format: "mp3_44100_128",
      instructions: "",
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        useSpeakerBoost: true,
      },
    });
  });

  test("authors a process-free Kokoro provider descriptor with WAV defaults", () => {
    const descriptor = kokoro({ runtime: "command", executable: "kokoro" });
    const authored = defineConfig({
      baseURL: "http://localhost:3000",
      providers: { tts: [descriptor] },
      tts: { provider: "kokoro", voice: "en_us_male_1", language: "en-US" },
    });

    expect(authored.providers.tts[0]).toEqual({
      name: "kokoro",
      options: { runtime: "command", executable: "kokoro" },
    });
    expect(kokoroTTS({ voice: "en_us_male_1" })).toEqual({
      ...DEFAULT_KOKORO_TTS_CONFIG,
      voice: "en_us_male_1",
    });
  });

  test("accepts arbitrary provider names without widening them to OpenAI", () => {
    const authored = defineConfig({
      baseURL: "http://localhost:3000",
      providers: { tts: [{ name: "acme-local", options: { endpoint: "local" } }] },
      tts: {
        provider: "acme-local",
        model: "acme-v1",
        voice: "demo",
        format: "wav",
        instructions: "",
      },
    });

    expect(authored.tts.provider).toBe("acme-local");
  });
});

describe("record defaults", () => {
  test("defaults the record format to mp4", () => {
    expect(DEFAULT_RECORD_CONFIG).toEqual({
      showActions: true,
      showChapters: true,
      container: "mp4",
      format: "mp4",
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
      cookieBanners: {
        enabled: false,
        action: "reject",
        timeoutMs: 750,
        additionalSelectors: [],
      },
      cursor: {
        mode: "smooth",
        shape: "pointer",
        color: "#3b82f6",
        sizePx: 20,
        minDurationMs: 400,
        maxDurationMs: 1200,
        pixelsPerMs: 1.4,
        arcHeightPx: 56,
        ripple: true,
      },
    });
    expect(DEFAULT_DEMOHUNTER_CONFIG.record.format).toBe("mp4");
    expect(DEFAULT_DEMOHUNTER_CONFIG.record.container).toBe("mp4");
    expect(DEFAULT_DEMOHUNTER_CONFIG.output.formats).toEqual([]);
  });
});
