export const OPENAI_NARRATION_MODELS = [
  "gpt-4o-mini-tts",
  "tts-1",
  "tts-1-hd",
] as const;

export const DEFAULT_OPENAI_NARRATION_MODEL = "gpt-4o-mini-tts";

export const DEFAULT_ELEVENLABS_NARRATION_MODEL = "eleven_multilingual_v2";

/** Providers that call a hosted API and need a key. */
export type ApiKeyNarrationProviderName = "openai" | "elevenlabs";

/** Local providers, such as kokoro, run on the machine and need no key. */
export type NarrationProviderName = ApiKeyNarrationProviderName | "kokoro";

/** The environment variable each provider reads its API key from. A new
 * provider that needs a key must name one here (Studio lists providers from this table). */
export const NARRATION_PROVIDER_API_KEY_ENV: Readonly<Record<ApiKeyNarrationProviderName, string>> = {
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

/** Supplies an API key on demand (for example from a saved credential). It is
 * called only when speech must be synthesized, never for cache hits. When it
 * gives no key, the provider reads its environment variable. */
export type NarrationApiKeyResolver = () => string | undefined | Promise<string | undefined>;

export type NarrationProviderOptions = Record<string, unknown>;

export type NarrationRequest = {
  provider: NarrationProviderName;
  model: string;
  voice: string;
  format: string;
  sampleRate: number;
  instructions: string;
  language?: string;
  providerOptions?: NarrationProviderOptions;
  text: string;
};

export type NarrationRequestInput = NarrationRequest;

export type NarrationSynthesisOutput =
  | {
      kind: "bytes";
      bytes: Uint8Array;
    }
  | {
      kind: "file";
      path: string;
    };

export type NarrationSynthesisMetadata = Pick<
  NarrationRequest,
  "provider" | "model" | "voice" | "format" | "sampleRate" | "language" | "providerOptions"
>;

export type NarrationSynthesisResult = {
  request: NarrationRequest;
  output: NarrationSynthesisOutput;
  metadata: NarrationSynthesisMetadata;
};

export interface NarrationProvider {
  synthesize(request: NarrationRequest): Promise<NarrationSynthesisResult>;
}

export function normalizeNarrationText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function createNarrationRequest(input: NarrationRequestInput): NarrationRequest {
  if (!Number.isInteger(input.sampleRate) || input.sampleRate <= 0) {
    throw new Error("Narration sampleRate must be a positive integer.");
  }

  const { language, ...request } = input;
  const normalizedLanguage = normalizeNarrationLanguage(language);

  return {
    ...request,
    ...(normalizedLanguage === undefined ? {} : { language: normalizedLanguage }),
    text: normalizeNarrationText(input.text),
  };
}

function normalizeNarrationLanguage(language: string | undefined): string | undefined {
  const normalized = language?.trim();

  return normalized === "" ? undefined : normalized;
}
