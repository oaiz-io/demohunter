import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { createKokoroNarrationProvider } from "./index.js";

type FakeKokoroState = {
  loads: Array<{ modelId: string; options: unknown }>;
  generates: Array<{ text: string; options: unknown }>;
  failNextLoad: boolean;
};

const fakeGlobal = globalThis as typeof globalThis & { __fakeKokoro?: FakeKokoroState };

// CommonJS fake of kokoro-js, loaded through the provider's real createRequire path.
const FAKE_KOKORO_SOURCE = `
module.exports.KokoroTTS = {
  async from_pretrained(modelId, options) {
    const state = globalThis.__fakeKokoro;
    state.loads.push({ modelId, options });
    if (state.failNextLoad) {
      state.failNextLoad = false;
      throw new Error("fake load failure");
    }
    return {
      async generate(text, options) {
        state.generates.push({ text, options });
        return { toWav: () => new Uint8Array([82, 73, 70, 70]).buffer };
      },
    };
  },
};
`;

let projectRoot: string;
let state: FakeKokoroState;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), "demohunter-kokoro-"));
  state = { loads: [], generates: [], failNextLoad: false };
  fakeGlobal.__fakeKokoro = state;
});

afterEach(async () => {
  delete fakeGlobal.__fakeKokoro;
  await rm(projectRoot, { recursive: true, force: true });
});

describe("createKokoroNarrationProvider", () => {
  test("generates wav bytes with the requested model and voice", async () => {
    await installFakeKokoro(projectRoot);
    const provider = createKokoroNarrationProvider({ projectRoot });

    const result = await provider.synthesize(
      createRequest({ model: "model-shape", voice: "bf_emma", text: "  Explain billing  ", language: " en " }),
    );

    assert.deepEqual(state.loads, [{ modelId: "model-shape", options: { dtype: "q8", device: "cpu" } }]);
    assert.deepEqual(state.generates, [{ text: "Explain billing", options: { voice: "bf_emma" } }]);
    assert.deepEqual(result.output, { kind: "bytes", bytes: new Uint8Array([82, 73, 70, 70]) });
    assert.deepEqual(result.metadata, {
      provider: "kokoro",
      model: "model-shape",
      voice: "bf_emma",
      format: "wav",
      sampleRate: 24_000,
      language: "en",
    });
  });

  test("rejects non-wav formats before loading the model", async () => {
    await installFakeKokoro(projectRoot);
    const provider = createKokoroNarrationProvider({ projectRoot });

    await assert.rejects(
      () => provider.synthesize(createRequest({ model: "model-format", format: "mp3" })),
      /only supports the "wav" format/,
    );
    assert.equal(state.loads.length, 0);
  });

  test("explains how to install kokoro-js when it is missing", async () => {
    const provider = createKokoroNarrationProvider({ projectRoot });

    await assert.rejects(
      () => provider.synthesize(createRequest({ model: "model-missing" })),
      /npm install kokoro-js/,
    );
  });

  test("loads each model once across providers", async () => {
    await installFakeKokoro(projectRoot);

    await createKokoroNarrationProvider({ projectRoot }).synthesize(createRequest({ model: "model-shared" }));
    await createKokoroNarrationProvider({ projectRoot }).synthesize(createRequest({ model: "model-shared" }));

    assert.equal(state.loads.length, 1);
    assert.equal(state.generates.length, 2);
  });

  test("retries loading after a failed load", async () => {
    await installFakeKokoro(projectRoot);
    const provider = createKokoroNarrationProvider({ projectRoot });
    state.failNextLoad = true;

    await assert.rejects(
      () => provider.synthesize(createRequest({ model: "model-retry" })),
      /fake load failure/,
    );
    await provider.synthesize(createRequest({ model: "model-retry" }));

    assert.equal(state.loads.length, 2);
    assert.equal(state.generates.length, 1);
  });
});

async function installFakeKokoro(root: string): Promise<void> {
  const packageDir = path.join(root, "node_modules", "kokoro-js");
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "kokoro-js", main: "index.js" }));
  await writeFile(path.join(packageDir, "index.js"), FAKE_KOKORO_SOURCE);
}

// Model ids must be unique per test: loaded models are memoized for the whole process.
function createRequest(
  input: Partial<{
    model: string;
    voice: string;
    format: string;
    language: string;
    text: string;
  }> = {},
) {
  return {
    provider: "kokoro" as const,
    model: input.model ?? "model-default",
    voice: input.voice ?? "af_heart",
    format: input.format ?? "wav",
    sampleRate: 24_000,
    instructions: "",
    ...(input.language === undefined ? {} : { language: input.language }),
    text: input.text ?? "Explain billing",
  };
}
