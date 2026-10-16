/**
 * Sound-effects kit. Every effect is tuned to the score's key, uses the same
 * voices as the music and is placed in the same reverb space, then levelled
 * so small repeated sounds sit back and big moments match the music bed.
 */
import {
  Biquad,
  Rng,
  Svf,
  TAU,
  dbToGain,
  filterStereo,
  measureLoudness,
  midiToFreq,
  mixInto,
  panGains,
  polyBlep,
  reverb,
  scale,
  stereo,
  streamSeed,
  truePeakDb,
  type PcmAudio,
  type SpaceParams,
  type Stereo,
} from "./dsp.js";
import { pentatonic, placeInRange, progression, voiceChord, type Key } from "./theory.js";
import { bellNote, boom, noiseSwell, padNote, ramp } from "./voices.js";

export const SFX_KINDS = [
  "whoosh",
  "whoosh-soft",
  "pop",
  "click",
  "key",
  "tick",
  "riser",
  "impact",
  "chime",
  "swell",
  "glitch",
  "drop",
] as const;

export type SfxKind = (typeof SFX_KINDS)[number];

interface SfxSpec {
  /** Default length of the sound itself (before the reverb tail). */
  ms: number;
  tailS: number;
  wet: number;
  /** Max momentary loudness target (LUFS) relative to a −16 LUFS music bed. */
  lufs: number;
  lowpass: number;
  /** True-peak cap; keeps small, repeated transients from poking out of the mix. */
  peakDb: number;
  /** Where the sound "hits" (ms from start), for aligning to cuts. */
  anchor: (ms: number) => number;
}

export const SFX_SPECS: Record<SfxKind, SfxSpec> = {
  whoosh: { ms: 650, tailS: 0.35, wet: 0.2, lufs: -21, lowpass: 6000, peakDb: -8, anchor: (ms) => ms * 0.62 },
  "whoosh-soft": { ms: 520, tailS: 0.4, wet: 0.3, lufs: -26, lowpass: 5000, peakDb: -12, anchor: (ms) => ms * 0.58 },
  pop: { ms: 110, tailS: 0.25, wet: 0.12, lufs: -23, lowpass: 6500, peakDb: -12, anchor: () => 2 },
  click: { ms: 40, tailS: 0.12, wet: 0.06, lufs: -28, lowpass: 6000, peakDb: -15, anchor: () => 3 },
  key: { ms: 80, tailS: 0.12, wet: 0.05, lufs: -29, lowpass: 6000, peakDb: -15, anchor: () => 2 },
  tick: { ms: 30, tailS: 0.1, wet: 0.08, lufs: -31, lowpass: 6000, peakDb: -17, anchor: () => 2 },
  riser: { ms: 2000, tailS: 0.4, wet: 0.2, lufs: -19, lowpass: 7500, peakDb: -6, anchor: (ms) => ms },
  impact: { ms: 1600, tailS: 0.6, wet: 0.25, lufs: -15, lowpass: 6000, peakDb: -3, anchor: () => 4 },
  chime: { ms: 900, tailS: 0.7, wet: 0.3, lufs: -22, lowpass: 7500, peakDb: -10, anchor: () => 3 },
  swell: { ms: 1500, tailS: 0.5, wet: 0.25, lufs: -20, lowpass: 7000, peakDb: -6, anchor: (ms) => ms },
  glitch: { ms: 320, tailS: 0.25, wet: 0.12, lufs: -24, lowpass: 5000, peakDb: -13, anchor: () => 2 },
  drop: { ms: 900, tailS: 0.4, wet: 0.15, lufs: -18, lowpass: 3000, peakDb: -6, anchor: () => 5 },
};

export interface SfxRenderOptions {
  seed: number;
  key: Key;
  durationMs?: number;
  space: SpaceParams;
  sampleRate: number;
}

const note = (key: Key, interval: number, lo: number) => placeInRange((key.tonic + interval) % 12, lo);

function whoosh(buf: Stereo, sr: number, r: Rng, key: Key, dur: number, soft: boolean): void {
  const n = Math.round(dur * sr);
  const bl = new Svf(sr);
  const br = new Svf(sr);
  const ll = new Svf(sr);
  const lr = new Svf(sr);
  const lo = soft ? 180 : 260;
  const hi = soft ? 1100 : 2400;
  const peak = soft ? 0.58 : 0.62;
  const toneHz = [midiToFreq(note(key, 0, 55)), midiToFreq(note(key, 7, 55))];
  let tp0 = 0;
  let tp1 = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const env = x < peak ? Math.pow(ramp(x / peak), 1.4) : 0.5 + 0.5 * Math.cos(((x - peak) / (1 - peak)) * Math.PI);
    if (i % 16 === 0) {
      const fc = lo * Math.pow(hi / lo, env);
      bl.set(fc, soft ? 0.8 : 1.1);
      br.set(fc * 1.06, soft ? 0.8 : 1.1);
      ll.set(fc * 0.7, 0.6);
      lr.set(fc * 0.72, 0.6);
    }
    const nl = r.float() * 2 - 1;
    const nr = r.float() * 2 - 1;
    const pan = -0.7 + 1.4 * x;
    const [gl, gr] = panGains(pan);
    tp0 += (TAU * toneHz[0]!) / sr;
    tp1 += (TAU * toneHz[1]!) / sr;
    const tone = (Math.sin(tp0) + 0.7 * Math.sin(tp1)) * (soft ? 0.03 : 0.05);
    const l = (bl.bandpass(nl) * 0.75 + ll.lowpass(nl) * 0.35) * env;
    const rr = (br.bandpass(nr) * 0.75 + lr.lowpass(nr) * 0.35) * env;
    buf[0][i]! += (l + tone * env) * gl * 1.4;
    buf[1][i]! += (rr + tone * env) * gr * 1.4;
  }
}

function pop(buf: Stereo, sr: number, r: Rng, key: Key, dur: number): void {
  const f0 = midiToFreq(note(key, 0, 72));
  const n = Math.round(dur * sr);
  let ph = 0;
  const lp = Biquad.make("lowpass", sr, 3000);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + 0.5 * Math.exp(-t / 0.01));
    ph += (TAU * f) / sr;
    const a = ramp(t / 0.0025) * Math.exp(-t / (dur * 0.32));
    const y = Math.sin(ph) * a + Math.sin(2 * ph) * 0.12 * a * Math.exp(-t / 0.015) + lp.process(r.float() * 2 - 1) * 0.04 * Math.exp(-t / 0.003) * ramp(t / 0.001);
    buf[0][i]! += y * 0.6;
    buf[1][i]! += y * 0.6;
  }
}

function click(buf: Stereo, sr: number, r: Rng, key: Key, dur: number): void {
  const f0 = midiToFreq(note(key, 7, 76));
  const n = Math.round(dur * sr);
  const bp = new Svf(sr);
  bp.set(2400, 1.4);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const a = ramp(t / 0.003);
    const y = Math.sin(TAU * f0 * t) * a * Math.exp(-t / 0.009) * 0.5 + bp.bandpass(r.float() * 2 - 1) * a * Math.exp(-t / 0.004) * 0.9;
    buf[0][i]! += y;
    buf[1][i]! += y;
  }
}

function keyTap(buf: Stereo, sr: number, r: Rng, key: Key, dur: number): void {
  const n = Math.round(dur * sr);
  const bodyHz = midiToFreq(note(key, 0, 55));
  const hits = [
    { t: 0, g: 1, fc: r.range(1700, 2500) },
    { t: Math.min(dur * 0.75, r.range(0.045, 0.06)), g: 0.35, fc: r.range(2300, 3000) },
  ];
  const pan = r.range(-0.15, 0.15);
  const [gl, gr] = panGains(pan);
  for (const h of hits) {
    const bp = new Svf(sr);
    bp.set(h.fc, 1.6);
    const s = Math.round(h.t * sr);
    for (let i = s; i < n; i++) {
      const t = (i - s) / sr;
      const a = ramp(t / 0.002) * h.g;
      const y = bp.bandpass(r.float() * 2 - 1) * a * Math.exp(-t / 0.005) * 1.2 + Math.sin(TAU * bodyHz * t) * a * Math.exp(-t / 0.012) * 0.45;
      buf[0][i]! += y * gl;
      buf[1][i]! += y * gr;
    }
  }
}

function tick(buf: Stereo, sr: number, _r: Rng, key: Key, dur: number): void {
  const f0 = midiToFreq(note(key, 0, 84));
  const n = Math.round(dur * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const a = ramp(t / 0.002) * Math.exp(-t / 0.008);
    const y = (Math.sin(TAU * f0 * t) + 0.25 * Math.sin(TAU * f0 * 2 * t) * Math.exp(-t / 0.004)) * a * 0.5;
    buf[0][i]! += y;
    buf[1][i]! += y;
  }
}

function riser(buf: Stereo, sr: number, r: Rng, key: Key, dur: number): void {
  const tones = stereo(buf[0].length);
  const notes = [note(key, 0, 43), note(key, 7, 43), note(key, 0, 55), note(key, 7, 62)];
  for (const m of notes) padNote(tones, sr, r, 0, dur - 0.04, m, 0.8, { attack: dur * 0.95, release: 0.04, detuneCents: 10, body: 0.3, spread: 0.6 });
  // opening filter + accelerating tremolo
  const fl = new Svf(sr);
  const fr = new Svf(sr);
  let trem = 0;
  const n = Math.round(dur * sr);
  for (let i = 0; i < tones[0].length; i++) {
    const x = Math.min(1, i / n);
    if (i % 16 === 0) {
      const fc = 200 * Math.pow(3600 / 200, x * x);
      fl.set(fc, 1.1);
      fr.set(fc * 1.03, 1.1);
    }
    trem += (TAU * (3 + 11 * x * x)) / sr;
    const g = 1 - 0.22 * x * (0.5 + 0.5 * Math.sin(trem));
    tones[0][i] = fl.lowpass(tones[0][i]!) * g;
    tones[1][i] = fr.lowpass(tones[1][i]!) * g;
  }
  mixInto(buf, tones, 0, 1.6);
  noiseSwell(buf, sr, r, 0, dur, 0.9, 300, 6500);
}

function impact(buf: Stereo, sr: number, r: Rng, key: Key, dur: number): void {
  const tonicHz = midiToFreq(note(key, 0, 28));
  const hz = tonicHz > 62 ? tonicHz / 2 : tonicHz;
  const tuned = hz < 38 ? hz * 2 : hz;
  boom(buf, sr, r, 0, 1, tuned, dur * 0.45);
  // tonal body: low open fifth in the pad timbre, decaying with the boom
  const body = stereo(buf[0].length);
  for (const m of [note(key, 0, 36), note(key, 7, 36), note(key, 0, 48)]) {
    padNote(body, sr, r, 0, 0.06, m, 0.9, { attack: 0.006, release: dur * 0.6, detuneCents: 8, body: 0.6, spread: 0.6 });
  }
  filterStereo(body, () => Biquad.make("lowpass", sr, 600, 0.7));
  mixInto(buf, body, 0, 1.1);
  // soft air layer
  const air = new Svf(sr);
  air.set(1100, 0.7);
  const n = Math.round(0.6 * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const y = air.bandpass(r.float() * 2 - 1) * ramp(t / 0.004) * Math.exp(-t / 0.15) * 0.18;
    buf[0][i]! += y;
    buf[1][i]! -= y * 0.6;
  }
}

function chime(buf: Stereo, sr: number, _r: Rng, key: Key, dur: number): void {
  const decay = Math.max(0.3, dur / 1000) * 0.9;
  // rising fifth -> tonic, so the chime always resolves home in the score's key
  const fifth = note(key, 7, 69);
  bellNote(buf, sr, 0, fifth, 0.75, -0.2, { decay });
  bellNote(buf, sr, 0.09, note(key, 0, fifth + 1), 0.85, 0.2, { decay: decay * 1.2 });
}

function swell(buf: Stereo, sr: number, r: Rng, key: Key, dur: number): void {
  const tonic = progression(key.minor ? "i:madd9" : "I:add9", key.minor)[0]!;
  const v = voiceChord(tonic, key, null, 4, 55, 76);
  const pad = stereo(buf[0].length);
  for (const m of v) padNote(pad, sr, r, 0, dur, m, 0.85, { attack: dur, release: 0.22, detuneCents: 8, body: 0.4, spread: 0.6 });
  padNote(pad, sr, r, 0, dur, note(key, 0, 43), 0.7, { attack: dur, release: 0.22, detuneCents: 4, body: 0.6, spread: 0.2 });
  const fl = new Svf(sr);
  const fr = new Svf(sr);
  const n = Math.round(dur * sr);
  for (let i = 0; i < pad[0].length; i++) {
    const x = Math.min(1, i / n);
    if (i % 16 === 0) {
      const fc = 300 * Math.pow(3800 / 300, x);
      fl.set(fc, 0.9);
      fr.set(fc * 1.03, 0.9);
    }
    pad[0][i] = fl.lowpass(pad[0][i]!);
    pad[1][i] = fr.lowpass(pad[1][i]!);
  }
  mixInto(buf, pad, 0, 1.3);
  noiseSwell(buf, sr, r, 0, dur, 0.45, 400, 5000);
}

function glitch(buf: Stereo, sr: number, r: Rng, key: Key, dur: number): void {
  const pent = pentatonic(key.minor);
  const count = 7 + r.int(5);
  const times: number[] = [];
  for (let k = 0; k < count; k++) times.push(r.range(0, dur * 0.85));
  times.sort((a, b) => a - b);
  times[0] = 0;
  for (const t0 of times) {
    const len = r.range(0.012, 0.04);
    const m = note(key, r.pick(pent), r.chance(0.5) ? 72 : 79);
    const f = midiToFreq(m);
    const hold = 2 + r.int(3);
    const [gl, gr] = panGains(r.range(-0.6, 0.6));
    const s = Math.round(t0 * sr);
    const e = Math.min(buf[0].length, s + Math.round(len * sr));
    let ph = r.float();
    let held = 0;
    const dt = f / sr;
    const g = r.range(0.5, 1);
    for (let i = s; i < e; i++) {
      const t = (i - s) / sr;
      ph += dt;
      if (ph >= 1) ph -= 1;
      // band-limited square
      let sq = ph < 0.5 ? 1 : -1;
      sq += polyBlep(ph, dt);
      sq -= polyBlep((ph + 0.5) % 1, dt);
      if ((i - s) % hold === 0) held = sq;
      const a = ramp(t / 0.002) * ramp((len - t) / 0.003) * g * 0.35;
      buf[0][i]! += held * a * gl;
      buf[1][i]! += held * a * gr;
    }
  }
}

function drop(buf: Stereo, sr: number, _r: Rng, key: Key, dur: number): void {
  const fStart = midiToFreq(note(key, 0, 48));
  const fEnd = fStart / 4;
  const n = Math.round(dur * sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const x = i / n;
    const f = fStart * Math.pow(fEnd / fStart, Math.min(1, x / 0.85));
    ph += (TAU * f) / sr;
    const a = ramp(t / 0.005) * (x < 0.55 ? 1 : 0.5 + 0.5 * Math.cos(((x - 0.55) / 0.45) * Math.PI));
    const y = Math.tanh(1.3 * (Math.sin(ph) + 0.25 * Math.sin(2 * ph))) * a * 0.7;
    buf[0][i]! += y;
    buf[1][i]! += y;
  }
}

const RENDER: Record<SfxKind, (buf: Stereo, sr: number, r: Rng, key: Key, dur: number) => void> = {
  whoosh: (b, sr, r, k, d) => whoosh(b, sr, r, k, d, false),
  "whoosh-soft": (b, sr, r, k, d) => whoosh(b, sr, r, k, d, true),
  pop,
  click,
  key: keyTap,
  tick,
  riser,
  impact,
  chime,
  swell,
  glitch,
  drop,
};

export function renderSfxWith(kind: SfxKind, o: SfxRenderOptions): PcmAudio {
  const spec = SFX_SPECS[kind];
  if (!spec) throw new Error(`Unknown sfx kind "${kind}"`);
  const sr = o.sampleRate;
  const durMs = Math.max(10, Math.min(o.durationMs ?? spec.ms, 15000));
  const dur = durMs / 1000;
  const total = Math.round((dur + spec.tailS) * sr);
  const r = new Rng(streamSeed(o.seed, `sfx:${kind}`));
  const dry = stereo(total);
  RENDER[kind](dry, sr, r, o.key, dur);
  // shared space
  const wet = reverb(dry, sr, o.space);
  const out = stereo(total);
  mixInto(out, dry, 0, 1);
  mixInto(out, wet, 0, spec.wet * 2.2);
  // tone shaping: nothing harsh above ~8 kHz, no rumble/DC
  filterStereo(out, () => Biquad.make("highpass", sr, 35, Math.SQRT1_2));
  filterStereo(out, () => Biquad.make("lowpass", sr, spec.lowpass, Math.SQRT1_2));
  filterStereo(out, () => Biquad.make("lowpass", sr, Math.min(8000, spec.lowpass * 1.25), Math.SQRT1_2));
  // short, natural tail: fade the last part of the reverb tail to zero
  const fadeFrames = Math.round(spec.tailS * 0.8 * sr);
  for (const ch of out) {
    for (let i = 0; i < fadeFrames; i++) {
      const x = i / fadeFrames;
      ch[total - fadeFrames + i]! *= Math.cos((x * Math.PI) / 2) ** 2;
    }
    ch[0] = 0;
    ch[total - 1] = 0;
  }
  // level: loudness target, true peak capped at −3 dBTP
  const loud = measureLoudness(padForLoudness(out, sr), sr).maxMomentary;
  const g = Number.isFinite(loud) && loud > -70 ? dbToGain(spec.lufs - loud) : 1;
  scale(out, g);
  const tp = truePeakDb(out);
  if (tp > spec.peakDb) scale(out, dbToGain(spec.peakDb - tp));
  return { pcm: out, sampleRate: sr };
}

/** Short sounds are measured inside a 400 ms window so momentary loudness is defined. */
function padForLoudness(buf: Stereo, sr: number): Stereo {
  const min = Math.round(0.4 * sr);
  if (buf[0].length >= min) return buf;
  const out = stereo(min);
  mixInto(out, buf, 0, 1);
  return out;
}

export function sfxAnchorMs(kind: SfxKind, durationMs?: number): number {
  const spec = SFX_SPECS[kind];
  return Math.round(spec.anchor(durationMs ?? spec.ms));
}

