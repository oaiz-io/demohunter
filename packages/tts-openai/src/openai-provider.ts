import {
  createNarrationRequest,
  type NarrationApiKeyResolver,
  type NarrationProvider,
  type NarrationRequest,
  type NarrationSynthesisResult,
} from "@demohunter/tts-core";

const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const OPENAI_SUPPORTED_NARRATION_MODELS = [
  "gpt-4o-mini-tts",
  "tts-1",
  "tts-1-hd",
] as const;

export type OpenAINarrationProviderOptions = {
  fetch?: typeof globalThis.fetch;
  /** Gives the API key (for example a key saved in Studio). Without one, the
   * key comes from OPENAI_API_KEY. */
  resolveApiKey?: NarrationApiKeyResolver;
};

export function createOpenAINarrationProvider(
  options: OpenAINarrationProviderOptions = {},
): NarrationProvider {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    async synthesize(request: NarrationRequest): Promise<NarrationSynthesisResult> {
      if (fetchImplementation === undefined) {
        throw new Error("OpenAI narration requires a fetch implementation in the current runtime.");
      }

      const normalizedRequest = createNarrationRequest(request);

      assertSupportedModel(normalizedRequest.model);

      const apiKey = (await options.resolveApiKey?.()) || process.env.OPENAI_API_KEY;

      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required to synthesize narration with OpenAI.");
      }

      const response = await fetchImplementation(OPENAI_SPEECH_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: normalizedRequest.model,
          voice: normalizedRequest.voice,
          instructions: createInstructions(normalizedRequest),
          response_format: normalizedRequest.format,
          input: normalizedRequest.text,
        }),
      });

      if (!response.ok) {
        const detail = await readFailureDetail(response);
        const statusText = response.statusText ? ` ${response.statusText}` : "";

        throw new Error(
          detail
            ? `OpenAI speech synthesis failed (${response.status}${statusText}): ${detail}`
            : `OpenAI speech synthesis failed (${response.status}${statusText}).`,
        );
      }

      return {
        request: normalizedRequest,
        output: {
          kind: "bytes",
          bytes: new Uint8Array(await response.arrayBuffer()),
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

function createInstructions(request: NarrationRequest): string {
  const language = request.language?.trim();

  if (language === undefined || language === "") {
    return request.instructions;
  }

  const languageInstruction = `Use the language and native accent matching ${language}.`;

  return request.instructions.trim() === ""
    ? languageInstruction
    : `${request.instructions.trim()} ${languageInstruction}`;
}

async function readFailureDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function assertSupportedModel(
  model: string,
): asserts model is (typeof OPENAI_SUPPORTED_NARRATION_MODELS)[number] {
  if (OPENAI_SUPPORTED_NARRATION_MODELS.includes(model as (typeof OPENAI_SUPPORTED_NARRATION_MODELS)[number])) {
    return;
  }

  throw new Error(`Unsupported OpenAI narration model: ${model}`);
}
