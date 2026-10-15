import { execFile, spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      cmd,
      args,
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (e, out) => (e ? reject(e) : resolve(out)),
    ),
  );

export type MachineCheck = {
  chromium: boolean;
  ffmpeg: boolean;
  flite: boolean;
  /** Which provider keys exist in the service environment. Never the value. */
  speechKeys: { openai: boolean; elevenlabs: boolean };
};
let cached: Promise<MachineCheck> | undefined;
/** What this machine can do. Checked once per service process. */
export function machineCheck(): Promise<MachineCheck> {
  return (cached ??= (async () => {
    const [chromiumOk, ffmpegFilters] = await Promise.all([
      access(chromium.executablePath()).then(
        () => true,
        () => false,
      ),
      run("ffmpeg", ["-hide_banner", "-filters"]).catch(() => undefined),
    ]);
    return {
      chromium: chromiumOk,
      ffmpeg: ffmpegFilters !== undefined,
      flite: !!ffmpegFilters && /\bflite\b/.test(ffmpegFilters),
      speechKeys: {
        openai: !!process.env.OPENAI_API_KEY,
        elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      },
    };
  })());
}

export type RecordJob = {
  id: string;
  tour: string;
  destination: string;
  status: "running" | "succeeded" | "failed";
  step?: "timeline" | "record" | "bundle";
  startedAt: string;
  finishedAt?: string;
  error?: string;
};
const jobs = new Map<string, RecordJob>();
const children = new Map<string, ReturnType<typeof spawn>>();
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

async function configFolder(root: string, tourFile: string) {
  // The capture CLI loads demohunter.config.* from its working directory.
  let dir = path.dirname(tourFile);
  while (dir.startsWith(root)) {
    const names = await readdir(dir).catch(() => [] as string[]);
    if (names.some((n) => /^demohunter\.config\.(ts|mts|js|mjs)$/.test(n)))
      return dir;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return path.dirname(tourFile);
}

/** Record a known tour with the normal capture CLI, in a new folder. */
export async function startRecording(
  root: string,
  tour: string,
): Promise<RecordJob> {
  if ([...jobs.values()].some((j) => j.status === "running"))
    throw new Error("A recording is already running.");
  const tourFile = path.resolve(root, tour);
  const cwd = await configFolder(root, tourFile);
  const name = path.basename(tour).replace(/\.tour\.ts$/, "");
  const destination = path.join(".demohunter/replays", `${name}-${Date.now()}`);
  const job: RecordJob = {
    id: randomUUID(),
    tour,
    destination: path.relative(root, path.join(cwd, destination)),
    status: "running",
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  const child = spawn(
    process.execPath,
    [cli, "capture", path.relative(cwd, tourFile), "--project", destination],
    { cwd, stdio: ["ignore", "ignore", "pipe"] },
  );
  children.set(job.id, child);
  let tail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-4000);
    for (const match of chunk.toString().matchAll(/studio:step (\w+)/g))
      job.step = match[1] as RecordJob["step"];
  });
  child.once("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
  });
  child.once("close", (code) => {
    children.delete(job.id);
    job.finishedAt = new Date().toISOString();
    if (job.error === "Stopped") job.status = "failed";
    else if (code === 0) job.status = "succeeded";
    else {
      job.status = "failed";
      job.error =
        tail
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("studio:step"))
          .slice(-3)
          .join("\n") || `Capture exited with code ${code}`;
    }
  });
  return job;
}
export function recordJobs(): RecordJob[] {
  return [...jobs.values()].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}
export function stopRecording(id: string): RecordJob {
  const job = jobs.get(id);
  if (!job) throw new Error("Recording job not found");
  if (job.status === "running") {
    job.error = "Stopped";
    children.get(id)?.kill("SIGTERM");
  }
  return job;
}
