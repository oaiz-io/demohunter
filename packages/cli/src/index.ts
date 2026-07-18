import type { Locator, Page, Response } from "playwright";

export type BrowserName = "chromium" | "firefox" | "webkit";
export type RecordFormat = "mp4" | "webm";
export type HighlightStyle = "ring" | "spotlight";
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
  showCursor?: boolean;
  /** Render a ripple animation on clicks during the recording pass. Default: true */
  showClickRipple?: boolean;
  /** Default highlight style applied when a tour omits a per-call style. Default: "ring" */
  highlightStyle?: HighlightStyle;
  cookieBanners?: CookieBannerConfig;
};

export type DemoHunterUserRecordConfig = Partial<Omit<RecordConfig, "cookieBanners">> & {
  cookieBanners?: Partial<CookieBannerConfig>;
};

export type GenerateOverrides = {
  cookieDismiss?: false | CookieDismissAction;
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

export type ChapterOptions = {
  id?: string;
};

export type NarrateOptions = {
  voice?: string;
  model?: string;
  format?: string;
  instructions?: string;
  language?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
  cacheKeyHint?: string;
};

export type WaitForStableOptions = {
  state?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
};

export type HighlightOptions = {
  name?: string;
  paddingPx?: number;
  /** Visual style applied during the recording pass. Defaults to config.record.highlightStyle. */
  style?: "ring" | "spotlight";
  /** How long the highlight stays visible during the recording pass, in milliseconds. Default: 800 */
  durationMs?: number;
};

export type SnapshotOptions = {
  name?: string;
};

export type AssertVisibleOptions = {
  timeoutMs?: number;
};

export type TypeTextPace =
  | "fast"
  | "natural"
  | "slow"
  | {
      minDelayMs: number;
      maxDelayMs: number;
      spacePauseMs?: number;
      punctuationPauseMs?: number;
    };

export type TypeTextOptions = {
  replace?: boolean;
  pace?: TypeTextPace;
  seed?: string | number;
  timeoutMs?: number;
};

export type DemoHunterLifecycleContext = {
  config: ResolvedDemoHunterConfig;
  goto: DemoHunterGoto;
  page: Page;
};

export type DemoHunterChapter = (title: string, options?: ChapterOptions) => Promise<void>;

export type DemoHunterStep = <T>(title: string, fn: () => Promise<T> | T) => Promise<T>;

export type DemoHunterNarrate = (text: string, options?: NarrateOptions) => Promise<void>;

export type DemoHunterTypeText = (
  target: Locator,
  text: string,
  options?: TypeTextOptions,
) => Promise<void>;

export type DemoHunterNarrationTimeline = {
  sleep(ms: number): Promise<void>;
};

export type DemoHunterNarrateWhileTimeline = DemoHunterNarrationTimeline & {
  typeText: DemoHunterTypeText;
};

export type DemoHunterNarrateWhile<
  TTimeline extends DemoHunterNarrationTimeline = DemoHunterNarrationTimeline,
> = <T>(
  text: string,
  fn: (timeline: TTimeline) => Promise<T> | T,
  options?: NarrateOptions,
) => Promise<T>;

export type DemoHunterAuthorNarrateWhile = DemoHunterNarrateWhile<DemoHunterNarrateWhileTimeline>;

export type DemoHunterWaitForStable = (options?: WaitForStableOptions) => Promise<void>;

export type DemoHunterHighlight = (target: Locator, options?: HighlightOptions) => Promise<void>;

export type DemoHunterSnapshot = (options?: SnapshotOptions) => Promise<void>;

export type DemoHunterAssertVisible = (
  target: Locator,
  options?: AssertVisibleOptions,
) => Promise<void>;

export type DemoHunterGoto = (
  url: string | URL,
  options?: Parameters<Page["goto"]>[1],
) => Promise<null | Response>;

export type DemoHunterRunContext<
  TTimeline extends DemoHunterNarrationTimeline = DemoHunterNarrationTimeline,
> = DemoHunterLifecycleContext & {
  chapter: DemoHunterChapter;
  step: DemoHunterStep;
  narrate: DemoHunterNarrate;
  narrateWhile: DemoHunterNarrateWhile<TTimeline>;
  waitForStable: DemoHunterWaitForStable;
  highlight: DemoHunterHighlight;
  snapshot: DemoHunterSnapshot;
  assertVisible: DemoHunterAssertVisible;
};

export type DemoHunterAuthorRunContext = DemoHunterRunContext<DemoHunterNarrateWhileTimeline>;

export type DemoHunterTour = {
  id: string;
  title: string;
  setup?: (context: DemoHunterLifecycleContext) => Promise<void> | void;
  beforeRecord?: (context: DemoHunterLifecycleContext) => Promise<void> | void;
  run: (context: DemoHunterAuthorRunContext) => Promise<void> | void;
  teardown?: (context: DemoHunterLifecycleContext) => Promise<void> | void;
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

export const DEFAULT_RECORD_CONFIG: RecordConfig = {
  showActions: true,
  showChapters: true,
  format: "mp4",
  showCursor: true,
  showClickRipple: true,
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

export function defineTour<T extends DemoHunterTour>(tour: T): T {
  return tour;
}
