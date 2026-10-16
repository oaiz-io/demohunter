/**
 * Small, dependency-free DSP toolkit for the procedural score and SFX kit.
 *
 * Everything here is deterministic: no Math.random, no time-dependent state.
 * Buffers are plain Float32Array per channel; internal state is kept in
 * doubles (JS numbers) to avoid accumulating float error in feedback paths.
 */
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

export type Stereo = [Float32Array, Float32Array];

export const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Randomness

/** mulberry32: tiny, fast, good-enough deterministic PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent stream from a seed and a label (FNV-1a mix). */
export function streamSeed(seed: number, label: string): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Approximately Gaussian, mean 0, sd 1 (sum of uniforms). */
  gauss(): number {
    return this.next() + this.next() + this.next() + this.next() - 2;
  }
}

// ---------------------------------------------------------------------------
// Pitch

export const midiToFreq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

// ---------------------------------------------------------------------------
// Buffers

export function stereo(frames: number): Stereo {
  return [new Float32Array(frames), new Float32Array(frames)];
}

/** Mix `src` into `dst` at frame offset with gain (clipped to dst length). */
export function mixInto(dst: Stereo, src: Stereo, offset: number, gain = 1): void {
  const n = Math.min(src[0].length, dst[0].length - offset);
  const start = Math.max(0, -offset);
  for (let c = 0; c < 2; c++) {
    const d = dst[c]!;
    const s = src[c]!;
    for (let i = start; i < n; i++) d[i + offset]! += s[i]! * gain;
  }
}

export function scale(buf: Stereo, gain: number): void {
  for (const ch of buf) for (let i = 0; i < ch.length; i++) ch[i]! *= gain;
}

export function peakAbs(buf: Stereo): number {
  let p = 0;
  for (const ch of buf) for (let i = 0; i < ch.length; i++) {
    const v = Math.abs(ch[i]!);
    if (v > p) p = v;
  }
  return p;
}

/** Raised-cosine fade at the start and/or end, in frames. */
export function edgeFade(buf: Stereo, inFrames: number, outFrames: number): void {
  const n = buf[0].length;
  for (const ch of buf) {
    for (let i = 0; i < Math.min(inFrames, n); i++) {
      ch[i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / inFrames);
    }
    for (let i = 0; i < Math.min(outFrames, n); i++) {
      ch[n - 1 - i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / outFrames);
    }
  }
}

/** Constant-power pan; pan in [-1, 1]. */
export function panGains(pan: number): [number, number] {
  const p = (Math.max(-1, Math.min(1, pan)) + 1) * 0.25 * Math.PI;
  return [Math.cos(p), Math.sin(p)];
}

// ---------------------------------------------------------------------------
// Filters

/** RBJ biquad, transposed direct form II, per channel state. */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private z1 = 0;
  private z2 = 0;

  static make(
    type: "lowpass" | "highpass" | "bandpass" | "peak" | "lowshelf" | "highshelf",
    sampleRate: number,
    freq: number,
    q = Math.SQRT1_2,
    gainDb = 0,
  ): Biquad {
    const f = new Biquad();
    f.set(type, sampleRate, freq, q, gainDb);
    return f;
  }

  set(
    type: "lowpass" | "highpass" | "bandpass" | "peak" | "lowshelf" | "highshelf",
    sampleRate: number,
    freq: number,
    q = Math.SQRT1_2,
    gainDb = 0,
  ): void {
    const w0 = (TAU * Math.min(freq, sampleRate * 0.49)) / sampleRate;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (type) {
      case "lowpass":
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case "highpass":
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case "bandpass":
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case "peak":
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case "lowshelf": {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + s);
        b1 = 2 * A * (A - 1 - (A + 1) * cw);
        b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s;
        a1 = -2 * (A - 1 + (A + 1) * cw);
        a2 = A + 1 + (A - 1) * cw - s;
        break;
      }
      case "highshelf": {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + s);
        b1 = -2 * A * (A - 1 + (A + 1) * cw);
        b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s;
        a1 = 2 * (A - 1 - (A + 1) * cw);
        a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    if (Math.abs(this.z1) < 1e-25) this.z1 = 0;
    if (Math.abs(this.z2) < 1e-25) this.z2 = 0;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/** Apply a filter (fresh state per channel) in place. */
export function filterStereo(buf: Stereo, make: () => Biquad): void {
  for (const ch of buf) {
    const f = make();
    for (let i = 0; i < ch.length; i++) ch[i] = f.process(ch[i]!);
  }
}

/**
 * Zero-delay-feedback state-variable filter (Simper/Cytomic). Safe to modulate
 * every sample, which is what the pad filter sweeps need.
 */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private g = 0;
  private k = 1;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  constructor(private sampleRate: number) {}

  set(freq: number, q: number): void {
    this.g = Math.tan((Math.PI * Math.min(freq, this.sampleRate * 0.45)) / this.sampleRate);
    this.k = 1 / q;
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }

  /** Returns low-pass output; band/high are available via `last*`. */
  lowpass(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    if (Math.abs(this.ic1) < 1e-25) this.ic1 = 0;
    if (Math.abs(this.ic2) < 1e-25) this.ic2 = 0;
    return v2;
  }

  bandpass(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    if (Math.abs(this.ic1) < 1e-25) this.ic1 = 0;
    if (Math.abs(this.ic2) < 1e-25) this.ic2 = 0;
    return v1;
  }
}

/** One-pole smoother / low-pass. */
export class OnePole {
  private y = 0;
  private a: number;
  constructor(sampleRate: number, freq: number, initial = 0) {
    this.a = Math.exp((-TAU * freq) / sampleRate);
    this.y = initial;
  }
  process(x: number): number {
    this.y = x + this.a * (this.y - x);
    return this.y;
  }
}

// ---------------------------------------------------------------------------
// Oscillators

/** PolyBLEP residual for band-limited saw/square edges. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Shared reverb space

export type SpaceName = "room" | "plate" | "hall";

export interface SpaceParams {
  /** Seconds to decay 60 dB at low/mid frequencies. */
  t60: number;
  /** One-pole damping cutoff inside the loop (Hz). */
  damping: number;
  /** Delay scale (room size). */
  size: number;
  preDelayMs: number;
  /** Wet return EQ. */
  lowCut: number;
  highCut: number;
}

export const SPACES: Record<SpaceName, SpaceParams> = {
  room: { t60: 1.4, damping: 5200, size: 0.8, preDelayMs: 14, lowCut: 220, highCut: 6500 },
  plate: { t60: 2.2, damping: 6000, size: 1.0, preDelayMs: 22, lowCut: 200, highCut: 7000 },
  hall: { t60: 3.4, damping: 4200, size: 1.35, preDelayMs: 30, lowCut: 160, highCut: 6000 },
};

const FDN_BASE = [1153, 1361, 1559, 1741, 1949, 2137, 2351, 2557];
const DIFFUSER_BASE = [142, 107, 379, 277];

/**
 * Stereo FDN reverb: 4 input diffusers, 8 modulated delay lines with a
 * Householder feedback matrix and per-line damping. Deterministic and click
 * free; returns only the wet signal so callers decide the send level.
 */
export function reverb(input: Stereo, sampleRate: number, space: SpaceParams, tailFrames = 0): Stereo {
  const n = input[0].length + tailFrames;
  const out = stereo(n);
  const sr = sampleRate / 48000;
  const lens = FDN_BASE.map((l) => Math.round(l * space.size * sr));
  const lines = lens.map((l) => new Float64Array(l + 16));
  const idx = new Array<number>(8).fill(0);
  const gains = lens.map((l) => Math.pow(10, (-3 * l) / (space.t60 * sampleRate)));
  const dampA = Math.exp((-TAU * space.damping) / sampleRate);
  const damp = new Float64Array(8);
  const diffL = DIFFUSER_BASE.map((l) => new Float64Array(Math.round(l * sr)));
  const diffR = DIFFUSER_BASE.map((l) => new Float64Array(Math.round(l * 1.13 * sr)));
  const dIdxL = [0, 0, 0, 0];
  const dIdxR = [0, 0, 0, 0];
  const pre = Math.max(1, Math.round((space.preDelayMs / 1000) * sampleRate));
  const preL = new Float64Array(pre);
  const preR = new Float64Array(pre);
  let preIdx = 0;
  const lc = [Biquad.make("highpass", sampleRate, space.lowCut, 0.6), Biquad.make("highpass", sampleRate, space.lowCut, 0.6)];
  const hc = [Biquad.make("lowpass", sampleRate, space.highCut, 0.6), Biquad.make("lowpass", sampleRate, space.highCut, 0.6)];
  const signsL = [1, -1, 1, -1, 1, -1, 1, -1];
  const signsR = [1, 1, -1, -1, 1, 1, -1, -1];
  const v = new Float64Array(8);
  const modDepth = 6 * sr;
  const modRate = [0.31, 0.47, 0.23, 0.39];
  const inL = input[0];
  const inR = input[1];
  const ap = 0.62;
  for (let i = 0; i < n; i++) {
    let xl = i < inL.length ? inL[i]! : 0;
    let xr = i < inR.length ? inR[i]! : 0;
    // pre-delay
    const pl = preL[preIdx]!;
    const pr = preR[preIdx]!;
    preL[preIdx] = xl;
    preR[preIdx] = xr;
    preIdx = (preIdx + 1) % pre;
    xl = pl;
    xr = pr;
    // series allpass diffusion
    for (let d = 0; d < 4; d++) {
      const bl = diffL[d]!;
      const yl = bl[dIdxL[d]!]!;
      const wl = xl + ap * yl;
      bl[dIdxL[d]!] = wl;
      xl = yl - ap * wl;
      dIdxL[d] = (dIdxL[d]! + 1) % bl.length;
      const br = diffR[d]!;
      const yr = br[dIdxR[d]!]!;
      const wr = xr + ap * yr;
      br[dIdxR[d]!] = wr;
      xr = yr - ap * wr;
      dIdxR[d] = (dIdxR[d]! + 1) % br.length;
    }
    // read delay lines (first four are gently modulated)
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      const buf = lines[k]!;
      const len = buf.length;
      let read: number;
      if (k < 4) {
        const m = modDepth * (1 + Math.sin((TAU * modRate[k]! * i) / sampleRate + k)) * 0.5;
        const pos = idx[k]! - lens[k]! + m;
        const p0 = Math.floor(pos);
        const frac = pos - p0;
        const a = buf[((p0 % len) + len) % len]!;
        const b = buf[(((p0 + 1) % len) + len) % len]!;
        read = a + (b - a) * frac;
      } else {
        read = buf[(((idx[k]! - lens[k]!) % len) + len) % len]!;
      }
      // damping
      damp[k] = read + dampA * (damp[k]! - read);
      if (Math.abs(damp[k]!) < 1e-25) damp[k] = 0;
      v[k] = damp[k]! * gains[k]!;
      sum += v[k]!;
    }
    const h = (2 / 8) * sum;
    let ol = 0;
    let or = 0;
    for (let k = 0; k < 8; k++) {
      ol += v[k]! * signsL[k]!;
      or += v[k]! * signsR[k]!;
      const inject = k % 2 === 0 ? xl : xr;
      const buf = lines[k]!;
      buf[idx[k]! % buf.length] = v[k]! - h + inject;
      idx[k] = (idx[k]! + 1) % buf.length;
    }
    out[0][i] = hc[0]!.process(lc[0]!.process(ol * 0.35));
    out[1][i] = hc[1]!.process(lc[1]!.process(or * 0.35));
  }
  return out;
}

/** Tempo-synced stereo ping-pong delay with low-passed feedback (wet only). */
export function pingPong(
  input: Stereo,
  sampleRate: number,
  delaySec: number,
  feedback: number,
  lowpass: number,
  tailFrames = 0,
): Stereo {
  const n = input[0].length + tailFrames;
  const out = stereo(n);
  const d = Math.max(1, Math.round(delaySec * sampleRate));
  const bl = new Float64Array(d);
  const br = new Float64Array(d);
  const fl = new OnePole(sampleRate, lowpass);
  const fr = new OnePole(sampleRate, lowpass);
  const hl = Biquad.make("highpass", sampleRate, 300);
  const hr = Biquad.make("highpass", sampleRate, 300);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const x = i < input[0].length ? (input[0][i]! + input[1][i]!) * 0.5 : 0;
    const yl = bl[j]!;
    const yr = br[j]!;
    // ping-pong: left feeds right, mono input enters on the left
    bl[j] = fl.process(x + yr * feedback);
    br[j] = fr.process(yl);
    j = (j + 1) % d;
    out[0][i] = hl.process(yl);
    out[1][i] = hr.process(yr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loudness (ITU-R BS.1770-4 / EBU R128, approximate but standards based)

function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  // Coefficient derivation as in libebur128 / pyloudnorm.
  const shelf = new Biquad();
  {
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / sampleRate);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    shelf.b0 = (Vh + (Vb * K) / Q + K * K) / a0;
    shelf.b1 = (2 * (K * K - Vh)) / a0;
    shelf.b2 = (Vh - (Vb * K) / Q + K * K) / a0;
    shelf.a1 = (2 * (K * K - 1)) / a0;
    shelf.a2 = (1 - K / Q + K * K) / a0;
  }
  const hp = new Biquad();
  {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / sampleRate);
    const a0 = 1 + K / Q + K * K;
    hp.b0 = 1;
    hp.b1 = -2;
    hp.b2 = 1;
    hp.a1 = (2 * (K * K - 1)) / a0;
    hp.a2 = (1 - K / Q + K * K) / a0;
  }
  return [shelf, hp];
}

/** Mean-square of K-weighted signal per 100 ms hop (sum over channels). */
function kWeightedHops(buf: Stereo, sampleRate: number): Float64Array {
  const hop = Math.round(sampleRate * 0.1);
  const hops = Math.floor(buf[0].length / hop);
  const ms = new Float64Array(hops);
  for (const ch of buf) {
    const [s, h] = kWeightingFilters(sampleRate);
    for (let b = 0; b < hops; b++) {
      let acc = 0;
      for (let i = b * hop; i < (b + 1) * hop; i++) {
        const y = h.process(s.process(ch[i]!));
        acc += y * y;
      }
      ms[b]! += acc / hop;
    }
  }
  return ms;
}

const lufsOf = (ms: number) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-20));

export interface Loudness {
  integrated: number;
  lra: number;
  maxMomentary: number;
  maxShortTerm: number;
}

export function measureLoudness(buf: Stereo, sampleRate: number): Loudness {
  const hops = kWeightedHops(buf, sampleRate);
  const window = (len: number) => {
    const out: number[] = [];
    for (let i = 0; i + len <= hops.length; i++) {
      let acc = 0;
      for (let j = i; j < i + len; j++) acc += hops[j]!;
      out.push(acc / len);
    }
    if (out.length === 0 && hops.length > 0) {
      let acc = 0;
      for (const h of hops) acc += h;
      out.push(acc / hops.length);
    }
    return out;
  };
  const momentary = window(4);
  const short = window(30);
  // integrated: 400 ms blocks with 75 % overlap == momentary windows at 100 ms hop
  const abs = momentary.filter((m) => lufsOf(m) > -70);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const relGate = lufsOf(mean(abs)) - 10;
  const gated = abs.filter((m) => lufsOf(m) > relGate);
  const integrated = gated.length ? lufsOf(mean(gated)) : -70;
  // LRA
  const stAbs = short.map(lufsOf).filter((l) => l > -70);
  const stRel = lufsOf(mean(short.filter((m) => lufsOf(m) > -70))) - 20;
  const st = stAbs.filter((l) => l > stRel).sort((a, b) => a - b);
  const pct = (p: number) => st[Math.min(st.length - 1, Math.max(0, Math.round((p / 100) * (st.length - 1))))] ?? -70;
  const lra = st.length > 1 ? pct(95) - pct(10) : 0;
  return {
    integrated,
    lra,
    maxMomentary: momentary.length ? Math.max(...momentary.map(lufsOf)) : -70,
    maxShortTerm: short.length ? Math.max(...short.map(lufsOf)) : -70,
  };
}

// ---------------------------------------------------------------------------
// True peak (4x oversampled, windowed-sinc polyphase interpolation)

const TP_TAPS = 12; // per side
let tpKernel: Float64Array[] | null = null;
function truePeakKernel(): Float64Array[] {
  if (tpKernel) return tpKernel;
  const phases: Float64Array[] = [];
  for (let p = 1; p < 4; p++) {
    const k = new Float64Array(TP_TAPS * 2);
    const frac = p / 4;
    let sum = 0;
    for (let j = 0; j < TP_TAPS * 2; j++) {
      const x = j - TP_TAPS + 1 - frac; // offset from interpolated point
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / TP_TAPS) + 0.08 * Math.cos((2 * Math.PI * x) / TP_TAPS);
      k[j] = sinc * w;
      sum += k[j]!;
    }
    for (let j = 0; j < k.length; j++) k[j]! /= sum;
    phases.push(k);
  }
  tpKernel = phases;
  return phases;
}

/** Per-frame inter-sample peak envelope (max |x| over both channels, between frames i-1..i). */
export function truePeakEnvelope(buf: Stereo, threshold = 0): Float32Array {
  const n = buf[0].length;
  const env = new Float32Array(n);
  const kernel = truePeakKernel();
  for (const ch of buf) {
    for (let i = 0; i < n; i++) {
      let m = Math.abs(ch[i]!);
      // inter-sample overs stay within a few dB of neighbouring samples, so
      // skip the interpolation for samples that are clearly below threshold
      if (threshold > 0 && m < threshold && Math.abs(ch[i - 1] ?? 0) < threshold && Math.abs(ch[i + 1] ?? 0) < threshold) {
        if (m > env[i]!) env[i] = m;
        continue;
      }
      // interpolated points between i-1 and i
      for (const k of kernel) {
        let acc = 0;
        const base = i - TP_TAPS;
        for (let j = 0; j < k.length; j++) {
          const idx = base + j;
          if (idx >= 0 && idx < n) acc += ch[idx]! * k[j]!;
        }
        const a = Math.abs(acc);
        if (a > m) m = a;
      }
      if (m > env[i]!) env[i] = m;
    }
  }
  return env;
}

export function truePeakDb(buf: Stereo): number {
  const env = truePeakEnvelope(buf, peakAbs(buf) * 0.5);
  let m = 0;
  for (let i = 0; i < env.length; i++) if (env[i]! > m) m = env[i]!;
  return gainToDb(m);
}

/**
 * Offline look-ahead true-peak limiter. Because the whole signal is known,
 * the gain curve is computed ahead of time: future-min over the look-ahead
 * window, a smooth release, then a moving-average attack ramp. This keeps the
 * gain at or below the required reduction at every peak while staying smooth.
 */
export function limit(buf: Stereo, sampleRate: number, ceilingDb: number, releaseMs = 120, lookaheadMs = 3): void {
  const n = buf[0].length;
  const ceiling = dbToGain(ceilingDb);
  const env = truePeakEnvelope(buf, ceiling * 0.5);
  const w = Math.max(2, Math.round((lookaheadMs / 1000) * sampleRate));
  const target = new Float64Array(n);
  for (let i = 0; i < n; i++) target[i] = env[i]! > ceiling ? ceiling / env[i]! : 1;
  // future min over [i, i + w)
  const fmin = new Float64Array(n);
  {
    // monotonic deque
    const dq = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (let i = n - 1; i >= 0; i--) {
      while (tail > head && target[dq[tail - 1]!]! >= target[i]!) tail--;
      dq[tail++] = i;
      while (dq[head]! >= i + w) head++;
      fmin[i] = target[dq[head]!]!;
    }
  }
  const rc = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  let g = 1;
  for (let i = 0; i < n; i++) {
    g = Math.min(fmin[i]!, rc * g + (1 - rc) * fmin[i]!);
    fmin[i] = g;
  }
  // moving average over the past w samples
  let acc = 0;
  const gain = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    acc += fmin[i]!;
    if (i >= w) acc -= fmin[i - w]!;
    const avg = acc / Math.min(i + 1, w);
    gain[i] = Math.min(avg, fmin[i]!) ;
  }
  for (const ch of buf) for (let i = 0; i < n; i++) ch[i]! *= gain[i]!;
}

/** Gentle soft clipper: linear below the knee, tanh-shaped above it. */
export function softClip(buf: Stereo, knee = 0.7): void {
  const span = 1 - knee;
  for (const ch of buf) {
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i]!;
      const a = Math.abs(x);
      if (a > knee) ch[i] = Math.sign(x) * (knee + span * Math.tanh((a - knee) / span));
    }
  }
}

// ---------------------------------------------------------------------------
// WAV I/O

export interface PcmAudio {
  pcm: Float32Array[];
  sampleRate: number;
}

export function encodeWav(audio: PcmAudio, format: "pcm24" | "float32" = "pcm24"): Uint8Array {
  const channels = audio.pcm.length;
  const frames = audio.pcm[0]?.length ?? 0;
  const bytesPer = format === "pcm24" ? 3 : 4;
  const dataBytes = frames * channels * bytesPer;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format === "pcm24" ? 1 : 3, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * bytesPer, true);
  view.setUint16(32, channels * bytesPer, true);
  view.setUint16(34, bytesPer * 8, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = audio.pcm[c]![i]!;
      const x = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
      if (format === "float32") {
        view.setFloat32(off, x, true);
        off += 4;
      } else {
        let s = Math.round(x * 8388607);
        if (s < 0) s += 0x1000000;
        view.setUint8(off, s & 0xff);
        view.setUint8(off + 1, (s >> 8) & 0xff);
        view.setUint8(off + 2, (s >> 16) & 0xff);
        off += 3;
      }
    }
  }
  return new Uint8Array(buf);
}

export async function writeWav(path: string, audio: PcmAudio, format: "pcm24" | "float32" = "pcm24"): Promise<void> {
  await writeFile(path, encodeWav(audio, format));
}

/** Minimal WAV reader (PCM 16/24/32 and float32), used for analysis and tests. */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  let fmt = 1, channels = 2, sampleRate = 48000, bits = 16;
  let dataOff = -1, dataLen = 0;
  while (off + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);
    const len = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = view.getUint16(off + 8, true);
      channels = view.getUint16(off + 10, true);
      sampleRate = view.getUint32(off + 12, true);
      bits = view.getUint16(off + 22, true);
      if (fmt === 0xfffe) fmt = view.getUint16(off + 32, true);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.min(len, bytes.length - dataOff);
      break;
    }
    off += 8 + len + (len % 2);
  }
  if (dataOff < 0) throw new Error("WAV has no data chunk");
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const pcm = Array.from({ length: channels }, () => new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v: number;
      if (fmt === 3 && bits === 32) v = view.getFloat32(p, true);
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 24) {
        let s = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16);
        if (s & 0x800000) s -= 0x1000000;
        v = s / 8388608;
      } else v = view.getInt32(p, true) / 2147483648;
      pcm[c]![i] = v;
      p += bps;
    }
  }
  return { pcm, sampleRate };
}

export function readWav(path: string): PcmAudio {
  return decodeWav(new Uint8Array(readFileSync(path)));
}
