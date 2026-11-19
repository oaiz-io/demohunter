import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createOpenAINarrationProvider } from "./index.js";

const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
    return;
  }

  process.env.OPENAI_API_KEY = originalApiKey;
});

describe("createOpenAINarrationProvider", () => {
  test("prefers the resolved API key and falls back to OPENAI_API_KEY", async () => {
    process.env.OPENAI_API_KEY = "environment-key";
    const sent: string[] = [];
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(new Uint8Array([1]), { status: 200 });
    };
    let lookups = 0;
    await createOpenAINarrationProvider({
      fetch,
      resolveApiKey: async () => {
        lookups += 1;
        return "saved-key";
      },
    }).synthesize(createRequest({ text: "Explain billing" }));
    await createOpenAINarrationProvider({ fetch, resolveApiKey: () => undefined }).synthesize(
      createRequest({ text: "Explain billing" }),
    );
    assert.deepEqual(sent, ["Bearer saved-key", "Bearer environment-key"]);
    assert.equal(lookups, 1);
  });

  test("throws only when synthesis is attempted without OPENAI_API_KEY", async () => {
    delete process.env.OPENAI_API_KEY;
    let fetchCalls = 0;
    const provider = createOpenAINarrationProvider({
      fetch: async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array([1]));
      },
    });

    await assert.rejects(
      () =>
        provider.synthesize(
          createRequest({
            model: "gpt-4o-mini-tts",
            text: "Explain billing",
          }),
        ),
      /OPENAI_API_KEY/,
    );
    assert.equal(fetchCalls, 0);
  });

  for (const model of ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const) {
    test(`shapes the speech request for ${model}`, async () => {
      process.env.OPENAI_API_KEY = "test-key";
      const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
      const provider = createOpenAINarrationProvider({
        fetch: async (input, init) => {
          calls.push({ input, init });
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "audio/mpeg" },
            status: 200,
          });
        },
      });

      const request = createRequest({
        model,
        voice: "alloy",
        format: "wav",
        sampleRate: 24_000,
        instructions: "Keep it brisk.",
        language: " sv ",
        text: "Explain billing",
      });

      const result = await provider.synthesize(request);
      const call = calls[0];
      const headers = new Headers(call.init?.headers);
      const body = JSON.parse(String(call.init?.body));

      assert.equal(calls.length, 1);
      assert.equal(String(call.input), "https://api.openai.com/v1/audio/speech");
      assert.equal(call.init?.method, "POST");
      assert.equal(headers.get("authorization"), "Bearer test-key");
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(Object.keys(body).sort(), [
        "input",
        "instructions",
        "model",
        "response_format",
        "voice",
      ]);
      assert.deepEqual(body, {
        model,
        voice: "alloy",
        instructions: "Keep it brisk. Use the language and native accent matching sv.",
        response_format: "wav",
        input: "Explain billing",
      });
      assert.deepEqual(result.metadata, {
        provider: "openai",
        model,
        voice: "alloy",
        format: "wav",
        sampleRate: 24_000,
        language: "sv",
      });
    });
  }

  test("returns raw audio bytes and provider metadata without cache-specific behavior", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const provider = createOpenAINarrationProvider({
      fetch: async () =>
        new Response(new Uint8Array([9, 8, 7]), {
          headers: { "content-type": "audio/mpeg" },
          status: 200,
        }),
    });
    const request = createRequest({
      model: "gpt-4o-mini-tts",
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

  test("surfaces non-2xx OpenAI responses with status details", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const provider = createOpenAINarrationProvider({
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
            model: "gpt-4o-mini-tts",
            text: "Narrate the billing dashboard.",
          }),
        ),
      /OpenAI speech synthesis failed \(400 Bad Request\): bad request/,
    );
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
    text: string;
  }> = {},
) {
  return {
    provider: "openai" as const,
    model: input.model ?? "gpt-4o-mini-tts",
    voice: input.voice ?? "marin",
    format: input.format ?? "mp3",
    sampleRate: input.sampleRate ?? 24_000,
    instructions: input.instructions ?? "Speak clearly.",
    ...(input.language === undefined ? {} : { language: input.language }),
    text: input.text ?? "Explain billing",
  };
}
