/**
 * Procedural, license-free music bed + matching SFX kit for DemoHunter Studio.
 *
 * Everything is synthesised in code from a seed: no samples, no downloads.
 * Music and effects share the key, the instrument voices and the reverb
 * space, so the kit sounds like one piece.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Biquad,
  OnePole,
  Rng,
  SPACES,
  Svf,
  dbToGain,
  filterStereo,
  limit,
  measureLoudness,
  midiToFreq,
  mixInto,
  pingPong,
  reverb,
  scale,
  softClip,
  stereo,
  streamSeed,
  truePeakDb,
  writeWav as writeWavFile,
  type PcmAudio,
  type SpaceName,
  type Stereo,
} from "./dsp.js";
import { chordTones, keyFrom, parseKey, pentatonic, placeInRange, progression, voiceChord, type Chord, type Key } from "./theory.js";
import { bassNote, bellNote, boom, clap, epNote, hat, kick, noiseSwell, padNote, shaker, tom } from "./voices.js";
import { SFX_KINDS, renderSfxWith, sfxAnchorMs, type SfxKind } from "./sfx.js";

export type Mood = "calm" | "bright" | "cinematic";
export { SFX_KINDS, type SfxKind };

export interface ScoreOptions {
  durationMs: number;
  seed?: number;
  mood?: Mood;
  /** Fixed tempo. When omitted the tempo is fitted so the resolution lands on a downbeat at `endingMs`. */
  bpm?: number;
  /** "D", "Eb", "F#m", "A minor" … Defaults to a mood-appropriate key chosen by seed. */
  key?: string;
  sampleRate?: 48000;
  /** Where the final tonic chord lands; it then rings out and fades by `durationMs`. */
  endingMs?: number;
  /** Integrated loudness target for the music alone. Default −16 LUFS. */
  targetLufs?: number;
}

export interface StrongCue {
  timeMs: number;
  /** start | section | lift | drop | breakdown | cadence | resolve | end */
  kind: string;
}

export interface ScoreResult {
  pcm: Float32Array[];
  sampleRate: number;
  bpm: number;
  key: string;
  beats: number[];
  bars: number[];
  strongCues: StrongCue[];
  /** Time of the final tonic downbeat. */
  resolveMs: number;
  mood: Mood;
  seed: number;
  /** Arrangement: energy level 0 = intro, 1 = breakdown, 2..4 = rising. */
  sections: { startMs: number; endMs: number; level: number }[];
  /** Harmony timeline (chord symbols are scale degrees, e.g. "vi:m7"). */
  chords: { startMs: number; endMs: number; symbol: string; notes: string[] }[];
  /** Measured after mastering. */
  loudness: { integratedLufs: number; truePeakDb: number; lra: number };
}

interface MoodPreset {
  bpm: [number, number];
  keys: [string, ...string[]];
  space: SpaceName;
  progs: [string, string][];
  cadence: [string, string];
  resolve: string;
}

const MOODS: Record<Mood, MoodPreset> = {
  calm: {
    bpm: [96, 106],
    keys: ["D", "Eb", "F", "C", "E"],
    space: "plate",
    progs: [
      ["I:add9 vi:m7 IV:maj7 V:sus4", "IV:maj7 I:add9 vi:m7 V"],
      ["I:maj7 iii:m7 vi:m9 IV:maj9", "IV:maj9 V:sus4 iii:m7 vi:m7"],
      ["vi:m9 IV:maj7 I:add9 V:sus4", "IV:maj7 V I:add9 vi:m7"],
      ["I:add9 IV:maj9 vi:m7 IV:six9", "ii:m7 V:sus4 I:maj7 vi:m7"],
    ],
    cadence: ["V:sus4", "V"],
    resolve: "I:add9",
  },
  bright: {
    bpm: [116, 124],
    keys: ["E", "F", "G", "D", "A"],
    space: "room",
    progs: [
      ["I:add9 V vi:m7 IV:add9", "IV:maj7 V iii:m7 vi:m7"],
      ["vi:m7 IV:add9 I:add9 V", "IV:add9 I V vi:m7"],
      ["I:add9 iii:m7 IV:maj7 V:sus4", "vi:m7 IV:add9 I V"],
      ["IV:maj7 V iii:m7 vi:m7", "I:add9 V vi:m7 IV:add9"],
    ],
    cadence: ["V:sus4", "V"],
    resolve: "I:add9",
  },
  cinematic: {
    bpm: [72, 82],
    keys: ["Dm", "Cm", "Em", "Am", "F#m"],
    space: "hall",
    progs: [
      ["i:madd9 VI:maj7 III:add9 VII", "VI:add9 VII i:madd9 i:m7"],
      ["i:madd9 VII VI:maj7 VII:sus4", "iv:m7 VI:add9 i:madd9 VII"],
      ["VI:maj7 VII i:madd9 i:m7", "iv:m9 VI:maj7 III VII"],
      ["i:m9 iv:m7 VI:maj7 VII:sus4", "VI:add9 III:add9 VII i:madd9"],
    ],
    cadence: ["VII:sus4", "VII"],
    resolve: "i:madd9",
  },
};

interface Phrase {
  startBar: number;
  bars: number;
  /** 0 = intro, 1 = breakdown, 2..4 = rising energy. */
  level: number;
  prog: Chord[];
}

interface ChordSpan {
  start: number;
  end: number;
  chord: Chord;
  level: number;
  bar: number;
}

const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
/** Flat-side keys (by tonic pitch class) spell accidentals as flats. */
function noteNames(key: Key): string[] {
  const flatMajor = [5, 10, 3, 8, 1, 6];
  const flatMinor = [2, 7, 0, 5, 10, 3];
  return (key.minor ? flatMinor : flatMajor).includes(key.tonic) ? FLATS : SHARPS;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function moodOf(m: string | undefined): Mood {
  return m === "bright" || m === "cinematic" ? m : "calm";
}

/**
 * Tempo, bar count and resolution time. Without a fixed tempo the bpm is
 * fitted (within the mood's range) so the final tonic lands on a downbeat at
 * `endingMs`; very short cues fall back to landing on a beat.
 */
function planTime(opts: ScoreOptions, preset: MoodPreset, rng: Rng) {
  const durationS = opts.durationMs / 1000;
  const tailS = Math.min(clamp(durationS * 0.1, 2.5, 5), durationS * 0.45);
  const endingS = clamp(opts.endingMs !== undefined ? opts.endingMs / 1000 : durationS - tailS, 0.25, durationS);
  const result = (bpm: number, resolveS: number) => ({
    bpm,
    resolveS,
    durationS,
    bars: Math.max(1, Math.ceil(resolveS / (240 / bpm) - 1e-6)),
  });
  if (opts.bpm !== undefined) {
    const bpm = opts.bpm;
    const n = Math.floor(endingS / (240 / bpm) + 1e-6);
    if (n >= 1) return result(bpm, n * (240 / bpm));
    const beats = Math.max(1, Math.floor(endingS / (60 / bpm) + 1e-6));
    return result(bpm, Math.min(beats * (60 / bpm), durationS * 0.8));
  }
  const bpm0 = rng.range(preset.bpm[0], preset.bpm[1]);
  const lo = preset.bpm[0] * 0.9;
  const hi = preset.bpm[1] * 1.1;
  const n0 = Math.round((endingS * bpm0) / 240);
  let best: number | null = null;
  for (const n of [n0, n0 - 1, n0 + 1]) {
    if (n < 1) continue;
    const bpm = (240 * n) / endingS;
    if (bpm >= lo && bpm <= hi && (best === null || Math.abs(bpm - bpm0) < Math.abs(best - bpm0))) best = bpm;
  }
  if (best !== null) return result(Math.round(best * 1000) / 1000, endingS);
  const beats = Math.max(1, Math.round((endingS * bpm0) / 60));
  const bpm = (60 * beats) / endingS;
  if (bpm >= lo && bpm <= hi) return result(Math.round(bpm * 1000) / 1000, endingS);
  return result(Math.round(bpm0 * 1000) / 1000, endingS);
}

function planPhrases(n: number, preset: MoodPreset, key: Key, rng: Rng): Phrase[] {
  const [aSpec, bSpec] = rng.pick(preset.progs);
  const progA = progression(aSpec, key.minor);
  const progB = progression(bSpec, key.minor);
  const intro = n >= 12 ? 2 : n >= 5 ? 1 : 0;
  const phrases: Phrase[] = [];
  if (intro) phrases.push({ startBar: 0, bars: intro, level: 0, prog: progA });
  const lengths: number[] = [];
  let left = n - intro;
  while (left > 0) {
    if (left <= 6 && left > 4) {
      lengths.push(left);
      break;
    }
    const l = Math.min(4, left);
    lengths.push(l);
    left -= l;
  }
  const P = lengths.length;
  let bar = intro;
  lengths.forEach((len, i) => {
    let level: number;
    if (P === 1) level = 3;
    else if (i === 0) level = 2;
    else if (i === P - 1) level = 4;
    else if (P >= 5 && i === P - 2) level = 1;
    else if (i >= Math.ceil(P * 0.5)) level = 4;
    else level = 3;
    const prog = level >= 3 && i % 2 === 0 ? progB : level >= 4 ? progB : progA;
    phrases.push({ startBar: bar, bars: len, level, prog });
    bar += len;
  });
  return phrases;
}

/** Per-bar (or half-bar at the cadence) chord spans, with the resolution last. */
function chordSpans(phrases: Phrase[], n: number, barS: number, resolveS: number, preset: MoodPreset, key: Key): ChordSpan[] {
  const spans: ChordSpan[] = [];
  for (const ph of phrases) {
    for (let b = 0; b < ph.bars; b++) {
      const bar = ph.startBar + b;
      const start = bar * barS;
      const end = Math.min(start + barS, resolveS);
      if (end - start < 1e-6) continue;
      if (bar === n - 1 && n >= 2) {
        const [c1, c2] = preset.cadence.map((c) => progression(c, key.minor)[0]!);
        const mid = (start + end) / 2;
        spans.push({ start, end: mid, chord: c1!, level: ph.level, bar });
        spans.push({ start: mid, end, chord: c2!, level: ph.level, bar });
      } else {
        spans.push({ start, end, chord: ph.prog[b % ph.prog.length]!, level: ph.level, bar });
      }
    }
  }
  return spans;
}

/** Smooth per-sample automation from (time, value) breakpoints. */
function automation(frames: number, sr: number, points: [number, number][], smoothHz: number): Float32Array {
  const out = new Float32Array(frames);
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  let j = 0;
  const lp = new OnePole(sr, smoothHz, pts[0]?.[1] ?? 0);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    while (j + 1 < pts.length && pts[j + 1]![0] <= t) j++;
    const v = pts[j]?.[1] ?? 0;
    out[i] = lp.process(v);
  }
  return out;
}

/** Multiplicative side-chain pump from trigger times. */
function pumpCurve(frames: number, sr: number, triggers: number[], depth: number, recover: number): Float32Array {
  const g = new Float32Array(frames).fill(1);
  const attack = 0.006;
  for (const t0 of triggers) {
    const s = Math.round(t0 * sr);
    const e = Math.min(frames, s + Math.round(recover * 5 * sr));
    for (let i = Math.max(0, s); i < e; i++) {
      const t = (i - s) / sr;
      const a = t < attack ? Math.sin((t / attack) * Math.PI * 0.5) ** 2 : 1;
      const d = depth * a * Math.exp(-Math.max(0, t - attack) / recover);
      g[i] = Math.min(g[i]!, 1 - d);
    }
  }
  return g;
}

function applyCurve(buf: Stereo, curve: Float32Array): void {
  for (const ch of buf) for (let i = 0; i < ch.length; i++) ch[i]! *= curve[i]!;
}

function busEq(buf: Stereo, sr: number, hp: number, lp: number): void {
  if (hp > 0) filterStereo(buf, () => Biquad.make("highpass", sr, hp, 0.7));
  if (lp > 0) filterStereo(buf, () => Biquad.make("lowpass", sr, lp, 0.7));
}

interface MixSettings {
  pad: number;
  ep: number;
  bell: number;
  bass: number;
  drums: number;
  padCutoff: number;
  padHp: number;
  epLp: number;
  bassLp: number;
  sendPad: number;
  sendEp: number;
  sendBell: number;
  sendDrums: number;
  delayMix: number;
  reverbReturn: number;
  highShelfDb: number;
}

const MIX: Record<Mood, MixSettings> = {
  calm: {
    pad: 0.6, ep: 0.6, bell: 0.48, bass: 0.44, drums: 0.22,
    padCutoff: 2000, padHp: 120, epLp: 6500, bassLp: 240,
    sendPad: 0.35, sendEp: 0.42, sendBell: 0.55, sendDrums: 0.25, delayMix: 0.22, reverbReturn: 0.9, highShelfDb: -1,
  },
  bright: {
    pad: 0.58, ep: 0.66, bell: 0.4, bass: 0.48, drums: 0.72,
    padCutoff: 4200, padHp: 200, epLp: 8000, bassLp: 360,
    sendPad: 0.3, sendEp: 0.35, sendBell: 0.45, sendDrums: 0.12, delayMix: 0.2, reverbReturn: 0.8, highShelfDb: 2,
  },
  cinematic: {
    pad: 0.66, ep: 0.42, bell: 0.42, bass: 0.48, drums: 0.6,
    padCutoff: 1300, padHp: 90, epLp: 5000, bassLp: 300,
    sendPad: 0.45, sendEp: 0.5, sendBell: 0.6, sendDrums: 0.35, delayMix: 0.18, reverbReturn: 1.0, highShelfDb: -1.5,
  },
};

const ARP_PATTERNS: Record<Mood, number[][]> = {
  // 8 steps per bar (8ths)
  calm: [
    [0, 2, 1, 3, 2, 1, 3, 2],
    [0, -1, 2, 1, -1, 3, 2, -1],
    [0, 1, 2, 3, 4, 3, 2, 1],
    [0, 2, 4, 2, 1, 3, 5, 3],
  ],
  // 16 steps per bar (16ths)
  bright: [
    [0, -1, -1, 2, -1, -1, 1, -1, 3, -1, -1, 2, -1, -1, 4, -1],
    [0, -1, 2, -1, 1, -1, 3, -1, 2, -1, 4, -1, 1, -1, 3, -1],
    [0, -1, 3, -1, -1, 2, -1, 4, -1, 1, -1, 3, -1, -1, 2, -1],
  ],
  // 8 steps per bar
  cinematic: [
    [0, 2, 3, 2, 0, 2, 3, 2],
    [0, 1, 3, 1, 2, 1, 3, 1],
    [0, 3, 2, 3, 1, 3, 2, 3],
  ],
};

const MELODY_RHYTHMS = [
  [0, 3, 6, 8],
  [0, 2, 3, 6, 10],
  [2, 4, 6, 9, 12],
  [0, 4, 7, 8, 11],
  [0, 3, 4, 8, 12],
];

export function renderScore(options: ScoreOptions): ScoreResult {
  if (!Number.isFinite(options.durationMs) || options.durationMs < 1000 || options.durationMs > 20 * 60000) {
    throw new Error("durationMs must be between 1000 and 1200000");
  }
  if (options.bpm !== undefined && !(options.bpm >= 40 && options.bpm <= 220)) throw new Error("bpm must be between 40 and 220");
  if (options.sampleRate !== undefined && options.sampleRate !== 48000) throw new Error("only 48 kHz is supported");
  const sr = options.sampleRate ?? 48000;
  const seed = (options.seed ?? 1) >>> 0;
  const mood = moodOf(options.mood);
  const preset = MOODS[mood];
  const mix = MIX[mood];
  const rng = (label: string) => new Rng(streamSeed(seed, `${mood}:${label}`));
  const plan = rng("plan");
  const key = options.key ? parseKey(options.key) : parseKey(plan.pick(preset.keys));
  const time = planTime(options, preset, plan);
  const { bpm, bars: n, resolveS, durationS } = time;
  const beatS = 60 / bpm;
  const barS = beatS * 4;
  const frames = Math.round(durationS * sr);
  const phrases = planPhrases(n, preset, key, plan);
  const spans = chordSpans(phrases, n, barS, resolveS, preset, key);
  const resolveChord = progression(preset.resolve, key.minor)[0]!;
  const tail = durationS - resolveS;
  const levelAt = (bar: number) => phrases.find((p) => bar >= p.startBar && bar < p.startBar + p.bars)?.level ?? 4;

  // -------------------------------------------------------------------------
  // Cues
  const beats: number[] = [];
  for (let b = 0; b * beatS <= durationS + 1e-9; b++) beats.push(Math.round(b * beatS * 1000 * 1000) / 1000);
  const barsMs: number[] = [];
  for (let b = 0; b * barS <= durationS + 1e-9; b++) barsMs.push(Math.round(b * barS * 1000 * 1000) / 1000);
  const cues: StrongCue[] = [{ timeMs: 0, kind: "start" }];
  let prevLevel = -1;
  let dropped = false;
  for (const ph of phrases) {
    const t = Math.round(ph.startBar * barS * 1000);
    if (ph.startBar > 0) {
      let kind = "section";
      if (ph.level === 1) kind = "breakdown";
      else if (mood === "bright" && ph.level >= 3 && !dropped) kind = "drop";
      else if (ph.level > prevLevel) kind = "lift";
      cues.push({ timeMs: t, kind });
    }
    if (mood === "bright" && ph.level >= 3) dropped = true;
    prevLevel = ph.level;
  }
  if (n >= 2) cues.push({ timeMs: Math.round((n - 1) * barS * 1000), kind: "cadence" });
  cues.push({ timeMs: Math.round(resolveS * 1000), kind: "resolve" });
  cues.push({ timeMs: Math.round(durationS * 1000), kind: "end" });

  // -------------------------------------------------------------------------
  // Pad: voice-led chords, common tones tied across chord changes
  const pad = stereo(frames);
  {
    const r = rng("pad");
    const voices = mood === "cinematic" ? 5 : 4;
    const lo = mood === "cinematic" ? 50 : 53;
    const hi = mood === "cinematic" ? 74 : 76;
    let prev: number[] | null = null;
    const held: { midi: number; start: number; end: number; vel: number }[] = [];
    const open = new Map<number, { midi: number; start: number; end: number; vel: number }>();
    const all = [...spans, { start: resolveS, end: durationS, chord: resolveChord, level: 4, bar: n }];
    for (const span of all) {
      const v = voiceChord(span.chord, key, prev, voices, lo, hi);
      prev = v;
      const vel = span.level === 0 ? 0.75 : span.level === 1 ? 0.85 : 0.8 + span.level * 0.05;
      const keep = new Set(v);
      for (const [m, ev] of open) {
        if (!keep.has(m)) {
          held.push(ev);
          open.delete(m);
        }
      }
      for (const m of v) {
        const ev = open.get(m);
        if (ev) ev.end = span.end;
        else open.set(m, { midi: m, start: span.start, end: span.end, vel });
      }
    }
    for (const ev of open.values()) held.push(ev);
    const attack = mood === "bright" ? 0.35 : mood === "calm" ? 0.8 : 1.2;
    const release = mood === "bright" ? 0.9 : 1.6;
    for (const ev of held) {
      const isFinal = ev.end >= durationS - 1e-6;
      const gate = isFinal ? Math.max(0.2, durationS - ev.start - 0.05) : ev.end - ev.start + 0.08;
      padNote(pad, sr, r, ev.start, gate, ev.midi, ev.vel, {
        attack: ev.start === 0 ? Math.min(barS, 2.5) : attack,
        release: isFinal ? 0.05 : release,
        detuneCents: mood === "bright" ? 9 : 7,
        body: mood === "calm" ? 0.25 : 0.2,
        spread: 0.55,
      });
    }
    // filter automation: intro opens, sections set brightness, slow LFO
    const pts: [number, number][] = [[0, 0.22]];
    for (const ph of phrases) {
      const f = ph.level === 0 ? 0.45 : ph.level === 1 ? 0.6 : 0.62 + ph.level * 0.1;
      pts.push([ph.startBar * barS + (ph.level === 0 ? barS * 0.5 : 0), f]);
    }
    pts.push([resolveS, 1.0]);
    pts.push([resolveS + Math.min(tail * 0.5, barS), 0.55]);
    const curve = automation(frames, sr, pts, 0.35);
    const fl = new Svf(sr);
    const fr = new Svf(sr);
    const lfoPeriod = barS * 8;
    for (let i = 0; i < frames; i++) {
      if (i % 16 === 0) {
        const t = i / sr;
        const c = mix.padCutoff * curve[i]! * (1 + 0.18 * Math.sin((Math.PI * 2 * t) / lfoPeriod - Math.PI / 2));
        fl.set(c, 0.85);
        fr.set(c * 1.03, 0.85);
      }
      pad[0][i] = fl.lowpass(pad[0][i]!);
      pad[1][i] = fr.lowpass(pad[1][i]!);
    }
    busEq(pad, sr, mix.padHp, 0);
  }

  // -------------------------------------------------------------------------
  // Electric piano / pluck arpeggio
  const ep = stereo(frames);
  {
    const r = rng("arp");
    const patterns = ARP_PATTERNS[mood];
    const patA = r.pick(patterns);
    const patB = r.pick(patterns);
    const steps = patA.length;
    const stepS = barS / steps;
    const arpLo = mood === "cinematic" ? 60 : mood === "bright" ? 64 : 62;
    for (const span of spans) {
      const level = span.level;
      const pat = level >= 4 ? patB : patA;
      const pcs = chordTones(span.chord).map((pc) => (pc + key.tonic) % 12);
      const pool: number[] = [];
      for (let m = arpLo; m < arpLo + 19; m++) if (pcs.includes(m % 12)) pool.push(m);
      const firstStep = Math.round((span.start - span.bar * barS) / stepS);
      const lastStep = Math.round((span.end - span.bar * barS) / stepS);
      for (let s = firstStep; s < lastStep; s++) {
        const idx = pat[s % steps]!;
        if (idx < 0) continue;
        // sparse in intro / breakdown
        if (level === 0 && (s % 2 === 1 || span.bar === 0)) continue;
        if (level === 1 && s % 2 === 1) continue;
        if (mood === "bright" && level <= 1 && s % 4 !== 0) continue;
        const midi = pool[idx % pool.length]! + (level >= 4 && mood !== "bright" && s % 4 === 3 ? 12 : 0);
        const accent = s % (steps / 4) === 0 ? 1 : 0.72;
        const vel = clamp(accent * (level === 0 ? 0.5 : level === 1 ? 0.7 : 0.85) + r.gauss() * 0.04, 0.2, 1);
        const t = span.bar * barS + s * stepS + r.gauss() * 0.003;
        const pan = (s % 2 === 0 ? -0.22 : 0.22) + r.range(-0.05, 0.05);
        epNote(ep, sr, Math.max(0, t), stepS * (mood === "bright" ? 1.2 : 1.8), midi, vel, pan, {
          decay: mood === "bright" ? 0.32 : mood === "calm" ? 0.9 : 1.2,
          brightness: mood === "bright" ? 2.0 : 1.1,
          sustainIndex: mood === "bright" ? 0.5 : 0.4,
          tine: mood === "bright" ? 0.32 : mood === "calm" ? 0.16 : 0.1,
          release: 0.12,
        });
      }
    }
    // final arpeggiated tonic over the resolution
    const pcs = chordTones(resolveChord).map((pc) => (pc + key.tonic) % 12);
    const pool: number[] = [];
    for (let m = arpLo; m < arpLo + 19; m++) if (pcs.includes(m % 12)) pool.push(m);
    pool.slice(0, 4).forEach((m, i) => {
      epNote(ep, sr, resolveS + i * beatS * 0.25, tail, m, 0.75 - i * 0.08, i % 2 ? 0.2 : -0.2, {
        decay: 1.6,
        brightness: 0.8,
        release: 0.3,
      });
    });
    busEq(ep, sr, 180, mix.epLp);
  }

  // -------------------------------------------------------------------------
  // Bell melody: 2-bar pentatonic motif, repeated with a resolving variation
  const bell = stereo(frames);
  {
    const r = rng("melody");
    const pent = pentatonic(key.minor).map((pc) => (pc + key.tonic) % 12);
    const lo = mood === "cinematic" ? 67 : 72;
    const notes: number[] = [];
    for (let m = lo; m <= lo + 16; m++) if (pent.includes(m % 12)) notes.push(m);
    const minLevel = mood === "bright" ? 4 : 3;
    const eighth = beatS / 2;
    const chordAt = (t: number) => spans.find((s) => t >= s.start - 1e-6 && t < s.end - 1e-6)?.chord ?? resolveChord;
    const nearestChordTone = (target: number, chord: Chord) => {
      const pcs = chordTones(chord).map((pc) => (pc + key.tonic) % 12);
      let best = notes[0]!;
      let bd = Infinity;
      for (const m of notes) {
        if (!pcs.includes(m % 12)) continue;
        const d = Math.abs(m - target);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      return best;
    };
    let motif: { step: number; idx: number }[] | null = null;
    for (const ph of phrases) {
      if (ph.level < minLevel) continue;
      if (!motif || r.chance(0.35)) {
        const rhythm = r.pick(MELODY_RHYTHMS);
        let idx = Math.floor(notes.length / 2) + r.int(3) - 1;
        motif = rhythm.map((step, i) => {
          if (i > 0) idx = clamp(idx + r.pick([-2, -1, -1, 1, 1, 2]), 0, notes.length - 1);
          return { step, idx };
        });
      }
      for (let rep = 0; rep * 2 < ph.bars; rep++) {
        const base = (ph.startBar + rep * 2) * barS;
        motif.forEach((nt, i) => {
          const t = base + nt.step * eighth;
          if (t >= resolveS - 1e-6) return;
          let midi = notes[nt.idx]!;
          const isLast = i === motif!.length - 1;
          // strong beats and phrase ends land on chord tones; weak beats may
          // use colour tones but never a semitone above a chord tone
          const chord = chordAt(t);
          const pcs = chordTones(chord).map((pc) => (pc + key.tonic) % 12);
          const avoid = pcs.some((pc) => (midi - pc - 1) % 12 === 0);
          if (nt.step % 4 === 0 || (isLast && rep % 2 === 1) || avoid) midi = nearestChordTone(midi, chord);
          const vel = (nt.step % 4 === 0 ? 0.62 : 0.5) * (mood === "bright" ? 0.9 : 1) + r.gauss() * 0.03;
          bellNote(bell, sr, t + r.gauss() * 0.002, midi, vel, r.range(-0.3, 0.3), {
            decay: mood === "cinematic" ? 1.6 : mood === "calm" ? 1.1 : 0.7,
          });
        });
      }
    }
    // the last note: tonic on the resolution
    const tonic = notes.find((m) => m % 12 === key.tonic) ?? notes[0]!;
    bellNote(bell, sr, resolveS + beatS * 0.5, tonic, 0.5, 0.1, { decay: 1.6 });
    busEq(bell, sr, 320, 7000);
  }

  // -------------------------------------------------------------------------
  // Bass
  const bass = stereo(frames);
  {
    const r = rng("bass");
    const lo = mood === "bright" ? 33 : 36;
    const opt = {
      calm: { attack: 0.03, release: 0.12, h2: 0.22, h3: 0.06, drive: 1.1, pluck: 0 },
      bright: { attack: 0.005, release: 0.05, h2: 0.35, h3: 0.12, drive: 1.6, pluck: 0.12 },
      cinematic: { attack: 0.01, release: 0.08, h2: 0.45, h3: 0.18, drive: 1.4, pluck: 0.18 },
    }[mood];
    for (const span of spans) {
      const root = placeInRange((key.tonic + span.chord.root) % 12, lo);
      const len = span.end - span.start;
      const level = span.level;
      if (level === 0 && span.bar === 0 && mood !== "calm") continue;
      const vel = level === 0 ? 0.5 : level === 1 ? 0.7 : 0.9;
      if (level === 0) {
        // intro: the bass swells in under the pad instead of starting on a hit
        bassNote(bass, sr, span.start, len - 0.03, root, vel, { ...opt, attack: Math.min(1.2, len * 0.5), pluck: 0 });
        continue;
      }
      if (mood === "calm" || level <= 1 || (mood === "bright" && level === 2) || (mood === "cinematic" && level <= 1)) {
        if (mood === "calm" && level >= 3 && len >= barS * 0.99) {
          bassNote(bass, sr, span.start, len * 0.5 - 0.03, root, vel, opt);
          bassNote(bass, sr, span.start + len * 0.5, len * 0.5 - 0.03, root, vel * 0.85, opt);
        } else {
          bassNote(bass, sr, span.start, len - 0.03, root, vel, opt);
        }
        continue;
      }
      // driving eighths
      const eighth = beatS / 2;
      for (let t = 0; t < len - 1e-6; t += eighth) {
        const s = Math.round(t / eighth);
        const oct = level >= 4 && s % 8 === 7 ? 12 : 0;
        const v = (s % 2 === 0 ? 0.95 : 0.75) * vel + r.gauss() * 0.02;
        bassNote(bass, sr, span.start + t, eighth * 0.72, root + oct, v, opt);
      }
    }
    const root = placeInRange(key.tonic, lo);
    bassNote(bass, sr, resolveS, Math.max(0.2, tail * 0.7), root, 0.9, { ...opt, release: Math.max(0.3, tail * 0.25), pluck: 0 });
    busEq(bass, sr, 28, mix.bassLp);
  }

  // -------------------------------------------------------------------------
  // Drums / percussion
  const drums = stereo(frames);
  const kicks: number[] = [];
  {
    const r = rng("drums");
    const tonicHz = midiToFreq(placeInRange(key.tonic, 28));
    const fifthHz = midiToFreq(placeInRange((key.tonic + 7) % 12, 28));
    const kickHz = [tonicHz, fifthHz, tonicHz / 2, fifthHz / 2].reduce((a, b) => (Math.abs(b - 52) < Math.abs(a - 52) ? b : a));
    // the groove stops at the resolution; anything still ringing is choked
    const groove = stereo(frames);
    for (let bar = 0; bar < n; bar++) {
      const level = levelAt(bar);
      const t0 = bar * barS;
      const nextLevel = levelAt(bar + 1);
      const preLift = bar + 1 < n && nextLevel > level && nextLevel >= 3 && phrases.some((p) => p.startBar === bar + 1);
      if (mood === "bright") {
        if (level >= 2) {
          for (let b = 0; b < 4; b++) {
            if (level === 2 && b % 2 === 1) continue;
            if (preLift && b === 3) continue; // breath before the drop
            const t = t0 + b * beatS;
            kick(groove, sr, r, t, b === 0 ? 1 : 0.9, kickHz, 0.16, 0.25);
            kicks.push(t);
          }
        }
        if (level >= 3) {
          for (const b of [1, 3]) clap(groove, sr, r, t0 + b * beatS, 0.8, r.range(-0.1, 0.1));
        }
        if (level >= 2) {
          const sixteenth = beatS / 4;
          for (let s = 0; s < 16; s++) {
            if (level === 2 && s % 2 === 1) continue;
            const acc = s % 4 === 2 ? 1 : s % 2 === 0 ? 0.55 : 0.4;
            const swing = s % 2 === 1 ? sixteenth * 0.12 : 0;
            shaker(groove, sr, r, t0 + s * sixteenth + swing, acc * 0.8 + r.gauss() * 0.04, 0.25, level >= 4 && s % 4 === 2 ? 5000 : 4200);
          }
        }
        if (level >= 3) {
          for (let b = 0; b < 4; b++) {
            const off = t0 + (b + 0.5) * beatS;
            hat(groove, sr, r, off, level >= 4 ? 1.3 : 1.0, 0.18, level >= 4 && b % 2 === 1 ? 0.12 : 0.06);
          }
        }
        if (preLift) noiseSwell(groove, sr, r, t0, barS, 0.55, 400, 6500);
      } else if (mood === "calm") {
        if (level >= 3) {
          // very soft, felt-like shaker on offbeats only
          for (let s = 0; s < 8; s++) {
            if (s % 2 === 0) continue;
            shaker(groove, sr, r, t0 + s * (beatS / 2), 0.38 + r.gauss() * 0.03, s % 4 === 1 ? -0.3 : 0.3, 3800);
          }
        }
        if (level >= 2) for (let b = 0; b < 4; b++) kicks.push(t0 + b * beatS); // ghost pump only
        if (preLift && level >= 1) noiseSwell(groove, sr, r, t0 + barS * 0.5, barS * 0.5, 0.35, 300, 3500);
      } else {
        if (level >= 3) {
          const tomHz = midiToFreq(placeInRange(key.tonic, 38));
          const hits = level >= 4 ? [0, 1.5, 2, 3, 3.5] : [0, 1.5, 2];
          for (const h of hits) tom(groove, sr, r, t0 + h * beatS, h === 0 ? 0.9 : 0.65, h === 1.5 || h === 3.5 ? tomHz * 1.5 : tomHz, r.range(-0.2, 0.2));
        }
        if (level >= 2) kicks.push(t0, t0 + 2 * beatS);
        if (level >= 4 && phrases.some((p) => p.startBar === bar)) boom(groove, sr, r, t0, 0.7, midiToFreq(placeInRange(key.tonic, 26)), 0.9);
        if (preLift) noiseSwell(groove, sr, r, t0, barS, 0.5, 300, 5000);
      }
    }
    {
      const cut = Math.round(resolveS * sr);
      const fade = Math.round(0.012 * sr);
      for (const ch of groove) {
        for (let i = Math.max(0, cut - fade); i < ch.length; i++) ch[i]! *= i >= cut ? 0 : (cut - i) / fade;
      }
    }
    mixInto(drums, groove, 0, 1);
    for (let k = kicks.length - 1; k >= 0; k--) if (kicks[k]! >= resolveS - 1e-6) kicks.splice(k, 1);
    // resolution accent
    const resolveHit = resolveS;
    if (mood === "bright") {
      kick(drums, sr, r, resolveHit, 1, kickHz, 0.22, 0.2);
      noiseSwell(drums, sr, r, resolveS - barS * 0.5, barS * 0.5, 0.4, 500, 6000);
    } else if (mood === "cinematic") {
      boom(drums, sr, r, resolveHit, 0.85, midiToFreq(placeInRange(key.tonic, 26)), 1.4);
      noiseSwell(drums, sr, r, resolveS - barS, barS, 0.5, 300, 5000);
    }
  }

  // -------------------------------------------------------------------------
  // Side-chain pump
  const pumpDepth = mood === "bright" ? 0.45 : mood === "calm" ? 0.16 : 0.22;
  const pump = pumpCurve(frames, sr, kicks, pumpDepth, mood === "bright" ? 0.11 : 0.18);
  applyCurve(pad, pump);
  applyCurve(bass, pump);
  const lightPump = pumpCurve(frames, sr, kicks, pumpDepth * 0.4, 0.1);
  applyCurve(ep, lightPump);

  // -------------------------------------------------------------------------
  // Mix, shared space, master
  const sends = stereo(frames);
  mixInto(sends, pad, 0, mix.pad * mix.sendPad);
  mixInto(sends, ep, 0, mix.ep * mix.sendEp);
  mixInto(sends, bell, 0, mix.bell * mix.sendBell);
  mixInto(sends, drums, 0, mix.drums * mix.sendDrums);
  const delaySend = stereo(frames);
  mixInto(delaySend, ep, 0, mix.ep);
  mixInto(delaySend, bell, 0, mix.bell);
  const delayed = pingPong(delaySend, sr, beatS * 0.75, 0.35, 2800);
  mixInto(sends, delayed, 0, mix.delayMix * 0.5);
  const wet = reverb(sends, sr, SPACES[preset.space]);

  const master = stereo(frames);
  mixInto(master, pad, 0, mix.pad);
  mixInto(master, ep, 0, mix.ep);
  mixInto(master, bell, 0, mix.bell);
  mixInto(master, bass, 0, mix.bass);
  mixInto(master, drums, 0, mix.drums);
  mixInto(master, delayed, 0, mix.delayMix);
  mixInto(master, wet, 0, mix.reverbReturn);

  filterStereo(master, () => Biquad.make("highpass", sr, 30, Math.SQRT1_2));
  filterStereo(master, () => Biquad.make("highshelf", sr, 7000, 0.7, mix.highShelfDb));
  filterStereo(master, () => Biquad.make("lowpass", sr, 15000, 0.7));

  // intro swell and final fade
  const introS = phrases[0]?.level === 0 ? phrases[0].bars * barS : Math.min(barS, 1.5);
  const fadeStart = Math.min(resolveS + tail * 0.3, durationS - 0.08);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    let g = 1;
    if (t < introS) {
      const x = t / introS;
      g = dbToGain(-14 * Math.pow(1 - x, 2)) * Math.min(1, t / 0.02);
    }
    if (t > fadeStart) {
      const x = Math.min(1, (t - fadeStart) / Math.max(0.05, durationS - fadeStart));
      g *= Math.cos((x * Math.PI) / 2) ** 2;
    }
    master[0][i]! *= g;
    master[1][i]! *= g;
  }

  const target = options.targetLufs ?? -16;
  const mastered = masterBus(master, sr, target);
  const tp = truePeakDb(mastered.buf);
  return {
    pcm: mastered.buf,
    sampleRate: sr,
    bpm,
    key: key.name,
    beats: beats.filter((b) => b <= durationS * 1000 + 1e-6),
    bars: barsMs,
    strongCues: cues,
    resolveMs: Math.round(resolveS * 1000),
    mood,
    seed,
    sections: phrases.map((p) => ({
      startMs: Math.round(p.startBar * barS * 1000),
      endMs: Math.round((p.startBar + p.bars) * barS * 1000),
      level: p.level,
    })),
    chords: [...spans, { start: resolveS, end: durationS, chord: resolveChord, level: 4, bar: n }].map((sp) => ({
      startMs: Math.round(sp.start * 1000),
      endMs: Math.round(sp.end * 1000),
      symbol: sp.chord.symbol,
      notes: chordTones(sp.chord).map((pc) => noteNames(key)[(pc + key.tonic) % 12]!),
    })),
    loudness: { integratedLufs: mastered.lufs, truePeakDb: tp, lra: mastered.lra },
  };
}

/**
 * Loudness-normalise, gently saturate peaks and true-peak limit. Iterates so
 * the limiter's gain reduction does not pull the integrated level off target.
 */
function masterBus(input: Stereo, sr: number, targetLufs: number): { buf: Stereo; lufs: number; lra: number } {
  const ceilingDb = -1.8;
  let gainDb = targetLufs - measureLoudness(input, sr).integrated;
  let buf: Stereo = input;
  let lufs = 0;
  let lra = 0;
  for (let iter = 0; iter < 3; iter++) {
    buf = [Float32Array.from(input[0]), Float32Array.from(input[1])];
    scale(buf, dbToGain(gainDb));
    softClip(buf, dbToGain(-4.5));
    limit(buf, sr, ceilingDb, 140, 3);
    const m = measureLoudness(buf, sr);
    lufs = m.integrated;
    lra = m.lra;
    const err = targetLufs - lufs;
    if (Math.abs(err) < 0.15) break;
    gainDb += err;
  }
  // guarantee exact silence at the edges
  for (const ch of buf) {
    ch[ch.length - 1] = 0;
    ch[0] = 0;
  }
  return { buf, lufs, lra };
}

// ---------------------------------------------------------------------------
// SFX

export interface SfxOptions {
  seed?: number;
  key?: string;
  durationMs?: number;
  /** Selects the shared reverb space (defaults to the calm "plate"). */
  mood?: Mood;
}

export function renderSfx(kind: SfxKind, options: SfxOptions = {}): PcmAudio {
  const key = options.key ? parseKey(options.key) : keyFrom(2, false);
  const mood = moodOf(options.mood);
  return renderSfxWith(kind, {
    seed: (options.seed ?? 1) >>> 0,
    key,
    durationMs: options.durationMs,
    space: SPACES[MOODS[mood].space],
    sampleRate: 48000,
  });
}

// ---------------------------------------------------------------------------
// Files

export async function writeWav(file: string, audio: PcmAudio, format: "pcm24" | "float32" = "pcm24"): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeWavFile(file, audio, format);
}

export interface KitOptions {
  durationMs: number;
  mood?: Mood;
  seed?: number;
  key?: string;
  bpm?: number;
  endingMs?: number;
}

export interface KitManifest {
  version: 1;
  generator: "demohunter-procedural-score";
  mood: Mood;
  seed: number;
  bpm: number;
  key: string;
  durationMs: number;
  resolveMs: number;
  beats: number[];
  bars: number[];
  strongCues: StrongCue[];
  sections: ScoreResult["sections"];
  chords: ScoreResult["chords"];
  sfx: SfxKind[];
  /** Offset (ms) of each effect's hit point from its start, for aligning to cuts. */
  sfxAnchorsMs: Record<SfxKind, number>;
  music: { file: "music.wav"; integratedLufs: number; truePeakDb: number; lra: number };
}

/** Render music.wav, sfx/<kind>.wav and cues.json into `dir`. */
export async function renderKit(dir: string, options: KitOptions): Promise<KitManifest> {
  const mood = moodOf(options.mood);
  const seed = (options.seed ?? 1) >>> 0;
  const score = renderScore({
    durationMs: options.durationMs,
    mood,
    seed,
    key: options.key,
    bpm: options.bpm,
    endingMs: options.endingMs,
  });
  await mkdir(path.join(dir, "sfx"), { recursive: true });
  await writeWav(path.join(dir, "music.wav"), score);
  for (const kind of SFX_KINDS) {
    const sfx = renderSfx(kind, { seed, key: score.key, mood });
    await writeWav(path.join(dir, "sfx", `${kind}.wav`), sfx);
  }
  const manifest: KitManifest = {
    version: 1,
    generator: "demohunter-procedural-score",
    mood,
    seed,
    bpm: score.bpm,
    key: score.key,
    durationMs: options.durationMs,
    resolveMs: score.resolveMs,
    beats: score.beats,
    bars: score.bars,
    strongCues: score.strongCues,
    sections: score.sections,
    chords: score.chords,
    sfx: [...SFX_KINDS],
    sfxAnchorsMs: Object.fromEntries(SFX_KINDS.map((k) => [k, sfxAnchorMs(k)])) as Record<SfxKind, number>,
    music: {
      file: "music.wav",
      integratedLufs: Math.round(score.loudness.integratedLufs * 10) / 10,
      truePeakDb: Math.round(score.loudness.truePeakDb * 10) / 10,
      lra: Math.round(score.loudness.lra * 10) / 10,
    },
  };
  await writeFile(path.join(dir, "cues.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
