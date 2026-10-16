/**
 * Offline analysis used to calibrate the score against reference mixes and to
 * check renders: spectral band balance, tempo estimate, crest factor and
 * loudness. Run: `bun apps/studio/sound/analyze.ts file.wav [--start s] [--dur s]`
 */
import { gainToDb, measureLoudness, readWav, truePeakDb, type Stereo } from "./dsp.js";

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const bi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export const BANDS: [string, number, number][] = [
  ["sub 20-60", 20, 60],
  ["bass 60-250", 60, 250],
  ["lowmid 250-800", 250, 800],
  ["mid 0.8-2.5k", 800, 2500],
  ["presence 2.5-6k", 2500, 6000],
  ["air 6-10k", 6000, 10000],
  ["top 10k+", 10000, 24000],
];

export interface Analysis {
  bandsDb: Record<string, number>;
  centroidHz: number;
  tempoBpm: number;
  tempoConfidence: number;
  crestDb: number;
  rmsDb: number;
  integratedLufs: number;
  lra: number;
  truePeakDb: number;
  above8kDb: number;
}

export function analyze(buf: Stereo, sampleRate: number): Analysis {
  const n = 4096;
  const hop = 2048;
  const frames = buf[0].length;
  const power = new Float64Array(n / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  // onset envelope from spectral flux (log magnitude), 512 hop for tempo
  const onsetHop = 512;
  const fluxN = 1024;
  const prev = new Float64Array(fluxN / 2);
  const flux: number[] = [];
  const re2 = new Float64Array(fluxN);
  const im2 = new Float64Array(fluxN);
  const win2 = new Float64Array(fluxN);
  for (let i = 0; i < fluxN; i++) win2[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fluxN - 1));
  let count = 0;
  for (let start = 0; start + n <= frames; start += hop) {
    for (let i = 0; i < n; i++) {
      re[i] = ((buf[0][start + i]! + buf[1][start + i]!) / 2) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < n / 2; k++) power[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
    count++;
  }
  for (let start = 0; start + fluxN <= frames; start += onsetHop) {
    for (let i = 0; i < fluxN; i++) {
      re2[i] = ((buf[0][start + i]! + buf[1][start + i]!) / 2) * win2[i]!;
      im2[i] = 0;
    }
    fft(re2, im2);
    let f = 0;
    for (let k = 1; k < fluxN / 2; k++) {
      const m = Math.log1p(1000 * Math.hypot(re2[k]!, im2[k]!));
      const d = m - prev[k]!;
      if (d > 0) f += d;
      prev[k] = m;
    }
    flux.push(f);
  }
  const binHz = sampleRate / n;
  const bandsDb: Record<string, number> = {};
  let total = 0;
  let cent = 0;
  let above8 = 0;
  for (let k = 1; k < n / 2; k++) {
    total += power[k]!;
    cent += power[k]! * k * binHz;
    if (k * binHz >= 8000) above8 += power[k]!;
  }
  for (const [name, lo, hi] of BANDS) {
    let e = 0;
    for (let k = Math.ceil(lo / binHz); k < Math.min(n / 2, hi / binHz); k++) e += power[k]!;
    bandsDb[name] = 10 * Math.log10(Math.max(e / total, 1e-12));
  }
  // tempo via autocorrelation of the mean-removed, half-wave rectified flux
  const fps = sampleRate / onsetHop;
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  const o = flux.map((f) => Math.max(0, f - mean));
  let best = 0;
  let bestLag = 0;
  let zero = 0;
  for (let i = 0; i < o.length; i++) zero += o[i]! * o[i]!;
  const scores: [number, number][] = [];
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (const mult of [1, 2, 4]) {
      const l = lag * mult;
      const l0 = Math.floor(l);
      const fr = l - l0;
      let acc = 0;
      for (let i = 0; i + l0 + 1 < o.length; i++) acc += o[i]! * (o[i + l0]! * (1 - fr) + o[i + l0 + 1]! * fr);
      s += acc / (mult === 1 ? 1 : 2);
    }
    // mild prior toward 90-130 bpm to resolve octave errors
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.6, 2));
    s *= prior;
    scores.push([bpm, s]);
    if (s > best) {
      best = s;
      bestLag = bpm;
    }
  }
  const avgScore = scores.reduce((a, [, s]) => a + s, 0) / scores.length;
  let sq = 0;
  let peak = 0;
  for (const ch of buf) for (let i = 0; i < ch.length; i++) {
    sq += ch[i]! * ch[i]!;
    peak = Math.max(peak, Math.abs(ch[i]!));
  }
  const rms = Math.sqrt(sq / (2 * frames));
  const loud = measureLoudness(buf, sampleRate);
  return {
    bandsDb,
    centroidHz: cent / total,
    tempoBpm: bestLag,
    tempoConfidence: zero > 0 ? best / avgScore : 0,
    crestDb: gainToDb(peak) - gainToDb(rms),
    rmsDb: gainToDb(rms),
    integratedLufs: loud.integrated,
    lra: loud.lra,
    truePeakDb: truePeakDb(buf),
    above8kDb: 10 * Math.log10(Math.max(above8 / total, 1e-12)),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : undefined;
  };
  for (const file of files) {
    const audio = readWav(file);
    const sr = audio.sampleRate;
    const s = Math.round((opt("--start") ?? 0) * sr);
    const d = opt("--dur");
    const e = d ? Math.min(audio.pcm[0]!.length, s + Math.round(d * sr)) : audio.pcm[0]!.length;
    const l = audio.pcm[0]!.subarray(s, e);
    const r = (audio.pcm[1] ?? audio.pcm[0]!).subarray(s, e);
    const a = analyze([l, r], sr);
    console.log(`== ${file}`);
    console.log(
      `  LUFS ${a.integratedLufs.toFixed(1)}  LRA ${a.lra.toFixed(1)}  TP ${a.truePeakDb.toFixed(2)} dB  crest ${a.crestDb.toFixed(1)} dB  centroid ${a.centroidHz.toFixed(0)} Hz  >8k ${a.above8kDb.toFixed(1)} dB`,
    );
    console.log(`  tempo ${a.tempoBpm} bpm (confidence ${a.tempoConfidence.toFixed(2)})`);
    console.log("  bands " + Object.entries(a.bandsDb).map(([k, v]) => `${k}: ${v.toFixed(1)}`).join(" | "));
  }
}
