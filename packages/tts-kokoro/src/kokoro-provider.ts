import { createRequire } from "node:module";
import path from "node:path";

import {
  createNarrationRequest,
  type NarrationProvider,
  type NarrationRequest,
  type NarrationSynthesisResult,
} from "@demohunter/tts-core";

type KokoroAudio = {
  toWav(): ArrayBuffer;
};

type KokoroModel = {
  generate(text: string, options: { voice: string }): Promise<KokoroAudio>;
};

type KokoroModule = {
  KokoroTTS: {
    from_pretrained(
      modelId: string,
      options: { dtype: string; device: string },
    ): Promise<KokoroModel>;
  };
};

export type KokoroNarrationProviderOptions = {
  projectRoot: string;
};

// Loading the model takes seconds, and a provider is created per narration line,
// so loaded models are shared across all providers in the process.
const loadedModels = new Map<string, Promise<KokoroModel>>();

export function createKokoroNarrationProvider(
  options: KokoroNarrationProviderOptions,
): NarrationProvider {
  return {
    async synthesize(request: NarrationRequest): Promise<NarrationSynthesisResult> {
      const normalizedRequest = createNarrationRequest(request);

      if (normalizedRequest.format !== "wav") {
        throw new Error(
          `Kokoro narration only supports the "wav" format, got "${normalizedRequest.format}".`,
        );
      }

      const model = await loadModel(options.projectRoot, normalizedRequest.model);
      const audio = await model.generate(normalizedRequest.text, {
        voice: normalizedRequest.voice,
      });

      return {
        request: normalizedRequest,
        output: {
          kind: "bytes",
          bytes: new Uint8Array(audio.toWav()),
        },
        metadata: {
          provider: normalizedRequest.provider,
          model: normalizedRequest.model,
          voice: normalizedRequest.voice,
          format: normalizedRequest.format,
          sampleRate: normalizedRequest.sampleRate,
          language: normalizedRequest.language,
        },
      };
    },
  };
}

function loadModel(projectRoot: string, modelId: string): Promise<KokoroModel> {
  let model = loadedModels.get(modelId);

  if (model === undefined) {
    model = Promise.resolve()
      .then(() => requireKokoro(projectRoot))
      .then((kokoro) => kokoro.KokoroTTS.from_pretrained(modelId, { dtype: "q8", device: "cpu" }));
    loadedModels.set(modelId, model);
    // Forget failed loads so the next line can retry instead of reusing the error.
    model.catch(() => loadedModels.delete(modelId));
  }

  return model;
}

// kokoro-js is optional and heavy, so it is resolved from the user's project
// at runtime instead of being bundled into DemoHunter.
function requireKokoro(projectRoot: string): KokoroModule {
  const requireFromProject = createRequire(path.join(projectRoot, "package.json"));

  try {
    return requireFromProject("kokoro-js") as KokoroModule;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      throw new Error(
        'Kokoro narration requires the "kokoro-js" package. Install it in your project: npm install kokoro-js',
        { cause: error },
      );
    }

    throw error;
  }
}
