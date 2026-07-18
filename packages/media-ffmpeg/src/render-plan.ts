export type TimedAudioClip = {
  inputPath: string;
  startMs: number;
};

export type VideoTransform =
  | {
      kind: "scale-pad";
      width: number;
      height: number;
      color?: string;
    }
  | {
      kind: "gif";
      durationMs: number;
      fps?: number;
      width?: number;
      maxColors?: number;
    };

export type AudioTransform = {
  kind: "narration";
  clips: TimedAudioClip[];
};

export type MediaContainer = "mp4" | "webm" | "gif";

export type MediaRenderPlan = {
  inputVideoPath: string;
  outputPath: string;
  container: MediaContainer;
  video: VideoTransform[];
  audio: AudioTransform[];
  videoCodec?: "copy" | "h264" | "vp9";
  audioCodec?: "aac" | "opus" | "none";
};

export type RenderedMedia = {
  outputPath: string;
  container: MediaContainer;
};

export interface MediaRenderer {
  render(plan: MediaRenderPlan, signal?: AbortSignal): Promise<RenderedMedia>;
}

export type MediaProbe = {
  width?: number;
  height?: number;
  durationMs: number;
  videoCodec?: string;
  pixelFormat?: string;
  fps?: number;
};
