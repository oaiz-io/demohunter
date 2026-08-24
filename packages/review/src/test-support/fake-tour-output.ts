import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createPortableArtifactDescriptor } from "@demohunter/manifest";

export type FakeTourOutput = {
  videoPath: string;
  captionsSrtPath: string;
  captionsVttPath: string;
  chaptersPath: string;
  outputDir: string;
};

export type FakeTourOutputInput = {
  outputDir: string;
  tourId: string;
  tourTitle: string;
  narrationLines: readonly string[];
  chapterTitles: readonly string[];
  durationMs?: number;
};

const SEGMENT_MS = 4_000;

/**
 * Writes the artifact set `generateTour` would leave behind.
 *
 * Review generation is tested end to end without launching a browser or ffmpeg,
 * so the fake has to produce a real, schema-valid manifest and real caption
 * files: the artifact checks re-read all of them.
 */
export async function writeFakeTourOutput(input: FakeTourOutputInput): Promise<FakeTourOutput> {
  const outputDir = input.outputDir;
  const durationMs = input.durationMs ?? input.narrationLines.length * SEGMENT_MS;
  const narrations = input.narrationLines.map((text, index) => ({
    cacheKey: `cache-${index}`,
    text,
    startMs: index * SEGMENT_MS,
    endMs: index * SEGMENT_MS + SEGMENT_MS,
    durationMs: SEGMENT_MS,
  }));

  await mkdir(path.join(outputDir, "audio"), { recursive: true });

  const audioPaths = await Promise.all(
    narrations.map(async (narration) => {
      const audioPath = path.join(outputDir, "audio", `${narration.cacheKey}.mp3`);
      await writeFile(audioPath, `audio for ${narration.text}\n`, "utf8");
      return { audioPath, narration };
    }),
  );

  const videoPath = path.join(outputDir, "video.mp4");
  const posterPath = path.join(outputDir, "poster.jpg");
  const captionsSrtPath = path.join(outputDir, "captions.srt");
  const captionsVttPath = path.join(outputDir, "captions.vtt");
  const chaptersPath = path.join(outputDir, "chapters.json");
  const manifestPath = path.join(outputDir, "manifest.json");
  const chapters = input.chapterTitles.map((title, index) => ({
    title,
    startMs: index * SEGMENT_MS,
  }));

  await writeFile(videoPath, `fake mp4 for ${input.tourId}\n`, "utf8");
  await writeFile(posterPath, "fake jpeg\n", "utf8");
  await writeFile(captionsSrtPath, toSrt(narrations), "utf8");
  await writeFile(captionsVttPath, toVtt(narrations), "utf8");
  await writeFile(chaptersPath, `${JSON.stringify(chapters, null, 2)}\n`, "utf8");

  const describe = (filePath: string, mediaType: string) =>
    createPortableArtifactDescriptor({ outputDir, filePath, mediaType });

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        manifestVersion: 1,
        tour: { id: input.tourId, title: input.tourTitle },
        playback: { durationMs },
        artifacts: {
          videos: { mp4: await describe(videoPath, "video/mp4") },
          poster: { ...(await describe(posterPath, "image/jpeg")), captureTimestampMs: 0 },
          captions: {
            srt: await describe(captionsSrtPath, "text/plain"),
            vtt: await describe(captionsVttPath, "text/vtt"),
          },
          chapters: await describe(chaptersPath, "application/json"),
          audio: await Promise.all(
            audioPaths.map(async ({ audioPath, narration }) => ({
              ...(await describe(audioPath, "audio/mpeg")),
              cacheKey: narration.cacheKey,
              durationMs: narration.durationMs,
            })),
          ),
        },
        timeline: { chapters, narrations },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { videoPath, captionsSrtPath, captionsVttPath, chaptersPath, outputDir };
}

function toVtt(narrations: ReadonlyArray<{ text: string; startMs: number; endMs: number }>): string {
  return `WEBVTT\n\n${narrations
    .map(
      (narration, index) =>
        `${index + 1}\n${timecode(narration.startMs, ".")} --> ${timecode(narration.endMs, ".")}\n${narration.text}\n`,
    )
    .join("\n")}`;
}

function toSrt(narrations: ReadonlyArray<{ text: string; startMs: number; endMs: number }>): string {
  return narrations
    .map(
      (narration, index) =>
        `${index + 1}\n${timecode(narration.startMs, ",")} --> ${timecode(narration.endMs, ",")}\n${narration.text}\n`,
    )
    .join("\n");
}

function timecode(totalMs: number, millisecondSeparator: "." | ","): string {
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;

  return (
    `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`
    + `${millisecondSeparator}${pad(milliseconds, 3)}`
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
