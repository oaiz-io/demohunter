export const OPENAI_NARRATION_MODELS = [
  "gpt-4o-mini-tts",
  "tts-1",
  "tts-1-hd",
] as const;

export const DEFAULT_OPENAI_NARRATION_MODEL = "gpt-4o-mini-tts";

export const DEFAULT_ELEVENLABS_NARRATION_MODEL = "eleven_multilingual_v2";

export type NarrationProviderName = string;

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
      finalize?: (outcome: NarrationSynthesisFinalizeOutcome) => Promise<void>;
    };

export type NarrationSynthesisFinalizeOutcome =
  | {
      status: "persisted";
    }
  | {
      status: "failed";
      error: unknown;
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

export type NarrationProviderLanguages = "provider-defined" | readonly string[];

export type NarrationProviderOutputFormats = "provider-defined" | readonly string[];

export type NarrationProviderSampleRates = "provider-defined" | readonly number[];

export type NarrationProviderInstructions = "supported" | "unsupported" | "provider-defined";

export type NarrationProviderCapabilities = {
  offlineSynthesis: boolean;
  languages: NarrationProviderLanguages;
  outputFormats: NarrationProviderOutputFormats;
  sampleRates: NarrationProviderSampleRates;
  instructions: NarrationProviderInstructions;
};

export type NarrationProviderPrepareContext = {
  cacheDir: string;
  signal: AbortSignal;
};

export type NarrationProviderSynthesisContext = NarrationProviderPrepareContext;

export type NarrationProviderCloseContext = {
  error?: unknown;
};

export interface NarrationProviderPlugin {
  readonly name: NarrationProviderName;
  readonly capabilities: NarrationProviderCapabilities;
  prepareRequest(
    request: NarrationRequest,
    context: NarrationProviderPrepareContext,
  ): NarrationRequest | Promise<NarrationRequest>;
  synthesize(
    request: NarrationRequest,
    context: NarrationProviderSynthesisContext,
  ): Promise<NarrationSynthesisResult>;
  close?(context: NarrationProviderCloseContext): void | Promise<void>;
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
  assertNarrationProviderName(input.provider);

  if (!Number.isInteger(input.sampleRate) || input.sampleRate <= 0) {
    throw new Error("Narration sampleRate must be a positive integer.");
  }

  const { language, providerOptions, ...request } = input;
  const normalizedLanguage = normalizeNarrationLanguage(language);
  const normalizedProviderOptions = normalizeNarrationProviderOptions(providerOptions);

  return {
    ...request,
    ...(normalizedLanguage === undefined ? {} : { language: normalizedLanguage }),
    ...("providerOptions" in input ? { providerOptions: normalizedProviderOptions } : {}),
    text: normalizeNarrationText(input.text),
  };
}

export function assertNarrationProviderName(provider: string): void {
  if (provider.trim().length === 0) {
    throw new Error("Narration provider name must be a non-empty string.");
  }
}

export function normalizeNarrationProviderOptions(
  options: NarrationProviderOptions | undefined,
): NarrationProviderOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  return normalizePortableValue(options, "providerOptions", new Set()) as NarrationProviderOptions;
}

function normalizePortableValue(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Narration ${path} must contain only finite numbers.`);
    }

    return value;
  }

  if (typeof value !== "object") {
    throw new Error(`Narration ${path} must contain only JSON-compatible values.`);
  }

  if (ancestors.has(value)) {
    throw new Error(`Narration ${path} must not contain circular references.`);
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((child, index) => normalizePortableValue(child, `${path}[${index}]`, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Narration ${path} must contain only plain objects and arrays.`);
    }

    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizePortableValue(child, `${path}.${key}`, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function normalizeNarrationLanguage(language: string | undefined): string | undefined {
  const normalized = language?.trim();

  return normalized === "" ? undefined : normalized;
}
