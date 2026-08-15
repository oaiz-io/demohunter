export type BrowserName = "chromium" | "firefox" | "webkit";
export type RecordFormat = "mp4" | "webm";
export type OutputPresetName = "standard" | "square" | "mobile" | "gif";
export type OutputLayout = "fit" | "responsive";

export type OutputFormatRequest = {
  preset: OutputPresetName;
  layout?: OutputLayout;
  /** GIF duration in milliseconds. Valid only for the gif preset. */
  durationMs?: number;
};

export type OutputConfig = {
  formats: OutputFormatRequest[];
};
export type HighlightStyle = "ring" | "spotlight";
export type CursorMode = "highlight" | "smooth";
export type CursorShape = "dot" | "pointer";

export type CursorOptions = {
  mode: CursorMode;
  shape: CursorShape;
  color: string;
  sizePx: number;
  minDurationMs: number;
  maxDurationMs: number;
  pixelsPerMs: number;
  arcHeightPx: number;
  ripple: boolean;
};

export type CursorConfig = false | CursorOptions;
export type CookieDismissAction = "reject" | "accept" | "hide";

export type CookieBannerConfig = {
  enabled: boolean;
  action: CookieDismissAction;
  timeoutMs: number;
  additionalSelectors: string[];
};

export type ViewportConfig = {
  width: number;
  height: number;
};

type RecordBehaviorConfig = {
  showActions: boolean;
  showChapters: boolean;
  /** Render a custom DOM cursor in the recording pass. Default: true */
  /** @deprecated Use cursor instead. */
  showCursor?: boolean;
  /** Render a ripple animation on clicks during the recording pass. Default: true */
  /** @deprecated Use cursor.ripple instead. */
  showClickRipple?: boolean;
  /** Configures the rendered cursor. Set false to use Playwright's native action cursor. */
  cursor?: CursorConfig;
  /** Default highlight style applied when a tour omits a per-call style. Default: "ring" */
  highlightStyle?: HighlightStyle;
  /** Safely dismiss recognized vendor cookie banners before recording. Default: disabled. */
  cookieBanners?: CookieBannerConfig;
};

/**
 * Record settings accepted by authored configurations. During the container-name
 * migration, either the preferred `container` field or legacy `format` field is
 * required when constructing this complete type directly.
 */
export type RecordConfig = RecordBehaviorConfig &
  (
    | { container: RecordFormat; /** @deprecated Use container instead. */ format?: RecordFormat }
    | { container?: RecordFormat; /** @deprecated Use container instead. */ format: RecordFormat }
  );

/** Fully normalized recording settings exposed to tour runtimes. */
export type ResolvedRecordConfig = RecordBehaviorConfig & {
  container: RecordFormat;
  /** @deprecated Mirrors container for compatibility. */
  format: RecordFormat;
};

export type DemoHunterUserRecordConfig = Partial<Omit<ResolvedRecordConfig, "cookieBanners" | "cursor">> & {
  cookieBanners?: Partial<CookieBannerConfig>;
  cursor?: false | Partial<CursorOptions>;
};

export type GenerateOverrides = {
  cookieDismiss?: false | CookieDismissAction;
  cursor?: false | "highlight" | "smooth" | "ripple";
  outputFormats?: OutputFormatRequest[];
};

export type TTSProviderName = string;

export type NarrationProviderDescriptor<Name extends string = string, Options = unknown> = {
  name: Name;
  options: Options;
};

export type NarrationProvidersConfig = {
  tts: readonly NarrationProviderDescriptor[];
};

export type KokoroCommandProviderOptions = {
  runtime: "command";
  executable: string;
  args?: readonly string[];
  modelPath?: string;
  voicesPath?: string;
  modelVersion?: string;
  backendVersion?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export type KokoroBundledProviderOptions = {
  runtime?: "bundled";
  pythonCommand?: string;
  pythonArgs?: readonly string[];
  /** Explicit alternative to DemoHunter's bundled worker. Never interpreted as a shell command. */
  workerPath?: string;
  modelPath?: string;
  voicesPath?: string;
  modelVersion?: string;
  backendVersion?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export type KokoroProviderOptions = KokoroCommandProviderOptions | KokoroBundledProviderOptions;
export type KokoroProviderDescriptor = NarrationProviderDescriptor<"kokoro", KokoroProviderOptions>;

export type ElevenLabsVoiceSettings = {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
};

export type OpenAITTSConfig = {
  provider: "openai";
  model: string;
  voice: string;
  format: string;
  instructions: string;
  language?: string;
};

export type ElevenLabsTTSConfig = {
  provider: "elevenlabs";
  model: string;
  voice: string;
  format: string;
  instructions: string;
  language?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
};

export type KokoroLanguage = "en-US" | "en-GB" | "es" | "fr" | "hi" | "it" | "ja" | "pt-BR" | "zh";

export type KokoroTTSConfig = {
  provider: "kokoro";
  model: string;
  voice: string;
  format: "wav";
  instructions: "";
  language: KokoroLanguage;
  speed?: number;
};

export type CustomTTSConfig = {
  provider: string;
  model: string;
  voice: string;
  format: string;
  instructions: string;
  language?: string;
  providerOptions?: Record<string, unknown>;
  voiceSettings?: ElevenLabsVoiceSettings;
  speed?: number;
};

export type TTSConfig = OpenAITTSConfig | ElevenLabsTTSConfig | KokoroTTSConfig | CustomTTSConfig;

export type DemoHunterUserTTSConfig =
  | (Partial<Omit<OpenAITTSConfig, "provider">> & { provider?: "openai" })
  | (Partial<Omit<ElevenLabsTTSConfig, "provider">> & { provider: "elevenlabs" })
  | (Partial<Omit<KokoroTTSConfig, "provider">> & { provider: "kokoro" })
  | ({ provider: string } & Partial<Omit<CustomTTSConfig, "provider">>);

export type DemoHunterUserConfig = {
  baseURL: string;
  outputDir?: string;
  cacheDir?: string;
  browser?: BrowserName;
  viewport?: ViewportConfig;
  holdPaddingMs?: number;
  record?: DemoHunterUserRecordConfig;
  output?: Partial<OutputConfig>;
  providers?: { tts?: readonly NarrationProviderDescriptor[] };
  tts?: DemoHunterUserTTSConfig;
};

export type ResolvedDemoHunterConfig = {
  baseURL: string;
  outputDir: string;
  cacheDir: string;
  browser: BrowserName;
  viewport: ViewportConfig;
  holdPaddingMs: number;
  record: ResolvedRecordConfig;
  output: OutputConfig;
  providers?: NarrationProvidersConfig;
  tts: TTSConfig;
};

export const DEFAULT_VIEWPORT_CONFIG: ViewportConfig = {
  width: 1440,
  height: 900,
};

export const DEFAULT_COOKIE_BANNER_CONFIG: CookieBannerConfig = {
  enabled: false,
  action: "reject",
  timeoutMs: 750,
  additionalSelectors: [],
};

export const DEFAULT_CURSOR_CONFIG: CursorOptions = {
  mode: "smooth",
  shape: "pointer",
  color: "#3b82f6",
  sizePx: 20,
  minDurationMs: 400,
  maxDurationMs: 1200,
  pixelsPerMs: 1.4,
  arcHeightPx: 56,
  ripple: true,
};

export const DEFAULT_RECORD_CONFIG: ResolvedRecordConfig = {
  showActions: true,
  showChapters: true,
  container: "mp4",
  format: "mp4",
  showCursor: true,
  showClickRipple: true,
  cursor: DEFAULT_CURSOR_CONFIG,
  highlightStyle: "ring",
  cookieBanners: DEFAULT_COOKIE_BANNER_CONFIG,
};

export const DEFAULT_OUTPUT_CONFIG: OutputConfig = {
  formats: [],
};

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  provider: "openai",
  model: "gpt-4o-mini-tts",
  voice: "marin",
  format: "mp3",
  instructions: "Speak clearly, calm, concise, product-demo style.",
};

export const DEFAULT_ELEVENLABS_TTS_CONFIG: ElevenLabsTTSConfig = {
  provider: "elevenlabs",
  model: "eleven_multilingual_v2",
  voice: "JBFqnCBsd6RMkjVDRZzb",
  format: "mp3_44100_128",
  instructions: "",
  voiceSettings: {
    stability: 0.5,
    similarityBoost: 0.75,
    useSpeakerBoost: true,
  },
};

export const DEFAULT_KOKORO_TTS_CONFIG: KokoroTTSConfig = {
  provider: "kokoro",
  model: "kokoro-82m",
  voice: "af_heart",
  format: "wav",
  instructions: "",
  language: "en-US",
};

export const DEFAULT_DEMOHUNTER_CONFIG: Omit<ResolvedDemoHunterConfig, "baseURL"> = {
  outputDir: ".demohunter",
  cacheDir: ".demohunter/cache",
  browser: "chromium",
  viewport: DEFAULT_VIEWPORT_CONFIG,
  holdPaddingMs: 300,
  record: DEFAULT_RECORD_CONFIG,
  output: DEFAULT_OUTPUT_CONFIG,
  tts: DEFAULT_TTS_CONFIG,
};

export function defineConfig<T extends DemoHunterUserConfig>(config: T): T {
  return config;
}

/** Creates a process-free provider descriptor for authored configuration. */
export function kokoro(options: KokoroProviderOptions = {}): KokoroProviderDescriptor {
  return {
    name: "kokoro",
    options: {
      runtime: "bundled",
      ...options,
      ...(options.runtime === "command" && options.args !== undefined
        ? { args: [...options.args] }
        : {}),
      ...(options.runtime !== "command" && options.pythonArgs !== undefined
        ? { pythonArgs: [...options.pythonArgs] }
        : {}),
    },
  } as KokoroProviderDescriptor;
}

/** Creates the semantic WAV/24 kHz Kokoro narration settings. */
export function kokoroTTS(options: Partial<Omit<KokoroTTSConfig, "provider" | "format" | "instructions">> = {}): KokoroTTSConfig {
  return {
    ...DEFAULT_KOKORO_TTS_CONFIG,
    ...options,
  };
}

export function resolveOutputFormatRequests(
  formats: readonly OutputFormatRequest[],
): OutputFormatRequest[] {
  if (!Array.isArray(formats)) {
    throw new Error("output.formats must be an array of output format requests");
  }

  const seen = new Set<OutputPresetName>();

  return formats.map((request) => {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw new Error("Each output.formats entry must be an object with a preset");
    }
    if (
      request.preset !== "standard"
      && request.preset !== "square"
      && request.preset !== "mobile"
      && request.preset !== "gif"
    ) {
      throw new Error(
        `Invalid output preset: ${String(request.preset)}. Expected standard, square, mobile, or gif.`,
      );
    }
    if (request.layout !== undefined && request.layout !== "fit" && request.layout !== "responsive") {
      throw new Error(
        `Invalid output layout for ${request.preset}: ${String(request.layout)}. Expected fit or responsive.`,
      );
    }

    if (seen.has(request.preset)) {
      throw new Error(`output.formats contains duplicate preset: ${request.preset}`);
    }
    seen.add(request.preset);

    if (request.durationMs !== undefined && request.preset !== "gif") {
      throw new Error("output.formats durationMs is valid only for the gif preset");
    }
    if (request.preset === "gif") {
      const durationMs = request.durationMs ?? 15_000;
      if (!Number.isInteger(durationMs) || durationMs <= 0 || durationMs > 15_000) {
        throw new Error("GIF durationMs must be a positive integer no greater than 15000");
      }
      if (request.layout === "responsive") {
        throw new Error("The gif preset is derived from MP4 and supports only fit layout");
      }
      return { preset: "gif", layout: "fit", durationMs };
    }
    if (request.preset === "mobile") {
      if (request.layout === "fit") {
        throw new Error("The mobile preset requires responsive layout");
      }
      return { preset: "mobile", layout: "responsive" };
    }

    return { preset: request.preset, layout: request.layout ?? "fit" };
  });
}
