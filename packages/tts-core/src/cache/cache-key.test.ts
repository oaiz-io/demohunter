import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  NARRATION_CACHE_SCHEMA_VERSION,
  createNarrationCacheKey,
  createNarrationRequest,
} from "../index.js";
import type { NarrationRequest } from "../index.js";

const BASE_REQUEST = createNarrationRequest({
  provider: "openai",
  model: "gpt-4o-mini-tts",
  voice: "marin",
  format: "mp3",
  sampleRate: 24_000,
  instructions: "Speak clearly, calm, concise, product-demo style.",
  text: "  Cafe\u0301 launch \r\n\t today  ",
});

describe("createNarrationCacheKey", () => {
  test("returns the same key for identical normalized requests across runs", () => {
    const equivalentRequest = createNarrationRequest({
      ...BASE_REQUEST,
      text: "Café launch\n today",
    });

    const first = createNarrationCacheKey(BASE_REQUEST);
    const second = createNarrationCacheKey(equivalentRequest);

    assert.equal(second, first);
  });

  test("changes when any material identity field or schema version changes", () => {
    const baseline = createNarrationCacheKey(BASE_REQUEST);
    const variants: NarrationRequest[] = [
      { ...BASE_REQUEST, provider: "other" } as unknown as NarrationRequest,
      { ...BASE_REQUEST, model: "tts-1" },
      { ...BASE_REQUEST, voice: "alloy" },
      { ...BASE_REQUEST, instructions: "Speak like a warm launch keynote." },
      { ...BASE_REQUEST, language: "sv" },
      { ...BASE_REQUEST, format: "wav" },
      { ...BASE_REQUEST, sampleRate: 48_000 },
      { ...BASE_REQUEST, providerOptions: { voiceSettings: { stability: 0.4 } } },
      { ...BASE_REQUEST, text: "Different narration text" },
    ];

    for (const variant of variants) {
      assert.notEqual(createNarrationCacheKey(variant), baseline);
    }

    assert.notEqual(
      createNarrationCacheKey(BASE_REQUEST, {
        version: NARRATION_CACHE_SCHEMA_VERSION + 1,
      }),
      baseline,
    );
  });

  test("returns a filesystem-safe content-addressed hash without ambient inputs", () => {
    process.env.OPENAI_API_KEY = "sk-test-one";

    const first = createNarrationCacheKey(BASE_REQUEST);

    process.env.OPENAI_API_KEY = "sk-test-two";

    const second = createNarrationCacheKey(BASE_REQUEST);

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(second, first);
  });

  test("normalizes provider option object key order before hashing", () => {
    const first = createNarrationCacheKey({
      ...BASE_REQUEST,
      providerOptions: {
        voiceSettings: {
          stability: 0.35,
          similarityBoost: 0.8,
        },
      },
    });
    const second = createNarrationCacheKey({
      ...BASE_REQUEST,
      providerOptions: {
        voiceSettings: {
          similarityBoost: 0.8,
          stability: 0.35,
        },
      },
    });

    assert.equal(second, first);
  });

  test("keys arbitrary providers and prepared model revisions without runtime path inputs", () => {
    const baseline = createNarrationCacheKey({
      ...BASE_REQUEST,
      provider: "local-kokoro",
      model: "kokoro-82m",
      providerOptions: {
        modelSha256: "aaa",
        backendVersion: "1.0.0",
      },
    });
    const replacement = createNarrationCacheKey({
      ...BASE_REQUEST,
      provider: "local-kokoro",
      model: "kokoro-82m",
      providerOptions: {
        modelSha256: "bbb",
        backendVersion: "1.0.0",
      },
    });

    assert.notEqual(replacement, baseline);
    assert.equal(baseline.includes("/"), false);
  });

  test("normalizes language whitespace before hashing", () => {
    const first = createNarrationCacheKey(createNarrationRequest({
      ...BASE_REQUEST,
      language: "sv",
    }));
    const second = createNarrationCacheKey(createNarrationRequest({
      ...BASE_REQUEST,
      language: " sv ",
    }));

    assert.equal(second, first);
  });
});
