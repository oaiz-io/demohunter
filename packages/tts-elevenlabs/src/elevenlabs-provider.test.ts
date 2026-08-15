import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  createElevenLabsNarrationProvider,
  createElevenLabsNarrationProviderPlugin,
} from "./index.js";

const originalApiKey = process.env.ELEVENLABS_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.ELEVENLABS_API_KEY;
    return;
  }

  process.env.ELEVENLABS_API_KEY = originalApiKey;
});

describe("createElevenLabsNarrationProvider", () => {
  test("exposes provider-defined language and request capabilities through the plugin contract", async () => {
    const plugin = createElevenLabsNarrationProviderPlugin();
    const prepared = await plugin.prepareRequest(
      createRequest({ language: " custom-authored-language " }),
      { cacheDir: "/tmp/cache", signal: new AbortController().signal },
    );

    assert.equal(plugin.name, "elevenlabs");
    assert.deepEqual(plugin.capabilities, {
      offlineSynthesis: false,
      languages: "provider-defined",
      outputFormats: "provider-defined",
      sampleRates: "provider-defined",
      instructions: "provider-defined",
    });
    assert.equal(prepared.language, "custom-authored-language");
  });

  test("owns stitching normalization and disables continuity for eleven_v3", async () => {
    const plugin = createElevenLabsNarrationProviderPlugin();
    const context = { cacheDir: "/tmp/cache", signal: new AbortController().signal };
    const prepared = await plugin.prepareRequest(createRequest({
      providerOptions: {
        previousText: "  First.\r\n",
        nextText: " Next. ",
        voiceSettings: { stability: 0.5 },
      },
    }), context);
    const v3 = await plugin.prepareRequest(createRequest({
      model: "eleven_v3",
      providerOptions: { previousText: "First.", nextText: "Next." },
    }), context);

    assert.deepEqual(prepared.providerOptions, {
      nextText: "Next.",
      previousText: "First.",
      voiceSettings: { stability: 0.5 },
    });
    assert.equal(v3.providerOptions, undefined);
  });

  test("throws only when synthesis is attempted without ELEVENLABS_API_KEY", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    let fetchCalls = 0;
    const provider = createElevenLabsNarrationProvider({
      fetch: async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array([1]));
      },
    });

    await assert.rejects(
      () =>
        provider.synthesize(
          createRequest({
            text: "Explain billing",
          }),
        ),
      /ELEVENLABS_API_KEY/,
    );
    assert.equal(fetchCalls, 0);
  });

  test("shapes the speech request with voice, model, format, and voice settings", async () => {
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const provider = createElevenLabsNarrationProvider({
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg" },
          status: 200,
        });
      },
    });

    const request = createRequest({
      voice: "voice/id with spaces",
      model: "eleven_flash_v2_5",
      format: "mp3_44100_128",
      sampleRate: 44_100,
      language: " sv ",
      text: "Explain billing",
      providerOptions: {
        nextText: "Next, export the report.",
        previousText: "First, open billing.",
        voiceSettings: {
          stability: 0.42,
          similarityBoost: 0.86,
          style: 0.15,
          useSpeakerBoost: false,
          speed: 1.05,
        },
      },
    });

    const result = await provider.synthesize(request);
    const call = calls[0];
    const url = new URL(String(call.input));
    const headers = new Headers(call.init?.headers);
    const body = JSON.parse(String(call.init?.body));

    assert.equal(calls.length, 1);
    assert.equal(url.origin + url.pathname, "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid%20with%20spaces");
    assert.equal(url.searchParams.get("output_format"), "mp3_44100_128");
    assert.equal(call.init?.method, "POST");
    assert.equal(headers.get("xi-api-key"), "test-elevenlabs-key");
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(body, {
      text: "Explain billing",
      model_id: "eleven_flash_v2_5",
      language_code: "sv",
      previous_text: "First, open billing.",
      next_text: "Next, export the report.",
      voice_settings: {
        stability: 0.42,
        similarity_boost: 0.86,
        style: 0.15,
        use_speaker_boost: false,
        speed: 1.05,
      },
    });
    assert.deepEqual(result.metadata, {
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      voice: "voice/id with spaces",
      format: "mp3_44100_128",
      sampleRate: 44_100,
      language: "sv",
      providerOptions: request.providerOptions,
    });
  });

  test("returns raw audio bytes and provider metadata without cache-specific behavior", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const provider = createElevenLabsNarrationProvider({
      fetch: async () =>
        new Response(new Uint8Array([9, 8, 7]), {
          headers: { "content-type": "audio/mpeg" },
          status: 200,
        }),
    });
    const request = createRequest({
      text: "Narrate the billing dashboard.",
    });

    const result = await provider.synthesize(request);

    assert.deepEqual(result.request, request);
    assert.deepEqual(result.output, {
      kind: "bytes",
      bytes: new Uint8Array([9, 8, 7]),
    });
    assert.equal("cacheKey" in (result as Record<string, unknown>), false);
    assert.equal("path" in (result as Record<string, unknown>), false);
  });

  test("surfaces non-2xx ElevenLabs responses with status details", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const provider = createElevenLabsNarrationProvider({
      fetch: async () =>
        new Response("bad request", {
          status: 400,
          statusText: "Bad Request",
        }),
    });

    await assert.rejects(
      () =>
        provider.synthesize(
          createRequest({
            text: "Narrate the billing dashboard.",
          }),
        ),
      /ElevenLabs speech synthesis failed \(400 Bad Request\): bad request/,
    );
  });

  test("the plugin forwards cancellation to fetch while the legacy factory remains compatible", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const plugin = createElevenLabsNarrationProviderPlugin({
      fetch: async (_input, init) => {
        receivedSignal = init?.signal;
        return new Response(new Uint8Array([1]), { status: 200 });
      },
    });
    const context = { cacheDir: "/tmp/cache", signal: controller.signal };
    const request = await plugin.prepareRequest(createRequest(), context);

    await plugin.synthesize(request, context);

    assert.equal(receivedSignal, controller.signal);
  });
});

function createRequest(
  input: Partial<{
    model: string;
    voice: string;
    format: string;
    sampleRate: number;
    instructions: string;
    language: string;
    providerOptions: Record<string, unknown>;
    text: string;
  }> = {},
) {
  return {
    provider: "elevenlabs" as const,
    model: input.model ?? "eleven_multilingual_v2",
    voice: input.voice ?? "JBFqnCBsd6RMkjVDRZzb",
    format: input.format ?? "mp3_44100_128",
    sampleRate: input.sampleRate ?? 44_100,
    instructions: input.instructions ?? "",
    ...(input.language === undefined ? {} : { language: input.language }),
    providerOptions: input.providerOptions,
    text: input.text ?? "Explain billing",
  };
}
