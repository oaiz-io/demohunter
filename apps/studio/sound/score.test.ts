import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeWav, decodeWav, gainToDb, measureLoudness, truePeakDb, type Stereo } from "./dsp.js";
import { analyze } from "./analyze.js";
import { parseKey } from "./theory.js";
import { SFX_KINDS, renderKit, renderScore, renderSfx, writeWav } from "./score.js";

const asStereo = (pcm: Float32Array[]): Stereo => [pcm[0]!, pcm[1]!];

function samplePeak(pcm: Float32Array[]): number {
  let p = 0;
  for (const ch of pcm) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]!));
  return p;
}

function hasNaN(pcm: Float32Array[]): boolean {
  for (const ch of pcm) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i]!)) return true;
  return false;
}

function ffmpegLoudness(file: string): { integrated: number; truePeak: number; lra: number } | null {
  const run = spawnSync("ffmpeg", ["-nostats", "-hide_banner", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], {
    encoding: "utf8",
  });
  if (run.error) return null;
  const summary = run.stderr.slice(run.stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => Number(re.exec(summary)?.[1]);
  return {
    integrated: num(/I:\s+(-?[\d.]+) LUFS/),
    lra: num(/LRA:\s+(-?[\d.]+) LU/),
    truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/),
  };
}

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"]).error;

describe("renderScore", () => {
  const bright = renderScore({ durationMs: 12000, seed: 3, mood: "bright" });

  test("is deterministic for a seed and varies across seeds", () => {
    const again = renderScore({ durationMs: 12000, seed: 3, mood: "bright" });
    expect(Buffer.from(encodeWav(again)).equals(Buffer.from(encodeWav(bright)))).toBe(true);
    const other = renderScore({ durationMs: 12000, seed: 4, mood: "bright" });
    expect(Buffer.from(encodeWav(other)).equals(Buffer.from(encodeWav(bright)))).toBe(false);
  });

  test("has the requested duration, sample rate and stereo layout", () => {
    expect(bright.sampleRate).toBe(48000);
    expect(bright.pcm).toHaveLength(2);
    expect(bright.pcm[0]!.length).toBe(12 * 48000);
    expect(bright.pcm[1]!.length).toBe(12 * 48000);
  });

  test("contains no NaN, starts and ends silent, peaks below −1 dBFS", () => {
    expect(hasNaN(bright.pcm)).toBe(false);
    expect(gainToDb(samplePeak(bright.pcm))).toBeLessThanOrEqual(-1);
    expect(truePeakDb(asStereo(bright.pcm))).toBeLessThanOrEqual(-1.5);
    expect(bright.pcm[0]![0]).toBe(0);
    expect(bright.pcm[1]![bright.pcm[1]!.length - 1]).toBe(0);
  });

  test("beats and bars follow the tempo", () => {
    const fixed = renderScore({ durationMs: 10000, seed: 1, mood: "calm", bpm: 100 });
    expect(fixed.bpm).toBe(100);
    const gaps = fixed.beats.slice(1).map((b, i) => b - fixed.beats[i]!);
    for (const g of gaps) expect(Math.abs(g - 600)).toBeLessThan(0.01);
    expect(fixed.bars[1]! - fixed.bars[0]!).toBeCloseTo(2400, 2);
    // fitted tempo: beats still match the reported bpm exactly
    const beatMs = 60000 / bright.bpm;
    bright.beats.slice(1).forEach((b, i) => expect(Math.abs(b - bright.beats[i]! - beatMs)).toBeLessThan(0.01));
  });

  test("fits the tempo so the resolution lands on endingMs", () => {
    const s = renderScore({ durationMs: 20000, seed: 9, mood: "cinematic", endingMs: 16500 });
    expect(s.resolveMs).toBe(16500);
    expect(s.strongCues.find((c) => c.kind === "resolve")?.timeMs).toBe(16500);
    expect(s.bars.some((b) => Math.abs(b - 16500) < 1)).toBe(true);
    expect(s.key).toMatch(/minor$/);
  });

  test("honours an explicit key and reports the arrangement", () => {
    const s = renderScore({ durationMs: 8000, seed: 2, mood: "calm", key: "Eb" });
    expect(s.key).toBe("Eb major");
    expect(s.chords.at(-1)!.notes[0]).toBe("Eb");
    expect(s.strongCues[0]).toEqual({ timeMs: 0, kind: "start" });
    expect(s.strongCues.at(-1)).toEqual({ timeMs: 8000, kind: "end" });
  });

  test("keeps the highs controlled and the low-mids warm", () => {
    const a = analyze(asStereo(bright.pcm), bright.sampleRate);
    expect(a.above8kDb).toBeLessThan(-15);
    expect(a.bandsDb["bass 60-250"]!).toBeGreaterThan(a.bandsDb["presence 2.5-6k"]!);
  });

  test.skipIf(!hasFfmpeg)("is normalised to about −16 LUFS (ffmpeg ebur128)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dh-score-"));
    try {
      const calm = renderScore({ durationMs: 16000, seed: 5, mood: "calm" });
      const file = path.join(dir, "calm.wav");
      await writeWav(file, calm);
      const m = ffmpegLoudness(file)!;
      expect(m.integrated).toBeGreaterThanOrEqual(-18);
      expect(m.integrated).toBeLessThanOrEqual(-14);
      expect(m.truePeak).toBeLessThanOrEqual(-1.5);
      // the internal meter agrees with ffmpeg
      expect(Math.abs(measureLoudness(asStereo(calm.pcm), calm.sampleRate).integrated - m.integrated)).toBeLessThan(0.5);
      // round trip through the 24-bit file
      const decoded = decodeWav(new Uint8Array(await readFile(file)));
      expect(decoded.sampleRate).toBe(48000);
      expect(decoded.pcm[0]!.length).toBe(calm.pcm[0]!.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("renderSfx", () => {
  for (const kind of SFX_KINDS) {
    test(`${kind} renders short, soft and non-silent`, () => {
      const s = renderSfx(kind, { seed: 7, key: "F" });
      expect(s.sampleRate).toBe(48000);
      expect(s.pcm).toHaveLength(2);
      expect(hasNaN(s.pcm)).toBe(false);
      const len = s.pcm[0]!.length / s.sampleRate;
      expect(len).toBeLessThanOrEqual(3);
      const peak = gainToDb(samplePeak(s.pcm));
      expect(peak).toBeGreaterThan(-40);
      expect(truePeakDb(asStereo(s.pcm))).toBeLessThanOrEqual(-2.9);
      expect(s.pcm[0]![0]).toBe(0);
      expect(s.pcm[0]![s.pcm[0]!.length - 1]).toBe(0);
      // no harsh top end
      expect(analyze(asStereo(s.pcm), s.sampleRate).above8kDb).toBeLessThan(-20);
      // gentle attack: the first millisecond stays well below the peak
      const p = samplePeak(s.pcm);
      let early = 0;
      for (let i = 0; i < 48; i++) early = Math.max(early, Math.abs(s.pcm[0]![i]!), Math.abs(s.pcm[1]![i]!));
      expect(early).toBeLessThan(p * 0.6);
    });
  }

  test("is deterministic and follows durationMs", () => {
    const a = renderSfx("riser", { seed: 1, key: "A minor", durationMs: 1000 });
    const b = renderSfx("riser", { seed: 1, key: "A minor", durationMs: 1000 });
    expect(Buffer.from(encodeWav(a)).equals(Buffer.from(encodeWav(b)))).toBe(true);
    expect(a.pcm[0]!.length / 48000).toBeLessThan(1.6);
  });

  test("small repeated sounds sit below big moments", () => {
    const level = (k: (typeof SFX_KINDS)[number]) => truePeakDb(asStereo(renderSfx(k, { seed: 1 }).pcm));
    expect(level("tick")).toBeLessThan(level("whoosh"));
    expect(level("click")).toBeLessThan(level("impact"));
  });
});

describe("renderKit", () => {
  test("writes music, every sfx and cues.json", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dh-kit-"));
    try {
      const manifest = await renderKit(dir, { durationMs: 6000, mood: "calm", seed: 7, key: "D" });
      const cues = JSON.parse(await readFile(path.join(dir, "cues.json"), "utf8"));
      expect(cues.key).toBe("D major");
      expect(cues.bpm).toBe(manifest.bpm);
      expect(cues.sfx).toEqual([...SFX_KINDS]);
      expect(cues.beats.length).toBeGreaterThan(4);
      const files = await readdir(path.join(dir, "sfx"));
      expect(files.sort()).toEqual(SFX_KINDS.map((k) => `${k}.wav`).sort());
      const music = decodeWav(new Uint8Array(await readFile(path.join(dir, "music.wav"))));
      expect(music.pcm[0]!.length).toBe(6 * 48000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("parseKey accepts common spellings", () => {
  expect(parseKey("F#m").name).toBe("F# minor");
  expect(parseKey("bb major").name).toBe("Bb major");
  expect(parseKey("A minor")).toMatchObject({ tonic: 9, minor: true });
  expect(() => parseKey("H")).toThrow();
});
