import type {
  AssertVisibleOptions,
  DemoHunterClickOptions,
  HighlightOptions,
  NarrateOptions,
  SnapshotOptions,
  TypeTextOptions,
  WaitForStableOptions,
} from "@demohunter/sdk";

export const TOUR_RUNTIME_EVENT_KINDS = [
  "chapter",
  "step-start",
  "step-end",
  "narrate",
  "type-text",
  "narration-sleep",
  "wait-for-stable",
  "highlight",
  "snapshot",
  "assert-visible",
  "click",
] as const;

export type TourRuntimeEvent =
  | {
      kind: "chapter";
      title: string;
      chapterTitle: string;
      outputDir: string;
      id?: string;
    }
  | {
      kind: "step-start" | "step-end";
      title: string;
      chapterTitle?: string;
    }
  | ({
      kind: "narrate";
      text: string;
      chapterTitle?: string;
    } & NarrateOptions)
  | ({
      kind: "type-text";
      delaysMs: number[];
      text: string;
      chapterTitle?: string;
    } & TypeTextOptions)
  | {
      kind: "narration-sleep";
      durationMs: number;
      chapterTitle?: string;
    }
  | ({
      kind: "wait-for-stable";
      chapterTitle?: string;
    } & WaitForStableOptions & { state: "load" | "domcontentloaded" | "networkidle" })
  | ({
      kind: "highlight";
      chapterTitle?: string;
    } & HighlightOptions)
  | ({
      kind: "snapshot";
      chapterTitle?: string;
    } & SnapshotOptions)
  | ({
      kind: "assert-visible";
      chapterTitle?: string;
    } & AssertVisibleOptions)
  | ({
      kind: "click";
      chapterTitle?: string;
      durationMs: number;
    } & DemoHunterClickOptions);

export type NarrationRuntimeEvent = Extract<TourRuntimeEvent, { kind: "narrate" }>;
export type NonNarrationRuntimeEvent = Exclude<TourRuntimeEvent, { kind: "narrate" }>;

export type NarrationSegment = {
  text: string;
  chapterTitle?: string;
  durationMs: number;
  audioPath: string;
  cacheKey: string;
};

export type NarrationResolverContext = {
  previousText?: string;
  nextText?: string;
};

export type PortableVideoOutputs = {
  mp4: {
    fileName: "video.mp4";
    format: "mp4";
    path: string;
  };
  webm?: {
    fileName: "video.webm";
    format: "webm";
    path: string;
  };
};

export type RecordedNarration = NarrationSegment & {
  startMs: number;
  endMs: number;
};

export type NarrationSegmentResolver = (
  event: NarrationRuntimeEvent,
  context?: NarrationResolverContext,
) => NarrationSegment | Promise<NarrationSegment>;

export type CollectedNarration = {
  kind: "narration";
  order: number;
  event: NarrationRuntimeEvent;
  segment: NarrationSegment;
};

export type CollectedTimelineEvent = {
  kind: "event";
  order: number;
  event: NonNarrationRuntimeEvent;
};

export const COLLECTED_TIMELINE_ENTRY_KINDS = ["event", "narration"] as const;

export type CollectedTimelineEntry = CollectedTimelineEvent | CollectedNarration;

export type CollectedTimeline = {
  entries: CollectedTimelineEntry[];
  narrations: NarrationSegment[];
};

export type GenerationProgressPhase =
  | "loading-config"
  | "loading-tour"
  | "preparing-output"
  | "launching-browser"
  | "collecting-timeline"
  | "running-flow"
  | "runtime-event"
  | "resolving-narration"
  | "recording-replay"
  | "muxing-video"
  | "writing-artifacts"
  | "capturing-debug"
  | "completed";

export type GenerationProgressEvent = {
  phase: GenerationProgressPhase;
  message: string;
  runtimeEvent?: TourRuntimeEvent;
};

export type GenerationProgressReporter = (event: GenerationProgressEvent) => void;
