import { describe, expect, test } from "bun:test";

import { probeReviewMedia } from "./probe-media.js";

const FFPROBE_OUTPUT = JSON.stringify({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1440, height: 900 },
    { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
  ],
  format: { duration: "125.480000" },
});

describe("probeReviewMedia", () => {
  test("reports both streams and the duration in milliseconds", async () => {
    const probe = await probeReviewMedia("/tmp/video.mp4", { runCommand: async () => FFPROBE_OUTPUT });

    expect(probe.video).toEqual({ codec: "h264", width: 1440, height: 900 });
    expect(probe.audio).toEqual({ codec: "aac", channels: 2, sampleRate: 48_000 });
    expect(probe.durationMs).toBe(125_480);
  });

  test("asks ffprobe for streams and format as JSON, argv only", async () => {
    let captured: { command: string; args: string[] } | undefined;

    await probeReviewMedia("/tmp/my video.mp4", {
      runCommand: async (command, args) => {
        captured = { command, args };
        return FFPROBE_OUTPUT;
      },
    });

    expect(captured?.command).toBe("ffprobe");
    expect(captured?.args).toEqual([
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      "/tmp/my video.mp4",
    ]);
  });

  test("reports a missing audio stream rather than defaulting to one", async () => {
    const probe = await probeReviewMedia("/tmp/video.mp4", {
      runCommand: async () =>
        JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264" }], format: {} }),
    });

    expect(probe.audio).toBeUndefined();
    expect(probe.video).toEqual({ codec: "h264", width: 0, height: 0 });
    expect(probe.durationMs).toBe(0);
  });

  test("treats a non-numeric duration as zero instead of NaN", async () => {
    const probe = await probeReviewMedia("/tmp/video.mp4", {
      runCommand: async () => JSON.stringify({ streams: [], format: { duration: "N/A" } }),
    });

    expect(probe.durationMs).toBe(0);
  });

  test("honours an alternative ffprobe command", async () => {
    let seen = "";

    await probeReviewMedia("/tmp/video.mp4", {
      ffprobeCommand: "/opt/bin/ffprobe",
      runCommand: async (command) => {
        seen = command;
        return FFPROBE_OUTPUT;
      },
    });

    expect(seen).toBe("/opt/bin/ffprobe");
  });

  test("propagates a probe failure", async () => {
    await expect(
      probeReviewMedia("/tmp/video.mp4", {
        runCommand: async () => {
          throw new Error("ffprobe failed: no such file");
        },
      }),
    ).rejects.toThrow("no such file");
  });
});
