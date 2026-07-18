import type { Locator, Page, Response } from "playwright";
import type { ElevenLabsVoiceSettings, ResolvedDemoHunterConfig } from "./config.js";

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

export type DemoHunterClickOptions = {
  position?: { x: number; y: number };
  motion?: "smooth" | "instant";
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

export type DemoHunterClick = (
  target: Locator,
  options?: DemoHunterClickOptions,
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
  click: DemoHunterClick;
};

export type DemoHunterAuthorRunContext = DemoHunterRunContext<DemoHunterNarrateWhileTimeline>;
