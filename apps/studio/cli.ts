import { LocalLibrary } from "./library.js";
import { serveLibrary } from "./library-server.js";
import { exportReplay } from "./export.js";
import { contract } from "./contract.js";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../packages/cli/src/config/load-config.js";
import { loadAuthoredModule } from "../../packages/cli/src/utils/load-authored-module.js";
import { captureReplay } from "./capture.js";
import { createDemo } from "./demo.js";
import { regenerateNarration } from "./narration.js";
import { serveReplay } from "./server.js";
import { loadBundle } from "./storage.js";
import { totalDuration, audioIsCurrent } from "./model.js";
import type { DemoHunterTour } from "@demohunter/sdk";
import { runReplayMcp } from "./mcp.js";
import { ReplayWorkspace } from "./workspace.js";
import { createInvoiceDemo } from "./invoice-demo.js";

const help = `DemoHunter Studio — local-first recording workspace

bun run studio [library] [workspace-directory] [--port 4310]
bun run studio export <project-dir> --output <new-directory> [--fps 24] [--strict-audio]
bun run studio list [workspace-directory]    JSON library discovery for agents/CI
bun run studio contract

bun run replay demo [--sample invoices|fractions] [--project <dir>] [--port 4310]
bun run replay capture <tour.ts> [--project <new-dir>]
bun run replay open <project-dir> [--port 4310] [--host 127.0.0.1]
bun run replay narrate <project-dir> [--fit] [--cache-dir <dir>]
bun run replay inspect <project-dir>
bun run replay mcp <project-dir>    Start the agent-facing stdio MCP server
bun run replay resolve <project-dir> <element-link>

Capture uses draft narration timing and needs no API key. Narrate explicitly
uses the project's TTS settings, environment credentials, and existing cache.
Edit edits.json, narration.json, overrides.css, or project.json while open.
Saved replays can be exported without the source application.`;

export async function main(args: string[]): Promise<void> {
  const [command = "library", ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(help);
    return;
  }
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
  if (command === "library") {
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
    await open(dir, port, flags.get("host"));
    return;
  }
  if (!positions[0] || positions.length > (command === "resolve" ? 2 : 1))
    throw new Error(help);
  const target = path.resolve(positions[0]);
  if (command === "mcp") {
    await runReplayMcp(target);
    return;
  }
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
      // Machine-readable progress for the library's record dialog.
      onProgress: (step) => console.error(`studio:step ${step}`),
    });
    console.log(
      `Captured editable replay: ${dir}\nPreview: bun run replay open ${JSON.stringify(dir)}`,
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
            onProgress: (message) => console.error(message),
          },
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "open") {
    await open(target, port, flags.get("host"));
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
async function open(dir: string, port: number, host?: string): Promise<void> {
  const preview = await serveReplay(dir, { port, host });
  console.log(
    `\nReplay editor: ${preview.url}\nProject files: ${preview.projectDir}\nAgent guide: .agents/skills/demohunter-replay/SKILL.md\nKeep this process running. Changes to project files reload automatically.`,
  );
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
