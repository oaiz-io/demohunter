/**
 * Render a procedural music + SFX kit.
 *
 *   bun apps/studio/sound/cli.ts <out-dir> --duration 60000 --mood calm --seed 7 [--key D] [--bpm 96] [--ending 56000]
 */
import path from "node:path";
import { renderKit, type Mood } from "./score.js";

const usage = `Usage: bun apps/studio/sound/cli.ts <out-dir> [options]

Options:
  --duration <ms>   Total length of music.wav (default 60000)
  --mood <name>     calm | bright | cinematic (default calm)
  --seed <n>        Deterministic seed (default 1)
  --key <key>       e.g. D, Eb, F#m, "A minor" (default: chosen by mood + seed)
  --bpm <n>         Fixed tempo (default: fitted so the ending lands on a downbeat)
  --ending <ms>     Where the final tonic chord lands (default: duration minus a short tail)
`;

export async function main(args: string[]): Promise<number> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      console.log(usage);
      return 0;
    }
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`Missing value for --${name}`);
      flags.set(name, value);
    } else positional.push(a);
  }
  const out = positional[0];
  if (!out) {
    console.error(usage);
    return 1;
  }
  const num = (name: string, fallback?: number) => {
    const v = flags.get(name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  };
  const moodFlag = flags.get("mood") ?? "calm";
  if (!["calm", "bright", "cinematic"].includes(moodFlag)) throw new Error(`Unknown mood "${moodFlag}"`);
  const started = performance.now();
  const manifest = await renderKit(path.resolve(out), {
    durationMs: num("duration", 60000)!,
    mood: moodFlag as Mood,
    seed: num("seed", 1),
    key: flags.get("key"),
    bpm: num("bpm"),
    endingMs: num("ending"),
  });
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `${path.resolve(out)}: ${manifest.mood} in ${manifest.key} at ${manifest.bpm} bpm, ` +
      `${manifest.music.integratedLufs} LUFS, ${manifest.music.truePeakDb} dBTP, LRA ${manifest.music.lra} LU, ` +
      `${manifest.sfx.length} sfx (${secs}s)`,
  );
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
