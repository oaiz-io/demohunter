import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as playwright from "playwright";
import type { BrowserContext, Response } from "playwright";
import type { eventWithTime } from "rrweb";
import { collectTimeline } from "../../packages/generator-playwright/src/execute/collect-timeline.js";
import { replayTimeline } from "../../packages/generator-playwright/src/execute/replay-timeline.js";
import { installRecordingEffects } from "../../packages/generator-playwright/src/overlays/install-recording-effects.js";
import type { SmokeGenerateInput } from "../../packages/generator-playwright/src/smoke-generate.js";
import { writeJson } from "./storage.js";
import { ensureFormat } from "./format.js";
import { ensureElementIndex } from "./elements.js";
import {
  validateBundle,
  type Clip,
  type NarrationSegment,
  type ReplayProject,
} from "./model.js";

const require = createRequire(import.meta.url);
const rrwebPath = path.join(
  path.dirname(require.resolve("rrweb")),
  "rrweb.umd.cjs",
);
const extensions: Record<string, string> = {
  "text/css": ".css",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
};

export async function captureReplay(
  input: SmokeGenerateInput & {
    projectDir: string;
    configureContext?: (context: BrowserContext) => Promise<void>;
  },
): Promise<string> {
  const dir = path.resolve(input.projectDir);
  // Never overwrite a project with edits. Capturing again needs a new destination.
  await mkdir(dir, { recursive: false });
  await mkdir(path.join(dir, "assets"));
  const events: eventWithTime[] = [];
  const segments: NarrationSegment[] = [];
  const warnings = new Set<string>();
  const assets = new Map<
    string,
    { file: string; body: Buffer; css: boolean }
  >();
  const pending = new Set<Promise<void>>();
  const { config } = input.loadedConfig;
  const browser = await playwright[config.browser].launch();
  let startedAt: number | undefined;
  let recording = false;
  let eventCount = 0;

  const collectAsset = (response: Response): void => {
    const task = (async () => {
      const contentType = (response.headers()["content-type"] ?? "").split(
        ";",
      )[0]!;
      if (
        !response.ok() ||
        !(
          /^(image|font|audio|video)\//.test(contentType) ||
          contentType === "text/css" ||
          /\.(woff2?|ttf|otf)(\?|$)/.test(response.url())
        )
      )
        return;
      if (Number(response.headers()["content-length"] ?? 0) > 10_000_000) {
        warnings.add(
          `Asset over 10 MB was not bundled: ${new URL(response.url()).pathname}`,
        );
        return;
      }
      try {
        const body = await response.body();
        if (body.length > 10_000_000) return;
        const extension =
          extensions[contentType] ??
          (/\.(woff2?|ttf|otf)(?:\?|$)/.exec(response.url())?.[1]
            ? `.${/\.(woff2?|ttf|otf)(?:\?|$)/.exec(response.url())![1]}`
            : ".bin");
        const file = `assets/${createHash("sha256").update(response.url()).digest("hex").slice(0, 20)}${extension}`;
        assets.set(response.url(), {
          file,
          body,
          css: contentType === "text/css",
        });
      } catch {
        warnings.add(
          `Could not bundle asset: ${new URL(response.url()).pathname}`,
        );
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  try {
    const first = await browser.newContext({
      baseURL: config.baseURL,
      viewport: config.viewport,
    });
    first.on("response", collectAsset);
    await input.configureContext?.(first);
    const timeline = await collectTimeline({
      loadedConfig: input.loadedConfig,
      page: await first.newPage(),
      tourFile: input.tourFile,
      resolveNarrationSegment: (event) => ({
        text: event.text,
        durationMs: Math.max(1400, event.text.split(/\s+/).length * 360),
        audioPath: "",
        cacheKey: "draft",
      }),
    });
    await Promise.all([...pending]);
    await first.close();
    const context = await browser.newContext({
      baseURL: config.baseURL,
      viewport: config.viewport,
    });
    context.on("response", collectAsset);
    await input.configureContext?.(context);
    await installRecordingEffects(context, {
      showCursor: false,
      showClickRipple: false,
    });
    await context.exposeBinding(
      "__dhEmit",
      async ({ frame }, event: eventWithTime) => {
        if (!recording || frame !== frame.page().mainFrame()) return;
        if (++eventCount > 100_000)
          throw new Error("Replay prototype limit: 100,000 events.");
        startedAt ??= event.timestamp;
        events.push(event);
      },
    );
    const armRecorder = () => {
      const w = window as any;
      // Re-arm on full navigation, but do not capture setup/beforeRecord.
      if (sessionStorage.getItem("__dhReplayRecording") === "yes") {
        w.__dhStop = w.rrweb.record({
          emit: (event: unknown) => {
            void w.__dhEmit(event);
          },
          inlineStylesheet: true,
          inlineImages: true,
          collectFonts: true,
          maskAllInputs: true,
          recordCanvas: false,
        });
      }
    };
    // A single init script guarantees the recorder exists before re-arming on navigation.
    await context.addInitScript({
      content: `${await readFile(rrwebPath, "utf8")}\n;(${armRecorder.toString()})();`,
    });
    const page = await context.newPage();
    await replayTimeline({
      loadedConfig: input.loadedConfig,
      page,
      timeline,
      tourFile: input.tourFile,
      onBeforeRun: async () => {
        recording = true;
        await page.evaluate(() => {
          const w = window as any;
          sessionStorage.setItem("__dhReplayRecording", "yes");
          w.__dhStop = w.rrweb.record({
            emit: (event: unknown) => {
              void w.__dhEmit(event);
            },
            inlineStylesheet: true,
            inlineImages: true,
            collectFonts: true,
            maskAllInputs: true,
            recordCanvas: false,
          });
        });
      },
      onMatchedEvent: (event) => {
        if (event.kind === "narrate")
          segments.push({
            id: `narration-${segments.length + 1}`,
            clipId: "",
            offsetMs: 0,
            text: event.text,
            voice: event.voice,
            model: event.model,
            instructions: event.instructions,
            language: event.language,
            ...{
              sourceMs: Math.max(0, Date.now() - (startedAt ?? Date.now())),
            },
          });
      },
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => setTimeout(r, 150));
    });
    const durationMs = Math.max(1, Date.now() - (startedAt ?? Date.now()));
    await page.evaluate(() => {
      (window as any).__dhStop?.();
      sessionStorage.removeItem("__dhReplayRecording");
    });
    await Promise.all([...pending]);
    await context.close();
    recording = false;
    if (!events.some((event) => event.type === 2))
      throw new Error("No DOM snapshot was captured.");

    const replacements = [...assets].sort(([a], [b]) => b.length - a.length);
    const rewrite = (text: string): string =>
      replacements.reduce(
        (s, [url, asset]) => s.replaceAll(url, `/files/${asset.file}`),
        text,
      );
    for (const [url, asset] of assets) {
      let body = asset.body;
      if (asset.css) {
        const absolute = body
          .toString()
          .replace(
            /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,
            (full, _quote, value) =>
              value.startsWith("data:") || value.startsWith("#")
                ? full
                : `url("${new URL(value, url).href}")`,
          );
        body = Buffer.from(rewrite(absolute));
      }
      await writeFile(path.join(dir, asset.file), body);
    }
    const rewrittenEvents = JSON.parse(rewrite(JSON.stringify(events)));
    const sourceMarkers = segments.map(
      (s) => (s as NarrationSegment & { sourceMs: number }).sourceMs,
    );
    const boundaries = [
      ...new Set([
        0,
        ...sourceMarkers.slice(1).filter((t) => t > 0 && t < durationMs),
        durationMs,
      ]),
    ].sort((a, b) => a - b);
    const clips: Clip[] = boundaries.slice(0, -1).map((start, i) => ({
      id: `clip-${i + 1}`,
      sourceStartMs: start,
      sourceEndMs: boundaries[i + 1]!,
      rate: 1,
      holdMs: 0,
    }));
    for (const segment of segments) {
      const time =
        (segment as NarrationSegment & { sourceMs?: number }).sourceMs ?? 0;
      const clip =
        clips.find((c) => time >= c.sourceStartMs && time < c.sourceEndMs) ??
        clips.at(-1)!;
      segment.clipId = clip.id;
      segment.offsetMs = time - clip.sourceStartMs;
      delete (segment as NarrationSegment & { sourceMs?: number }).sourceMs;
    }
    const project: ReplayProject = {
      schemaVersion: 1,
      id: input.tourFile.tour.id,
      title: input.tourFile.tour.title,
      viewport: config.viewport,
      durationMs,
      createdAt: new Date().toISOString(),
      tts: config.tts,
      capture: {
        eventCount: events.length,
        assetCount: assets.size,
        warnings: [...warnings],
      },
    };
    const bundle = validateBundle({
      project,
      edits: { clips, elements: [], camera: [], highlights: [] },
      narration: { segments },
      css: "/* Persistent visual overrides for the captured page. */\n",
    });
    await Promise.all([
      writeJson(path.join(dir, "events.json"), rewrittenEvents),
      writeJson(path.join(dir, "project.json"), bundle.project),
      writeJson(path.join(dir, "edits.json"), bundle.edits),
      writeJson(path.join(dir, "narration.json"), bundle.narration),
      writeJson(path.join(dir, "comments.json"), bundle.comments),
      writeFile(path.join(dir, "overrides.css"), bundle.css),
    ]);
    // Include recorder/player dependencies with the portable project, not CDN URLs.
    await writeFile(
      path.join(dir, "assets/rrweb.js"),
      await readFile(rrwebPath),
    );
    await writeFile(
      path.join(dir, "assets/rrweb.css"),
      await readFile(path.join(path.dirname(rrwebPath), "style.css")),
    );
    await writeFile(
      path.join(dir, "AGENTS.md"),
      await readFile(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../.agents/skills/demohunter-replay/SKILL.md",
        ),
      ),
    );
    const index = await ensureElementIndex(dir);
    const format = await ensureFormat(dir, index);
    if (!input.tourFile.path.startsWith("built-in:")) {
      format.source = {
        tour: path.relative(
          input.loadedConfig.projectRoot,
          input.tourFile.path,
        ),
        config: path.relative(
          input.loadedConfig.projectRoot,
          input.loadedConfig.configPath,
        ),
      };
      await writeJson(path.join(dir, "studio.json"), format);
    }
    return dir;
  } finally {
    await browser.close();
  }
}
