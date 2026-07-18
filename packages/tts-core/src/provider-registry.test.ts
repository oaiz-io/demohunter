import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createNarrationProviderRegistry,
  createNarrationRequest,
  prepareNarrationProviderRequest,
  type NarrationProviderCapabilities,
  type NarrationProviderPlugin,
  type NarrationRequest,
} from "./index.js";

const BASE_CAPABILITIES: NarrationProviderCapabilities = {
  offlineSynthesis: true,
  languages: ["en-us"],
  outputFormats: ["wav"],
  sampleRates: [24_000],
  instructions: "supported",
};

describe("createNarrationProviderRegistry", () => {
  test("registers arbitrary provider names and reports duplicate and unknown names deterministically", () => {
    const registry = createNarrationProviderRegistry([
      createPlugin("zeta-local"),
      createPlugin("acme/custom-v2"),
    ]);

    assert.equal(registry.resolve("acme/custom-v2").name, "acme/custom-v2");
    assert.deepEqual(registry.names(), ["zeta-local", "acme/custom-v2"]);
    assert.equal(registry.has("zeta-local"), true);
    assert.throws(
      () => registry.register(createPlugin("zeta-local")),
      /Narration provider "zeta-local" is already registered\./,
    );
    assert.throws(
      () => registry.resolve("missing"),
      /Narration provider "missing" is not registered\. Registered providers: "acme\/custom-v2", "zeta-local"\./,
    );
  });

  test("rejects blank provider names at registration and lookup boundaries", () => {
    assert.throws(
      () => createNarrationProviderRegistry([createPlugin("   ")]),
      /Narration provider name must be a non-empty string/,
    );
    assert.throws(
      () => createNarrationProviderRegistry().resolve("\t"),
      /Narration provider name must be a non-empty string/,
    );
  });

  test("closes every plugin once and aggregates cleanup failures after a caller error", async () => {
    const primaryError = new Error("generation failed");
    const firstCloseError = new Error("first close failed");
    const secondCloseError = new Error("second close failed");
    const closeCalls: Array<{ name: string; error: unknown }> = [];
    const registry = createNarrationProviderRegistry([
      createPlugin("first", {}, async (context) => {
        closeCalls.push({ name: "first", error: context.error });
        throw firstCloseError;
      }),
      createPlugin("healthy", {}, async (context) => {
        closeCalls.push({ name: "healthy", error: context.error });
      }),
      createPlugin("second", {}, async (context) => {
        closeCalls.push({ name: "second", error: context.error });
        throw secondCloseError;
      }),
    ]);

    await assert.rejects(registry.close(primaryError), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primaryError, firstCloseError, secondCloseError]);
      assert.equal(error.cause, primaryError);
      return true;
    });
    await assert.rejects(registry.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [firstCloseError, secondCloseError]);
      return true;
    });
    assert.deepEqual(closeCalls, [
      { name: "first", error: primaryError },
      { name: "healthy", error: primaryError },
      { name: "second", error: primaryError },
    ]);
    assert.throws(
      () => registry.register(createPlugin("late")),
      /registry is closed/,
    );
  });

  test("rethrows a caller error unchanged when provider cleanup succeeds", async () => {
    const primaryError = new Error("primary");
    const registry = createNarrationProviderRegistry([createPlugin("healthy")]);

    await assert.rejects(registry.close(primaryError), (error) => error === primaryError);
    await registry.close();
  });
});

describe("prepareNarrationProviderRequest", () => {
  test("uses the prepared request as the semantic result without allowing provider identity changes", async () => {
    const context = createContext();
    const plugin = createPlugin("local", {}, undefined, (request) => ({
      ...request,
      model: "model-content-sha256",
      providerOptions: { revision: "abc123" },
    }));

    const prepared = await prepareNarrationProviderRequest(plugin, createRequest(), context);

    assert.equal(prepared.model, "model-content-sha256");
    assert.deepEqual(prepared.providerOptions, { revision: "abc123" });

    await assert.rejects(
      prepareNarrationProviderRequest(
        createPlugin("local", {}, undefined, (request) => ({ ...request, provider: "other" })),
        createRequest(),
        context,
      ),
      /changed provider identity/,
    );
  });

  test("validates each finite capability dimension while provider-defined languages pass through", async () => {
    const context = createContext();
    const cases: Array<{
      capabilities: Partial<NarrationProviderCapabilities>;
      request: Partial<NarrationRequest>;
      message: RegExp;
    }> = [
      { capabilities: { languages: ["fr"] }, request: { language: "sv-SE" }, message: /language "sv-SE"/ },
      { capabilities: { outputFormats: ["mp3"] }, request: { format: "wav" }, message: /output format "wav"/ },
      { capabilities: { sampleRates: [48_000] }, request: { sampleRate: 24_000 }, message: /sample rate 24000/ },
      { capabilities: { instructions: "unsupported" }, request: { instructions: "Speak warmly" }, message: /does not support instructions/ },
    ];

    for (const testCase of cases) {
      const plugin = createPlugin("local", testCase.capabilities);

      await assert.rejects(
        prepareNarrationProviderRequest(plugin, createRequest(testCase.request), context),
        testCase.message,
      );
    }

    const providerDefined = createPlugin("local", { languages: "provider-defined" });
    const prepared = await prepareNarrationProviderRequest(
      providerDefined,
      createRequest({ language: "arbitrary-authored-locale" }),
      context,
    );

    assert.equal(providerDefined.capabilities.offlineSynthesis, true);
    assert.equal(prepared.language, "arbitrary-authored-locale");
  });

  test("forwards and enforces the caller AbortSignal around preparation", async () => {
    const controller = new AbortController();
    const context = { cacheDir: "/tmp/cache", signal: controller.signal };
    let receivedSignal: AbortSignal | undefined;
    const plugin = createPlugin("local", {}, undefined, (request, receivedContext) => {
      receivedSignal = receivedContext.signal;
      controller.abort(new Error("cancelled"));
      return request;
    });

    await assert.rejects(
      prepareNarrationProviderRequest(plugin, createRequest(), context),
      /cancelled/,
    );
    assert.equal(receivedSignal, controller.signal);
  });
});

function createPlugin(
  name: string,
  capabilities: Partial<NarrationProviderCapabilities> = {},
  close?: NarrationProviderPlugin["close"],
  prepareRequest: NarrationProviderPlugin["prepareRequest"] = (request) => request,
): NarrationProviderPlugin {
  return {
    name,
    capabilities: { ...BASE_CAPABILITIES, ...capabilities },
    prepareRequest,
    async synthesize(request) {
      return {
        request,
        output: { kind: "bytes", bytes: new Uint8Array([1]) },
        metadata: {
          provider: request.provider,
          model: request.model,
          voice: request.voice,
          format: request.format,
          sampleRate: request.sampleRate,
          language: request.language,
          providerOptions: request.providerOptions,
        },
      };
    },
    close,
  };
}

function createRequest(overrides: Partial<NarrationRequest> = {}): NarrationRequest {
  return createNarrationRequest({
    provider: "local",
    model: "model-v1",
    voice: "voice-a",
    format: "wav",
    sampleRate: 24_000,
    instructions: "",
    language: "en-us",
    text: "Hello",
    ...overrides,
  });
}

function createContext() {
  return {
    cacheDir: "/tmp/cache",
    signal: new AbortController().signal,
  };
}
