import { describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveNarrationSegment } from "../../packages/generator-playwright/src/narration/resolve-narration.js";
import type { NarrationProvider } from "../../packages/tts-core/src/contracts.js";
import { regenerateNarration } from "./narration.js";
import { loadBundle, writeJson } from "./storage.js";
import { audioIsCurrent, narrationRequestKey } from "./model.js";
import { projectFixture, wavBytes } from "./test-support.js";

describe("replay narration regeneration", () => {
  test("uses the real validated cache offline and regenerates corrupt entries", async () => {
    const { root, dir } = await projectFixture();
    let calls = 0;
    const provider: NarrationProvider = {
      async synthesize(request) {
        calls++;
        const {
          text: _text,
          instructions: _instructions,
          ...metadata
        } = request;
        return {
          request,
          metadata,
          output: { kind: "bytes", bytes: wavBytes() },
        };
      },
    };
    const resolve: typeof resolveNarrationSegment = (input) =>
      resolveNarrationSegment(input, { createProvider: () => provider });
    const cacheDir = path.join(root, "cache");
    try {
      await regenerateNarration(dir, { cacheDir, resolve, fit: true });
      const first = await loadBundle(dir);
      const segment = first.narration.segments[0]!;
      expect(audioIsCurrent(first.project, segment)).toBe(true);
      expect(segment.audio!.durationMs).toBe(250);
      expect((await readFile(path.join(dir, segment.audio!.path))).length).toBe(
        wavBytes().length,
      );
      const offline: typeof resolveNarrationSegment = (input) =>
        resolveNarrationSegment(input, {
          createProvider: () => ({
            async synthesize() {
              throw new Error("offline");
            },
          }),
        });
      await regenerateNarration(dir, { cacheDir, resolve: offline });
      expect(calls).toBe(1);
      // Corrupt the provider cache; the underlying cache implementation must recover.
      const cacheFiles = await import("node:fs/promises").then((fs) =>
        fs.readdir(cacheDir, { recursive: true }),
      );
      const matching = cacheFiles.find((name) => name.endsWith(".wav"));
      expect(matching).toBeDefined();
      await writeFile(path.join(cacheDir, String(matching)), "corrupt");
      await regenerateNarration(dir, { cacheDir, resolve });
      expect(calls).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
  test("does not overwrite an agent's script changes made during synthesis", async () => {
    const { root, dir } = await projectFixture();
    const audio = path.join(root, "voice.wav");
    await writeFile(audio, wavBytes());
    try {
      const resolve: typeof resolveNarrationSegment = async () => {
        const changed = await loadBundle(dir);
        changed.narration.segments[0]!.text =
          "An agent changed this while audio was generating.";
        await writeJson(path.join(dir, "narration.json"), changed.narration);
        return {
          audioPath: audio,
          cacheKey: "fake-key",
          durationMs: 250,
          text: "The same amount.",
        };
      };
      const result = await regenerateNarration(dir, { resolve });
      expect(result).toEqual({ generated: 0, skipped: 1 });
      const latest = await loadBundle(dir);
      expect(latest.narration.segments[0]!.text).toContain("An agent changed");
      expect(latest.narration.segments[0]!.audio).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("selective audio generation leaves other segments and timing intact", async () => {
    const { root, dir } = await projectFixture();
    const audio = path.join(root, "voice.wav");
    await writeFile(audio, wavBytes());
    try {
      const initial = await loadBundle(dir);
      const other = {
        id: "other",
        clipId: "a",
        offsetMs: 0,
        text: "Untouched narration.",
        audio: {
          path: "audio/existing.wav",
          durationMs: 8000,
          cacheKey: "existing",
          requestKey: "",
        },
      };
      other.audio.requestKey = narrationRequestKey(initial.project, other);
      initial.narration.segments.push(other);
      await writeJson(path.join(dir, "narration.json"), initial.narration);
      let calls = 0;
      const result = await regenerateNarration(dir, {
        segmentIds: ["n1"],
        fit: true,
        resolve: async () => {
          calls++;
          return {
            audioPath: audio,
            cacheKey: "selective",
            durationMs: 250,
            text: "The same amount.",
          };
        },
      });
      expect(result.generated).toBe(1);
      expect(calls).toBe(1);
      const latest = await loadBundle(dir);
      expect(latest.edits.clips[0]!.holdMs).toBe(0);
      expect(latest.narration.segments[1]).toEqual(other);
      await expect(
        regenerateNarration(dir, { segmentIds: ["missing"] }),
      ).rejects.toThrow("Unknown narration");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
