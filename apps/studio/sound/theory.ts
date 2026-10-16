/** Keys, chords, progressions and voice leading for the procedural score. */

export interface Key {
  /** Pitch class of the tonic, 0 = C. */
  tonic: number;
  minor: boolean;
  name: string;
}

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** Accepts "D", "Eb", "F#m", "A minor", "c# min", "Bb major". */
export function parseKey(input: string): Key {
  const m = /^\s*([A-Ga-g])\s*(#|b|♯|♭)?\s*(m|min|minor|maj|major|M)?\s*$/.exec(input);
  if (!m) throw new Error(`Unrecognised key "${input}" (try "D", "F#m", "A minor")`);
  let pc = LETTERS[m[1]!.toUpperCase()]!;
  if (m[2] === "#" || m[2] === "♯") pc += 1;
  if (m[2] === "b" || m[2] === "♭") pc -= 1;
  pc = (pc + 12) % 12;
  const q = m[3];
  const minor = q === "m" || q === "min" || q === "minor";
  return keyFrom(pc, minor);
}

export function keyFrom(tonic: number, minor: boolean): Key {
  const t = ((tonic % 12) + 12) % 12;
  return { tonic: t, minor, name: `${SHARP_NAMES[t]} ${minor ? "minor" : "major"}` };
}

export const QUALITIES = {
  maj: [0, 4, 7],
  add9: [0, 4, 7, 14],
  maj7: [0, 4, 7, 11],
  maj9: [0, 4, 7, 11, 14],
  six9: [0, 4, 9, 14],
  min: [0, 3, 7],
  m7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14],
  madd9: [0, 3, 7, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  sus4add9: [0, 5, 7, 14],
  dom7: [0, 4, 7, 10],
  dom7sus4: [0, 5, 7, 10],
} as const;

export type Quality = keyof typeof QUALITIES;

export interface Chord {
  /** Semitones above the key tonic. */
  root: number;
  quality: Quality;
  symbol: string;
}

const MAJOR_DEGREES: Record<string, number> = { I: 0, ii: 2, iii: 4, IV: 5, V: 7, vi: 9, bVII: 10 };
const MINOR_DEGREES: Record<string, number> = { i: 0, III: 3, iv: 5, v: 7, V: 7, VI: 8, VII: 10, ii: 2 };

/** Parse "I:add9 V vi:m7 IV:maj7" into chords. Quality defaults from case. */
export function progression(spec: string, minor: boolean): Chord[] {
  return spec.trim().split(/\s+/).map((token) => {
    const [deg, q] = token.split(":") as [string, string | undefined];
    const root = (minor ? MINOR_DEGREES : MAJOR_DEGREES)[deg];
    if (root === undefined) throw new Error(`Unknown degree ${deg}`);
    const lower = deg === deg.toLowerCase() && deg !== "bVII";
    const quality = (q ?? (lower ? "min" : "maj")) as Quality;
    return { root, quality, symbol: token };
  });
}

/** Pitch classes (relative to tonic) of a chord, with tensions folded. */
export function chordTones(chord: Chord): number[] {
  return QUALITIES[chord.quality].map((i) => (chord.root + i) % 12);
}

export function scaleTones(minor: boolean): number[] {
  return minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
}

export function pentatonic(minor: boolean): number[] {
  return minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
}

/**
 * Choose a close voicing (absolute MIDI notes) of `chord` within [lo, hi]
 * that moves as little as possible from `prev`. Avoids muddy close intervals
 * low in the register and keeps the guide tones (3rd / 7th / sus).
 */
export function voiceChord(chord: Chord, key: Key, prev: number[] | null, voices: number, lo: number, hi: number): number[] {
  const ivs = QUALITIES[chord.quality];
  const pcs = ivs.map((i) => (key.tonic + chord.root + i) % 12);
  const guide = new Set<number>();
  for (const i of ivs) if (i !== 0 && i !== 7) guide.add((key.tonic + chord.root + i) % 12);
  const rootPc = (key.tonic + chord.root) % 12;
  // all candidate notes
  const notes: number[] = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(((m % 12) + 12) % 12)) notes.push(m);
  let best: number[] | null = null;
  let bestScore = Infinity;
  const center = (lo + hi) / 2;
  const choose = (start: number, acc: number[]) => {
    if (acc.length === voices) {
      score(acc);
      return;
    }
    for (let i = start; i < notes.length; i++) {
      const n = notes[i]!;
      if (acc.length && n - acc[acc.length - 1]! < 2) continue;
      acc.push(n);
      choose(i + 1, acc);
      acc.pop();
    }
  };
  const score = (v: number[]) => {
    const set = new Set(v.map((n) => n % 12));
    for (const g of guide) if (!set.has(g)) return;
    let s = 0;
    // doubled pitch classes are fine only if we have more voices than tones
    if (set.size < Math.min(voices, pcs.length)) s += 6;
    for (let i = 1; i < v.length; i++) {
      const gap = v[i]! - v[i - 1]!;
      if (v[i - 1]! < 60 && gap < 3) s += 8; // mud
      if (gap === 1) s += 10; // minor second rubs
      if (gap > 9) s += (gap - 9) * 1.5; // holes
    }
    if (v[0]! % 12 === rootPc && v[0]! < 55) s += 0; // fine
    if (prev && prev.length === v.length) {
      for (let i = 0; i < v.length; i++) s += Math.abs(v[i]! - prev[i]!) * 1.2;
    } else {
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      s += Math.abs(mean - center) * 0.8;
    }
    if (s < bestScore) {
      bestScore = s;
      best = v.slice();
    }
  };
  choose(0, []);
  if (!best) {
    // fallback: stack tones upwards from lo
    const out: number[] = [];
    let m = lo;
    for (let i = 0; out.length < voices && i < 48; i++, m++) if (pcs.includes(m % 12)) out.push(m);
    return out;
  }
  return best;
}

/** MIDI note of pitch class `pc` (absolute) in [lo, lo + 11]. */
export function placeInRange(pc: number, lo: number): number {
  let m = lo + ((((pc - lo) % 12) + 12) % 12);
  return m;
}
