import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  musicGain,
  narrationStart,
  outputToSource,
  sceneAt,
  sourceToOutput,
  totalDuration,
  validateBundle,
  voiceSpans,
  type ReplayBundle,
} from "./model.js";
import { describeChanges, loadBundle } from "./storage.js";
import { fixture, projectFixture } from "./test-support.js";

function withScenes(): ReplayBundle {
  const bundle = fixture();
  bundle.edits.clips.unshift({
    id: "intro",
    kind: "scene",
    src: "scenes/intro.html",
    durationMs: 2000,
  });
  bundle.edits.clips.push({
    id: "outro",
    kind: "scene",
    src: "scenes/outro.html",
    durationMs: 1500,
  });
  return bundle;
}

describe("HTML scenes in the timeline", () => {
  test("scenes add output time while the recording holds its frame", () => {
    const { edits } = withScenes();
    expect(totalDuration(edits)).toBe(2000 + 2500 + 1500);
    // Intro holds the first recording frame; outro holds the last.
    expect(outputToSource(edits, 0)).toBe(0);
    expect(outputToSource(edits, 1999)).toBe(0);
    expect(outputToSource(edits, 2500)).toBe(500);
    expect(outputToSource(edits, 5000)).toBe(4000);
    expect(outputToSource(edits, 6000)).toBe(4000);
    expect(sourceToOutput(edits, 500)).toBe(2500);
  });
  test("sceneAt reports the scene and its local time", () => {
    const { edits } = withScenes();
    expect(sceneAt(edits, 500)).toMatchObject({
      clip: { id: "intro" },
      startMs: 0,
      localMs: 500,
    });
    expect(sceneAt(edits, 2500)).toBeUndefined();
    expect(sceneAt(edits, 4600)).toMatchObject({
      clip: { id: "outro" },
      localMs: 100,
    });
    // The final frame still belongs to the last scene.
    expect(sceneAt(edits, 6000)).toMatchObject({ localMs: 1500 });
  });
  test("narration can anchor to a scene clip", () => {
    const bundle = withScenes();
    bundle.narration.segments.push({
      id: "hello",
      clipId: "outro",
      offsetMs: 200,
      text: "Bye.",
    });
    expect(narrationStart(bundle.edits, bundle.narration.segments[1]!)).toBe(
      4700,
    );
    expect(narrationStart(bundle.edits, bundle.narration.segments[0]!)).toBe(
      3100,
    );
  });
  test("scene, overlay and audio paths must stay inside the project", () => {
    const bundle = withScenes();
    const raw = JSON.parse(JSON.stringify(bundle));
    raw.edits.clips[0].src = "../secret.html";
    expect(() => validateBundle(raw)).toThrow();
    const audio = JSON.parse(JSON.stringify(bundle));
    audio.edits.audio = {
      music: [
        { id: "m", src: "audio/a.wav" },
        { id: "m", src: "audio/b.wav" },
      ],
    };
    expect(() => validateBundle(audio)).toThrow(/Duplicate id in music/);
    const overlay = JSON.parse(JSON.stringify(bundle));
    overlay.edits.overlays = [
      { id: "o", src: "scenes/o.html", startMs: 500, endMs: 400 },
    ];
    expect(() => validateBundle(overlay)).toThrow();
  });
});

describe("music envelope", () => {
  const bed = {
    id: "m",
    src: "audio/m.wav",
    startMs: 0,
    offsetMs: 0,
    volume: 0.4,
    fadeInMs: 1000,
    fadeOutMs: 1000,
    duck: 0.25,
  };
  test("fades in and out and is silent outside its range", () => {
    expect(musicGain(bed, 0, 10_000, [])).toBe(0);
    expect(musicGain(bed, 500, 10_000, [])).toBeCloseTo(0.2, 5);
    expect(musicGain(bed, 5000, 10_000, [])).toBeCloseTo(0.4, 5);
    expect(musicGain(bed, 9500, 10_000, [])).toBeCloseTo(0.2, 5);
    expect(musicGain({ ...bed, startMs: 2000 }, 1000, 10_000, [])).toBe(0);
    expect(musicGain({ ...bed, endMs: 6000 }, 7000, 10_000, [])).toBe(0);
  });
  test("ducks under narration with short ramps", () => {
    const voice: [number, number][] = [[4000, 6000]];
    expect(musicGain(bed, 5000, 10_000, voice)).toBeCloseTo(0.1, 5);
    expect(musicGain(bed, 3000, 10_000, voice)).toBeCloseTo(0.4, 5);
    const attack = musicGain(bed, 3910, 10_000, voice);
    expect(attack).toBeLessThan(0.4);
    expect(attack).toBeGreaterThan(0.1);
    expect(musicGain(bed, 7000, 10_000, voice)).toBeCloseTo(0.4, 5);
  });
  test("voice spans come only from current narration audio", () => {
    const bundle = fixture();
    expect(voiceSpans(bundle)).toEqual([]);
  });
});

describe("scene files are project content", () => {
  test("changing a scene page changes the revision and is described", async () => {
    const { root, dir } = await projectFixture();
    try {
      const first = await loadBundle(dir);
      await mkdir(path.join(dir, "scenes"));
      await writeFile(path.join(dir, "scenes/intro.html"), "<p>One</p>");
      const second = await loadBundle(dir);
      expect(second.revision).not.toBe(first.revision);
      expect(second.assetsRevision).not.toBe(first.assetsRevision);
      await writeFile(path.join(dir, "scenes/intro.html"), "<p>Two</p>");
      const third = await loadBundle(dir);
      expect(third.assetsRevision).not.toBe(second.assetsRevision);
      expect(describeChanges(second, third).map((c) => c.kind)).toContain(
        "scene",
      );
      const withMusic = structuredClone(third);
      withMusic.edits.audio = {
        music: [
          {
            id: "bed",
            src: "audio/bed.wav",
            startMs: 0,
            offsetMs: 0,
            volume: 0.3,
            fadeInMs: 800,
            fadeOutMs: 1500,
            duck: 0.35,
          },
        ],
        sfx: [],
      };
      expect(describeChanges(third, withMusic)).toContainEqual(
        expect.objectContaining({ kind: "music", label: "Music added" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("lift and overlay backdrop", () => {
  test("overlay backdrop is validated and defaulted", () => {
    const bundle = fixture();
    const raw = JSON.parse(JSON.stringify(bundle));
    raw.edits.overlays = [
      {
        id: "o",
        src: "scenes/o.html",
        startMs: 0,
        endMs: 1000,
        backdrop: { blur: 12 },
      },
    ];
    expect(validateBundle(raw).edits.overlays?.[0]?.backdrop).toEqual({
      blur: 12,
      dim: 0,
      easeMs: 450,
    });
    raw.edits.overlays[0].backdrop = { blur: 80 };
    expect(() => validateBundle(raw)).toThrow();
  });
  test("lift names and targets are checked before rendering", async () => {
    const { liftElement } = await import("./lift.js");
    await expect(
      liftElement("/nowhere", { ref: "a", atMs: 0, name: "Bad Name" }),
    ).rejects.toThrow(/Lift name/);
    await expect(
      liftElement("/nowhere", { atMs: 0, name: "card" }),
    ).rejects.toThrow(/exactly one/);
  });
});
