import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEMOHUNTER_CONFIG,
  type DemoHunterTour,
} from "@demohunter/sdk";
import { measureNarrationAudioDuration } from "../../packages/tts-core/src/cache/cache-store.js";
import { captureReplay } from "./capture.js";
import { ReplayWorkspace } from "./workspace.js";
import { narrationRequestKey, clipDuration, clipStart } from "./model.js";
import { loadBundle, writeJson } from "./storage.js";

export async function createInvoiceDemo(
  dir: string,
  localVoice = true,
): Promise<string> {
  const html = await readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures/invoices.html",
    ),
  );
  const app = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as { port: number }).port;
  const titles = [
    "A clear overview",
    "Review the invoice",
    "Check the calculation",
    "Approve with confidence",
  ];
  const tour: DemoHunterTour = {
    id: "invoice-approval",
    title: "Invoice approval, from start to finish",
    async run({ page, chapter, narrate, narrateWhile }) {
      await chapter(titles[0]!);
      await narrate(
        "Northstar keeps every invoice in one place. Start with the overview to see outstanding balances and the invoice waiting for your approval.",
      );
      await chapter(titles[1]!);
      await narrateWhile(
        "Open the invoice for Acme Studio. Review the customer, the work completed, and the due date before making a decision.",
        async ({ sleep }) => {
          await sleep(900);
          await page.getByRole("button", { name: "Review invoice" }).click();
        },
      );
      await chapter(titles[2]!);
      await narrateWhile(
        "Check the calculation: sixteen hours at one hundred and fifty euros, plus ten percent tax. The final total is two thousand six hundred and forty euros.",
        async ({ sleep }) => {
          await sleep(1100);
          await page.getByRole("button", { name: "Show calculation" }).click();
        },
      );
      await chapter(titles[3]!);
      await narrateWhile(
        "Everything looks right. Approve the invoice to record your decision. The confirmation and activity log make it clear that the invoice is now ready to send.",
        async ({ sleep }) => {
          await sleep(1300);
          await page.getByRole("button", { name: "Approve invoice" }).click();
        },
      );
    },
  };
  try {
    await captureReplay({
      projectDir: dir,
      tourFile: { path: "built-in:invoice-approval", tour },
      loadedConfig: {
        projectRoot: process.cwd(),
        configPath: "built-in:invoice-approval",
        config: {
          ...DEFAULT_DEMOHUNTER_CONFIG,
          baseURL: `http://127.0.0.1:${port}`,
          outputDir: path.dirname(dir),
          cacheDir: path.resolve(".demohunter/cache"),
          viewport: { width: 1120, height: 720 },
          tts: {
            ...DEFAULT_DEMOHUNTER_CONFIG.tts,
            instructions:
              "Explain the product clearly and naturally, with a little room to read each screen.",
          },
          record: {
            ...DEFAULT_DEMOHUNTER_CONFIG.record,
            cursor: false,
            showCursor: false,
            showClickRipple: false,
          },
        },
      },
    });
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
  const bundle = await loadBundle(dir);
  bundle.narration.segments.forEach((segment, i) => {
    segment.title = titles[i];
  });
  await writeJson(path.join(dir, "narration.json"), bundle.narration);
  if (localVoice) {
    try {
      await generateLocalSampleSpeech(dir);
    } catch (error) {
      console.error(
        `Local sample voice unavailable: ${error instanceof Error ? error.message : String(error)}. Visual replay is ready; use the configured provider to generate speech.`,
      );
    }
  }
  const fitted = await loadBundle(dir);
  const workspace = await ReplayWorkspace.open(dir);
  const total = workspace.index.elements.find(
    (e) => e.attributes.id === "invoice-totals",
  );
  const calculation = fitted.narration.segments[2];
  if (total && calculation) {
    const start = clipStart(fitted.edits, calculation.clipId)!;
    fitted.edits.camera.push({
      id: "review-total",
      startMs: start + 1600,
      endMs: start + 6500,
      target: { ref: total.ref },
      scale: 1.2,
    });
    fitted.edits.highlights.push({
      id: "total-highlight",
      startMs: start + 2000,
      endMs: start + 6000,
      target: { ref: total.ref },
      color: "#7189e6",
      padding: 10,
    });
    await writeJson(path.join(dir, "edits.json"), fitted.edits);
  }
  return dir;
}

// Sample-only speech makes the walkthrough audible without a hosted provider.
// Its provenance remains explicit; normal regeneration still uses configured TTS.
export async function generateLocalSampleSpeech(dir: string): Promise<void> {
  const bundle = await loadBundle(dir);
  const temp = await mkdtemp(path.join(tmpdir(), "demohunter-local-speech-"));
  await mkdir(path.join(dir, "audio"), { recursive: true });
  try {
    for (const segment of bundle.narration.segments) {
      const hash = createHash("sha256")
        .update(`flite:slt:sample-v1:${segment.text}`)
        .digest("hex");
      const relative = `audio/sample-${hash.slice(0, 20)}.wav`,
        audioPath = path.join(dir, relative);
      let durationMs: number;
      try {
        durationMs = await measureNarrationAudioDuration(audioPath);
      } catch {
        await writeFile(path.join(temp, "narration.txt"), segment.text);
        await run(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "flite=textfile=narration.txt:voice=slt",
            "-ar",
            "24000",
            "-y",
            audioPath,
          ],
          temp,
        );
        durationMs = await measureNarrationAudioDuration(audioPath);
      }
      segment.audio = {
        path: relative,
        durationMs,
        cacheKey: `local-demo-${hash}`,
        requestKey: narrationRequestKey(bundle.project, segment),
        origin: "local-demo",
      };
      const clip = bundle.edits.clips.find((c) => c.id === segment.clipId)!;
      clip.holdMs += Math.max(
        0,
        segment.offsetMs + durationMs + 600 - clipDuration(clip),
      );
    }
    await writeJson(path.join(dir, "narration.json"), bundle.narration);
    await writeJson(path.join(dir, "edits.json"), bundle.edits);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk) => {
      error = (error + chunk.toString()).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(error || `${command} exited with ${code}`)),
    );
  });
}
