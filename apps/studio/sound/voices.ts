/**
 * Synthesised instrument voices. Each function renders one note/hit and adds
 * it into a stereo bus at a time offset. Music and SFX share these voices so
 * effects carry the same timbres as the score.
 */
import { Biquad, OnePole, Rng, Svf, TAU, midiToFreq, panGains, polyBlep, type Stereo } from "./dsp.js";

/** Smooth 0..1 ramp (sin²), used for click-free attacks. */
export const ramp = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.sin(x * Math.PI * 0.5) ** 2);

/**
 * Gate-aware envelope: smooth attack, exponential decay to sustain, held at
 * the gate end, then a raised-cosine release to exactly zero.
 */
export function envelope(t: number, gate: number, attack: number, decay: number, sustain: number, release: number): number {
  const pre = (u: number) => {
    if (u < attack) return ramp(u / attack);
    if (decay <= 0) return 1;
    return sustain + (1 - sustain) * Math.exp(-(u - attack) / decay);
  };
  if (t < gate) return pre(t);
  const r = t - gate;
  if (r >= release) return 0;
  return pre(gate) * (0.5 + 0.5 * Math.cos((Math.PI * r) / release));
}

function frameRange(bus: Stereo, sr: number, startSec: number, lenSec: number): [number, number] {
  const s = Math.round(startSec * sr);
  const e = Math.min(bus[0].length, s + Math.ceil(lenSec * sr));
  return [s, e];
}

export interface PadOptions {
  attack: number;
  release: number;
  detuneCents: number;
  /** 0..1 amount of the sub-octave sine body. */
  body: number;
  spread: number;
}

/** Detuned three-saw pad voice with slow per-oscillator drift. */
export function padNote(bus: Stereo, sr: number, rng: Rng, start: number, gate: number, midi: number, vel: number, o: PadOptions): void {
  const f = midiToFreq(midi);
  const [s, e] = frameRange(bus, sr, start, gate + o.release);
  const det = [-o.detuneCents, 0, o.detuneCents].map((c) => c + rng.range(-1.5, 1.5));
  const inc = det.map((c) => (f * Math.pow(2, c / 1200)) / sr);
  const phase = det.map(() => rng.float());
  const driftRate = det.map(() => rng.range(0.08, 0.25));
  const driftPh = det.map(() => rng.range(0, TAU));
  const pans = [-o.spread, rng.range(-0.15, 0.15), o.spread].map(panGains);
  let bodyPh = 0;
  const bodyInc = f / sr;
  const amp = vel * 0.22;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const env = envelope(t, gate, o.attack, 0, 1, o.release) * amp;
    if (env === 0 && t > o.attack) continue;
    let l = 0;
    let r = 0;
    for (let k = 0; k < 3; k++) {
      const dr = 1 + 0.0012 * Math.sin(TAU * driftRate[k]! * t + driftPh[k]!);
      const dt = inc[k]! * dr;
      let p = phase[k]! + dt;
      if (p >= 1) p -= 1;
      phase[k] = p;
      const v = (2 * p - 1 - polyBlep(p, dt)) / 3;
      l += v * pans[k]![0];
      r += v * pans[k]![1];
    }
    bodyPh += bodyInc;
    if (bodyPh >= 1) bodyPh -= 1;
    const body = Math.sin(TAU * bodyPh) * o.body * 0.5;
    bus[0][i]! += (l + body) * env;
    bus[1][i]! += (r + body) * env;
  }
}

export interface EpOptions {
  decay: number;
  brightness: number;
  release: number;
  /** Level of the short metallic "tine" partial (4th harmonic). */
  tine?: number;
  /** Sustained FM index (body brightness after the attack). */
  sustainIndex?: number;
}

/** Two-operator FM electric piano / soft pluck. */
export function epNote(bus: Stereo, sr: number, start: number, gate: number, midi: number, vel: number, pan: number, o: EpOptions): void {
  const f = midiToFreq(midi);
  const decay = o.decay * Math.pow(440 / f, 0.35);
  const len = Math.min(gate + o.release, decay * 6);
  const [s, e] = frameRange(bus, sr, start, len);
  const [gl, gr] = panGains(pan);
  const w = (TAU * f) / sr;
  const amp = vel * 0.3;
  const idx0 = o.brightness * (0.6 + 0.4 * vel);
  const tineAmp = f * 4 < 7000 ? (o.tine ?? 0) * vel : 0;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const n = i - s;
    const attack = ramp(t / 0.004);
    let env = attack * Math.exp(-t / decay);
    if (t > gate) env *= 0.5 + 0.5 * Math.cos(Math.min(1, (t - gate) / o.release) * Math.PI);
    const tailFade = t > len - 0.02 ? Math.max(0, (len - t) / 0.02) : 1;
    const index = idx0 * (1.4 * Math.exp(-t / 0.08) + (o.sustainIndex ?? 0.3) * Math.exp(-t / 0.7));
    const tine = tineAmp * Math.sin(4 * w * n) * Math.exp(-t / 0.12);
    const y = (Math.sin(w * n + index * Math.sin(w * n)) + tine) * env * tailFade * amp;
    bus[0][i]! += y * gl;
    bus[1][i]! += y * gr;
  }
}

export interface BellOptions {
  decay: number;
}

/** Soft celesta / glass bell: few harmonic partials with fast-decaying uppers. */
export function bellNote(bus: Stereo, sr: number, start: number, midi: number, vel: number, pan: number, o: BellOptions): void {
  const f = midiToFreq(midi);
  const len = o.decay * 5;
  const [s, e] = frameRange(bus, sr, start, len);
  const [gl, gr] = panGains(pan);
  const partials: [number, number, number][] = [
    [1, 1, o.decay],
    [2, 0.2, o.decay * 0.35],
    [3, 0.06, o.decay * 0.18],
  ];
  const amp = vel * 0.28;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const a = ramp(t / 0.003);
    const tailFade = t > len - 0.05 ? Math.max(0, (len - t) / 0.05) : 1;
    let y = 0;
    const shimmer = 0.7 * Math.exp(-t / 0.03);
    for (const [ratio, g, d] of partials) {
      const fr = f * ratio;
      if (fr > 7500) continue;
      const ph = TAU * fr * t;
      y += Math.sin(ph + (ratio === 1 ? shimmer * Math.sin(ph) : 0)) * g * Math.exp(-t / d);
    }
    y *= a * tailFade * amp;
    bus[0][i]! += y * gl;
    bus[1][i]! += y * gr;
  }
}

export interface BassOptions {
  attack: number;
  release: number;
  h2: number;
  h3: number;
  drive: number;
  /** Seconds for the upper harmonics to fade (pluck character). 0 = static. */
  pluck: number;
}

/** Sine sub bass with a little harmonic content for small speakers. */
export function bassNote(bus: Stereo, sr: number, start: number, gate: number, midi: number, vel: number, o: BassOptions): void {
  const f = midiToFreq(midi);
  const [s, e] = frameRange(bus, sr, start, gate + o.release);
  const w = (TAU * f) / sr;
  const amp = vel * 0.5;
  const norm = Math.tanh(o.drive);
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const n = i - s;
    const env = envelope(t, gate, o.attack, 0, 1, o.release);
    const h = o.pluck > 0 ? 0.35 + 0.65 * Math.exp(-t / o.pluck) : 1;
    const x = Math.sin(w * n) + o.h2 * h * Math.sin(2 * w * n) + o.h3 * h * Math.sin(3 * w * n);
    const y = (Math.tanh(o.drive * x * 0.7) / norm) * env * amp;
    bus[0][i]! += y;
    bus[1][i]! += y;
  }
}

/** Soft kick: sine with a pitch drop, gentle attack, tiny filtered click. */
export function kick(bus: Stereo, sr: number, rng: Rng, start: number, vel: number, tuneHz: number, decay: number, click: number): void {
  const len = Math.max(0.35, decay * 4);
  const [s, e] = frameRange(bus, sr, start, len);
  let ph = 0;
  const lp = new OnePole(sr, 2500);
  const amp = vel * 0.75;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const f = tuneHz * (1 + 2.2 * Math.exp(-t / 0.03));
    ph += (TAU * f) / sr;
    const a = ramp(t / 0.0015) * Math.exp(-t / decay) * (t > len - 0.03 ? Math.max(0, (len - t) / 0.03) : 1);
    const c = lp.process(rng.float() * 2 - 1) * click * Math.exp(-t / 0.005) * ramp(t / 0.001);
    const y = Math.tanh(1.4 * (Math.sin(ph) * a + c)) * amp;
    bus[0][i]! += y;
    bus[1][i]! += y;
  }
}

/** Soft layered clap / snare. */
export function clap(bus: Stereo, sr: number, rng: Rng, start: number, vel: number, pan: number): void {
  const len = 0.45;
  const [s, e] = frameRange(bus, sr, start, len);
  const bp = new Svf(sr);
  bp.set(1350, 0.9);
  const lp = Biquad.make("lowpass", sr, 6000);
  const [gl, gr] = panGains(pan);
  const amp = vel * 0.55;
  const offs = [0, 0.009, 0.019];
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    let env = 0;
    for (const o of offs) if (t >= o) env = Math.max(env, ramp((t - o) / 0.0015) * Math.exp(-(t - o) / 0.006));
    if (t >= 0.022) env = Math.max(env, 0.55 * ramp((t - 0.022) / 0.002) * Math.exp(-(t - 0.022) / 0.09));
    const fade = t > len - 0.05 ? (len - t) / 0.05 : 1;
    const nz = lp.process(bp.bandpass(rng.float() * 2 - 1)) * 2.2;
    const body = Math.sin(TAU * 190 * t) * Math.exp(-t / 0.035) * ramp(t / 0.002) * 0.35;
    const y = (nz * env + body) * amp * fade;
    bus[0][i]! += y * gl;
    bus[1][i]! += y * gr;
  }
}

/** Filtered-noise shaker grain. */
export function shaker(bus: Stereo, sr: number, rng: Rng, start: number, vel: number, pan: number, center = 4800): void {
  const len = 0.12;
  const [s, e] = frameRange(bus, sr, start, len);
  const bp = new Svf(sr);
  bp.set(center, 1.3);
  const lp = Biquad.make("lowpass", sr, 7500);
  const [gl, gr] = panGains(pan);
  const amp = vel * 0.45;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const env = ramp(t / 0.006) * Math.exp(-t / 0.03) * (t > len - 0.02 ? (len - t) / 0.02 : 1);
    const y = lp.process(bp.bandpass(rng.float() * 2 - 1)) * env * amp;
    bus[0][i]! += y * gl;
    bus[1][i]! += y * gr;
  }
}

/** Low cinematic tom / felt drum. */
export function tom(bus: Stereo, sr: number, rng: Rng, start: number, vel: number, tuneHz: number, pan: number): void {
  const len = 0.9;
  const [s, e] = frameRange(bus, sr, start, len);
  const lp = new OnePole(sr, 700);
  const [gl, gr] = panGains(pan);
  let ph = 0;
  const amp = vel * 0.6;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const f = tuneHz * (1 + 0.5 * Math.exp(-t / 0.05));
    ph += (TAU * f) / sr;
    const a = ramp(t / 0.003) * Math.exp(-t / 0.28) * (t > len - 0.05 ? (len - t) / 0.05 : 1);
    const nz = lp.process(rng.float() * 2 - 1) * Math.exp(-t / 0.03) * 0.6;
    const y = Math.tanh(1.2 * (Math.sin(ph) + nz)) * a * amp;
    bus[0][i]! += y * gl;
    bus[1][i]! += y * gr;
  }
}

/**
 * Deep impact / boom tuned to a pitch: sub sine with pitch drop, a softer
 * octave body and a low-passed noise thump.
 */
export function boom(bus: Stereo, sr: number, rng: Rng, start: number, vel: number, tuneHz: number, decay = 1.0): void {
  const len = decay * 3;
  const [s, e] = frameRange(bus, sr, start, len);
  const lp = Biquad.make("lowpass", sr, 900, 0.6);
  let p1 = 0;
  let p2 = 0;
  const amp = vel * 0.8;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const f = tuneHz * (1 + 1.6 * Math.exp(-t / 0.05));
    p1 += (TAU * f) / sr;
    p2 += (TAU * f * 2) / sr;
    const a = ramp(t / 0.004);
    const fade = t > len - 0.1 ? (len - t) / 0.1 : 1;
    const sub = Math.sin(p1) * Math.exp(-t / decay);
    const body = Math.sin(p2) * 0.3 * Math.exp(-t / (decay * 0.3));
    const nz = lp.process(rng.float() * 2 - 1) * 0.9 * Math.exp(-t / 0.09);
    const y = Math.tanh(1.3 * (sub + body + nz)) * a * fade * amp;
    bus[0][i]! += y;
    bus[1][i]! += y;
  }
}

/**
 * Noise swell (reverse-cymbal like) that rises towards `start + dur`, with a
 * low-pass opening; ends with a short fade so it can lead into a downbeat.
 */
export function noiseSwell(bus: Stereo, sr: number, rng: Rng, start: number, dur: number, vel: number, fromHz: number, toHz: number): void {
  const [s, e] = frameRange(bus, sr, start, dur);
  const fl = new Svf(sr);
  const fr = new Svf(sr);
  const amp = vel * 0.4;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const x = t / dur;
    if ((i - s) % 32 === 0) {
      const fc = fromHz * Math.pow(toHz / fromHz, x * x);
      fl.set(fc, 0.9);
      fr.set(fc * 1.04, 0.9);
    }
    const env = Math.pow(x, 2.2) * (x > 0.96 ? (1 - x) / 0.04 : 1);
    bus[0][i]! += fl.lowpass(rng.float() * 2 - 1) * env * amp;
    bus[1][i]! += fr.lowpass(rng.float() * 2 - 1) * env * amp;
  }
}

/** Soft closed/open hat: high-passed noise with a gentle top roll-off. */
export function hat(bus: Stereo, sr: number, rng: Rng, start: number, vel: number, pan: number, decay = 0.045): void {
  const len = Math.min(0.4, decay * 6);
  const [s, e] = frameRange(bus, sr, start, len);
  const hp = Biquad.make("highpass", sr, 6500, 0.7);
  const hp2 = Biquad.make("highpass", sr, 6500, 0.7);
  const lp = Biquad.make("lowpass", sr, 11000, 0.7);
  const [gl, gr] = panGains(pan);
  const amp = vel * 0.55;
  for (let i = s; i < e; i++) {
    const t = (i - s) / sr;
    const env = ramp(t / 0.004) * Math.exp(-t / decay) * (t > len - 0.02 ? (len - t) / 0.02 : 1);
    const y = lp.process(hp2.process(hp.process(rng.float() * 2 - 1))) * env * amp;
    bus[0][i]! += y * gl;
    bus[1][i]! += y * gr;
  }
}
