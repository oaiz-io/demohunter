export type BrowserName = "chromium" | "firefox" | "webkit";
export type RecordFormat = "mp4" | "webm";
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

export type RecordConfig = {
  showActions: boolean;
  showChapters: boolean;
  format: RecordFormat;
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

export type DemoHunterUserRecordConfig = Partial<Omit<RecordConfig, "cookieBanners" | "cursor">> & {
  cookieBanners?: Partial<CookieBannerConfig>;
  cursor?: false | Partial<CursorOptions>;
};

export type GenerateOverrides = {
  cookieDismiss?: false | CookieDismissAction;
  cursor?: false | "highlight" | "smooth" | "ripple";
};

export type TTSProviderName = "openai" | "elevenlabs";

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

export type TTSConfig = OpenAITTSConfig | ElevenLabsTTSConfig;

export type DemoHunterUserTTSConfig =
  | (Partial<Omit<OpenAITTSConfig, "provider">> & { provider?: "openai" })
  | (Partial<Omit<ElevenLabsTTSConfig, "provider">> & { provider: "elevenlabs" });

export type DemoHunterUserConfig = {
  baseURL: string;
  outputDir?: string;
  cacheDir?: string;
  browser?: BrowserName;
  viewport?: ViewportConfig;
  holdPaddingMs?: number;
  record?: DemoHunterUserRecordConfig;
  tts?: DemoHunterUserTTSConfig;
};

export type ResolvedDemoHunterConfig = {
  baseURL: string;
  outputDir: string;
  cacheDir: string;
  browser: BrowserName;
  viewport: ViewportConfig;
  holdPaddingMs: number;
  record: RecordConfig;
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

export const DEFAULT_RECORD_CONFIG: RecordConfig = {
  showActions: true,
  showChapters: true,
  format: "mp4",
  showCursor: true,
  showClickRipple: true,
  cursor: DEFAULT_CURSOR_CONFIG,
  highlightStyle: "ring",
  cookieBanners: DEFAULT_COOKIE_BANNER_CONFIG,
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

export const DEFAULT_DEMOHUNTER_CONFIG: Omit<ResolvedDemoHunterConfig, "baseURL"> = {
  outputDir: ".demohunter",
  cacheDir: ".demohunter/cache",
  browser: "chromium",
  viewport: DEFAULT_VIEWPORT_CONFIG,
  holdPaddingMs: 300,
  record: DEFAULT_RECORD_CONFIG,
  tts: DEFAULT_TTS_CONFIG,
};

export function defineConfig<T extends DemoHunterUserConfig>(config: T): T {
  return config;
}
