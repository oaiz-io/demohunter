import {
  createNarrationRequest,
  normalizeNarrationText,
  type NarrationProvider,
  type NarrationProviderPlugin,
  type NarrationRequest,
  type NarrationSynthesisResult,
} from "@demohunter/tts-core";

const ELEVENLABS_SPEECH_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";

export type ElevenLabsVoiceSettings = {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
};

export type ElevenLabsNarrationProviderOptions = {
  fetch?: typeof globalThis.fetch;
};

export function createElevenLabsNarrationProvider(
  options: ElevenLabsNarrationProviderOptions = {},
): NarrationProvider {
  const plugin = createElevenLabsNarrationProviderPlugin(options);

  return {
    async synthesize(request) {
      const context = {
        cacheDir: process.cwd(),
        signal: new AbortController().signal,
      };
      const prepared = await plugin.prepareRequest(request, context);

      return await plugin.synthesize(prepared, context);
    },
  };
}

export function createElevenLabsNarrationProviderPlugin(
  options: ElevenLabsNarrationProviderOptions = {},
): NarrationProviderPlugin {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    name: "elevenlabs",
    capabilities: {
      offlineSynthesis: false,
      languages: "provider-defined",
      outputFormats: "provider-defined",
      sampleRates: "provider-defined",
      instructions: "provider-defined",
    },
    prepareRequest(request) {
      if (request.provider !== "elevenlabs") {
        throw new Error(`ElevenLabs narration received unsupported provider: ${request.provider}`);
      }

      const providerOptions = {
        ...request.providerOptions,
      };

      if (request.model === "eleven_v3") {
        delete providerOptions.previousText;
        delete providerOptions.nextText;
      } else {
        const previousText = normalizeContextText(providerOptions.previousText);
        const nextText = normalizeContextText(providerOptions.nextText);

        if (previousText === undefined) delete providerOptions.previousText;
        else providerOptions.previousText = previousText;
        if (nextText === undefined) delete providerOptions.nextText;
        else providerOptions.nextText = nextText;
      }

      return createNarrationRequest({
        ...request,
        providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
      });
    },
    async synthesize(request, context): Promise<NarrationSynthesisResult> {
      if (fetchImplementation === undefined) {
        throw new Error("ElevenLabs narration requires a fetch implementation in the current runtime.");
      }

      if (request.provider !== "elevenlabs") {
        throw new Error(`ElevenLabs narration received unsupported provider: ${request.provider}`);
      }

      const normalizedRequest = createNarrationRequest(request);
      context.signal.throwIfAborted();

      const apiKey = process.env.ELEVENLABS_API_KEY;

      if (!apiKey) {
        throw new Error("ELEVENLABS_API_KEY is required to synthesize narration with ElevenLabs.");
      }

      const response = await fetchImplementation(createSpeechUrl(normalizedRequest), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify(createSpeechBody(normalizedRequest)),
        signal: context.signal,
      });

      if (!response.ok) {
        const detail = await readFailureDetail(response);
        const statusText = response.statusText ? ` ${response.statusText}` : "";

        throw new Error(
          detail
            ? `ElevenLabs speech synthesis failed (${response.status}${statusText}): ${detail}`
            : `ElevenLabs speech synthesis failed (${response.status}${statusText}).`,
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
          providerOptions: normalizedRequest.providerOptions,
        },
      };
    },
  };
}

function normalizeContextText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeNarrationText(value);
  return normalized === "" ? undefined : normalized;
}

function createSpeechUrl(request: NarrationRequest): string {
  const url = new URL(`${ELEVENLABS_SPEECH_ENDPOINT}/${encodeURIComponent(request.voice)}`);
  url.searchParams.set("output_format", request.format);
  return url.href;
}

function createSpeechBody(request: NarrationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text: request.text,
    model_id: request.model,
  };
  const language = request.language?.trim();
  const voiceSettings = readVoiceSettings(request.providerOptions);
  const previousText = readNonBlankProviderOption(request.providerOptions, "previousText");
  const nextText = readNonBlankProviderOption(request.providerOptions, "nextText");

  if (language !== undefined && language !== "") {
    body.language_code = language;
  }

  if (previousText !== undefined) {
    body.previous_text = previousText;
  }

  if (nextText !== undefined) {
    body.next_text = nextText;
  }

  if (voiceSettings !== undefined) {
    body.voice_settings = {
      stability: voiceSettings.stability,
      similarity_boost: voiceSettings.similarityBoost,
      style: voiceSettings.style,
      use_speaker_boost: voiceSettings.useSpeakerBoost,
      speed: voiceSettings.speed,
    };
  }

  return pruneUndefined(body);
}

function readVoiceSettings(
  providerOptions: NarrationRequest["providerOptions"],
): ElevenLabsVoiceSettings | undefined {
  const value = providerOptions?.voiceSettings;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as ElevenLabsVoiceSettings;
}

function readNonBlankProviderOption(
  providerOptions: NarrationRequest["providerOptions"],
  key: string,
): string | undefined {
  const value = providerOptions?.[key];

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  return normalized === "" ? undefined : normalized;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [
        key,
        typeof child === "object" && child !== null && !Array.isArray(child)
          ? pruneUndefined(child as Record<string, unknown>)
          : child,
      ]),
  ) as T;
}

async function readFailureDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
