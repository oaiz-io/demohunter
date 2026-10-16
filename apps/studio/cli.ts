import { LocalLibrary } from "./library.js";
import { serveLibrary } from "./library-server.js";
import { exportReplay } from "./export.js";
import { contract } from "./contract.js";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { renderKit } from "./sound/score.js";
import { liftElement } from "./lift.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../packages/cli/src/config/load-config.js";
import { loadAuthoredModule } from "../../packages/cli/src/utils/load-authored-module.js";
import { captureReplay } from "./capture.js";
import { createDemo } from "./demo.js";
import { regenerateNarration } from "./narration.js";
import { loadBundle } from "./storage.js";
import { totalDuration, audioIsCurrent } from "./model.js";
import type { DemoHunterTour } from "@demohunter/sdk";
import { runReplayMcp } from "./mcp.js";
import { ReplayWorkspace } from "./workspace.js";
import { createInvoiceDemo } from "./invoice-demo.js";

const help = `DemoHunter Studio — local-first demo workspace

bun run studio [workspace-directory] [--port 4310] [--host 127.0.0.1]
    Open Studio with every demo in the workspace (default: current directory).

bun run studio capture <tour.ts> [--project <new-dir>]
bun run studio demo [--sample invoices|fractions] [--project <new-dir>]
bun run studio narrate <project-dir> [--fit] [--cache-dir <dir>]
bun run studio inspect <project-dir>
bun run studio kit <project-dir> [--mood calm|bright|cinematic] [--seed 1]
    Add the scene kit (scenes/kit/: motion.js, show.js, show.css) and a license-free
    score with matching sound effects (audio/score-<mood>.wav, audio/sfx/).
bun run studio lift <project-dir> --at <output-ms> (--ref <element-ref> | --selector <css>) --name <name>
    Copy a recorded element, as it looks then, into scenes/lifts/<name>.html
    so a scene can pick it up from the page and animate it.
bun run studio export <project-dir> --output <new-directory> [--fps 24] [--strict-audio]
    [--lufs -16] [--crf 18] [--workers 4]   (YouTube: --fps 30 --lufs -14 --crf 16)
bun run studio list [workspace-directory]    JSON library discovery for agents/CI
bun run studio mcp [workspace-directory]     Agent-facing stdio MCP server; edits
    the demo open in Studio (or one passed as \`project\`). A project directory
    binds it to that demo only.
bun run studio resolve <project-dir> <element-link>
bun run studio contract

Capture uses draft narration timing and needs no API key. Narrate explicitly
uses the project's TTS settings, environment credentials, and existing cache.
Saved demos can be exported without the source application.`;

const commands = new Set([
  "capture",
  "demo",
  "narrate",
  "inspect",
  "export",
  "list",
  "mcp",
  "resolve",
  "contract",
  "kit",
  "lift",
]);

export async function main(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "help") {
    console.log(help);
    return;
  }
  // Anything that is not a command opens Studio: `bun run studio [workspace]`.
  const [command, ...rest] = commands.has(args[0] ?? "")
    ? args
    : ["studio", ...args];
  const positions: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i]!;
    if (["--fit", "--strict-audio"].includes(value)) {
      flags.set(value.slice(2), "true");
      continue;
    }
    if (value.startsWith("--")) {
      if (
        ![
          "--project",
          "--port",
          "--host",
          "--cache-dir",
          "--sample",
          "--output",
          "--fps",
          "--mood",
          "--seed",
          "--lufs",
          "--crf",
          "--workers",
          "--at",
          "--ref",
          "--selector",
          "--name",
        ].includes(value) ||
        !rest[i + 1] ||
        rest[i + 1]!.startsWith("--")
      )
        throw new Error(`Unknown or incomplete flag: ${value}`);
      flags.set(value.slice(2), rest[++i]!);
    } else positions.push(value);
  }
  const port = Number(flags.get("port") ?? 4310);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be an integer from 0 to 65535.");
  if (command === "contract") {
    console.log(JSON.stringify(contract, null, 2));
    return;
  }
  if (command === "list") {
    console.log(
      JSON.stringify(
        await (await LocalLibrary.open(positions[0] ?? process.cwd())).scan(),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "studio") {
    if (positions.length > 1) throw new Error(help);
    const app = await serveLibrary(positions[0] ?? process.cwd(), {
      port,
      host: flags.get("host"),
    });
    console.log(
      `DemoHunter Studio: ${app.url}\nWorkspace: ${app.library.root}\nNo account or hosted service required.`,
    );
    return;
  }
  if (command === "demo") {
    const dir = path.resolve(
      flags.get("project") ??
        `.demohunter/replays/${flags.get("sample") ?? "invoices"}-${Date.now()}`,
    );
    await mkdir(path.dirname(dir), { recursive: true });
    const sample = flags.get("sample") ?? "invoices";
    if (!["invoices", "fractions"].includes(sample))
      throw new Error("Choose --sample invoices or --sample fractions.");
    console.log(`Capturing ${sample} as DOM events (no video)…`);
    if (sample === "fractions") await createDemo(dir);
    else await createInvoiceDemo(dir);
    console.log(`Created ${dir}\nOpen Studio: bun run studio`);
    return;
  }
  if (command === "mcp") {
    if (positions.length > 1) throw new Error(help);
    await runReplayMcp(positions[0] ?? process.cwd());
    return;
  }
  if (!positions[0] || positions.length > (command === "resolve" ? 2 : 1))
    throw new Error(help);
  const target = path.resolve(positions[0]);
  if (command === "resolve") {
    if (!positions[1]) throw new Error(help);
    console.log(
      JSON.stringify(
        await (await ReplayWorkspace.open(target)).resolve(positions[1]),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "capture") {
    const loadedConfig = await loadConfig(process.cwd());
    const loaded = await loadAuthoredModule(target);
    const tour = loaded.default as DemoHunterTour;
    if (
      !tour ||
      typeof tour.run !== "function" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tour.id)
    )
      throw new Error(
        "Expected a default-exported DemoHunter tour with a safe id and run function.",
      );
    const dir = path.resolve(
      flags.get("project") ?? `.demohunter/replays/${tour.id}-${Date.now()}`,
    );
    await mkdir(path.dirname(dir), { recursive: true });
    await captureReplay({
      loadedConfig,
      tourFile: { path: target, tour },
      projectDir: dir,
    });
    console.log(
      `Captured editable replay: ${dir}\nOpen Studio: bun run studio`,
    );
    return;
  }
  if (command === "export") {
    console.log(
      JSON.stringify(
        await exportReplay(
          target,
          flags.get("output") ??
            `.demohunter/exports/${path.basename(target)}-${Date.now()}`,
          {
            fps: Number(flags.get("fps") ?? 24),
            strictAudio: flags.has("strict-audio"),
            lufs: flags.has("lufs") ? Number(flags.get("lufs")) : undefined,
            crf: flags.has("crf") ? Number(flags.get("crf")) : undefined,
            workers: flags.has("workers")
              ? Number(flags.get("workers"))
              : undefined,
            onProgress: (message) => console.error(message),
          },
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "narrate") {
    console.log(
      await regenerateNarration(target, {
        fit: flags.has("fit"),
        cacheDir: flags.get("cache-dir"),
        onProgress: console.log,
      }),
    );
    return;
  }
  if (command === "lift") {
    console.log(
      JSON.stringify(
        await liftElement(target, {
          atMs: Number(flags.get("at")),
          ref: flags.get("ref"),
          selector: flags.get("selector"),
          name: flags.get("name") ?? "",
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "kit") {
    const bundle = await loadBundle(target);
    const mood = flags.get("mood") ?? "calm";
    if (!["calm", "bright", "cinematic"].includes(mood))
      throw new Error("Choose --mood calm, bright or cinematic.");
    const seed = Number(flags.get("seed") ?? 1);
    // The whole kit: motion.js (timing) and show.js/show.css (proven moves).
    await mkdir(path.join(target, "scenes/kit"), { recursive: true });
    const kitDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "scene-kit",
    );
    for (const name of await readdir(kitDir))
      await copyFile(
        path.join(kitDir, name),
        path.join(target, "scenes/kit", name),
      );

    // Music resolves on the tonic at the end of the edited timeline.
    const total = Math.round(totalDuration(bundle.edits));
    const work = await mkdtemp(path.join(target, ".kit-"));
    try {
      const kit = await renderKit(work, {
        durationMs: total + 1500,
        endingMs: total,
        mood: mood as "calm",
        seed,
      });
      await mkdir(path.join(target, "audio/sfx"), { recursive: true });
      await rename(
        path.join(work, "music.wav"),
        path.join(target, `audio/score-${mood}.wav`),
      );
      await rename(
        path.join(work, "cues.json"),
        path.join(target, `audio/score-${mood}.cues.json`),
      );
      for (const name of await readdir(path.join(work, "sfx")))
        await rename(
          path.join(work, "sfx", name),
          path.join(target, "audio/sfx", name),
        );
      console.log(
        JSON.stringify(
          {
            music: `audio/score-${mood}.wav`,
            cues: `audio/score-${mood}.cues.json`,
            sfx: (await readdir(path.join(target, "audio/sfx"))).map(
              (n) => `audio/sfx/${n}`,
            ),
            kit: "scenes/kit/motion.js",
            key: kit.key,
            bpm: kit.bpm,
          },
          null,
          2,
        ),
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return;
  }
  if (command === "inspect") {
    const bundle = await loadBundle(target);
    let selection: unknown = null;
    try {
      selection = JSON.parse(
        await readFile(path.join(target, "selection.json"), "utf8"),
      );
    } catch {
      /* No element selected yet. */
    }
    console.log(
      JSON.stringify(
        {
          projectDir: target,
          title: bundle.project.title,
          durationMs: totalDuration(bundle.edits),
          clips: bundle.edits.clips,
          selectedElement: selection,
          narration: bundle.narration.segments.map((segment) => ({
            id: segment.id,
            text: segment.text,
            status: !segment.audio
              ? "draft"
              : audioIsCurrent(bundle.project, segment)
                ? "ready"
                : "stale",
          })),
          warnings: bundle.project.capture.warnings,
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(help);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
