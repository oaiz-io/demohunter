import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TTS_CONFIG } from "@demohunter/sdk";
import { packCapture } from "./capture-bundle.js";
import { ensureElementIndex, type ElementIndex } from "./elements.js";
import { ensureFormat } from "./format.js";
import { validateBundle, type ReplayProject } from "./model.js";
import { atomicWrite, ensureRealFolders, writeJson } from "./storage.js";

/**
 * Films without a recording (`studio new`).
 *
 * Every Studio project has a capture. A film made here gets a blank one: one
 * empty page at the film's size, with no elements. So every code path that
 * reads a capture (preview, export, library, MCP) works unchanged, and the
 * timeline holds only HTML scene clips. `hasRecording()` tells the two apart.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Duration of the blank page, in source ms. Scene clips do not use it. */
const BLANK_MS = 1000;
const STARTER_MS = 4000;

/** A project made by `new` has a capture with no recorded elements. */
export function hasRecording(index: Pick<ElementIndex, "elements">): boolean {
  return index.elements.length > 0;
}
export const NO_RECORDING =
  "This film has no recording, so it has no recorded elements. Edit scene elements with a target of {scene, selector}.";

/** `1920x1080` → {width, height}; within the project schema limits. */
export function parseSize(value = "1920x1080"): { width: number; height: number } {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value.trim());
  const width = Number(match?.[1]),
    height = Number(match?.[2]);
  if (!match || width < 100 || height < 100 || width > 8192 || height > 8192)
    throw new Error(
      "Use --size WIDTHxHEIGHT, each from 100 to 8192 (for example 1920x1080, 1080x1920 or 1080x1080).",
    );
  return { width, height };
}

/** Copy the scene kit (motion.js, show.js, show.css) into scenes/kit/. No
 * symlinked folder on the way, and atomic writes replace a link committed at
 * a kit name instead of writing through it. */
export async function installSceneKit(dir: string): Promise<string[]> {
  const target = await ensureRealFolders(dir, "scenes/kit");
  const source = path.join(here, "scene-kit");
  const names = (await readdir(source)).sort();
  for (const name of names)
    await atomicWrite(
      path.join(target, name),
      await readFile(path.join(source, name)),
    );
  return names.map((name) => `scenes/kit/${name}`);
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The blank capture: rrweb Meta and FullSnapshot events of an empty page.
 * The film's id is an attribute, so every film has its own capture id. */
function blankEvents(size: { width: number; height: number }, filmId: string) {
  const timestamp = Date.now();
  return [
    {
      type: 4,
      data: { href: "about:blank", width: size.width, height: size.height },
      timestamp,
    },
    {
      type: 2,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
            {
              type: 2,
              id: 3,
              tagName: "html",
              attributes: { "data-demohunter-film": filmId },
              childNodes: [
                { type: 2, id: 4, tagName: "head", attributes: {}, childNodes: [] },
                {
                  type: 2,
                  id: 5,
                  tagName: "body",
                  attributes: { style: "margin:0;background:#000" },
                  childNodes: [],
                },
              ],
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
      timestamp,
    },
  ];
}

function openingScene(title: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="demohunter:duration" content="${STARTER_MS}" />
    <style>
      html, body { margin: 0; width: 100%; height: 100%; }
      body {
        display: grid;
        place-items: center;
        background: #111;
        color: #f5f5f5;
        font-family: system-ui, sans-serif;
      }
      h1 { margin: 0; padding: 0 8%; font-size: 64px; font-weight: 600; text-align: center; }
    </style>
  </head>
  <body>
    <!-- A starting point. Replace it with the film's first scene. -->
    <h1 id="title">${escapeHtml(title)}</h1>
    <script type="module">
      import { animate, ease } from "./kit/motion.js";
      animate(
        document.getElementById("title"),
        [
          { opacity: 0, transform: "translateY(24px)" },
          { opacity: 1, transform: "none" },
        ],
        { at: 300, dur: 900, easing: ease.out },
      );
    </script>
  </body>
</html>
`;
}

/** The one-page plan template (research §2.2), with the title filled in. */
function planTemplate(title: string, size: { width: number; height: number }) {
  return `# ${title}

FILM:      the one thing the viewer must take away, in their words (not a slogan)
FOR:       who watches, where (feed, YouTube, a talk, a site), sound on or off
SHAPE:     length as a range · aspect (${size.width}x${size.height}) · fps · narrated / music only / silent
SPINE:     the one concrete case that runs from first frame to last
           (a user and a task; a worked example; a person or place; one dataset)
QUESTION:  what the opening makes the viewer want to know
ANSWER:    the payoff, and when it lands (usually 60–80% in)
STORYLINES: three one-liners (device × form), the pick, and why in one clause
BEATS:     # | in–out s | job (hook/turn/proof/payoff/close) | what happens
           | link to previous beat ("but…" / "therefore…") | what is read, with window
           | voice line | sound | handoff into the next beat
LOOK:      ground, ink, one accent and where it may appear (hex);
           display and body face, px, tracking; the medium and its rules
MOTION:    eases by role (enter, move, exit, camera); hold rule; 3–5 transition kinds
BANNED:    the shared defaults + anything this film must not become
FACTS:     every claim → its source; illustrative numbers marked; media licences
LOOK AT:   the times to snapshot (each beat, each cut, the payoff, frame 0)
`;
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** Create a new film project at `dir` (which must not exist). */
export async function createFilm(
  dir: string,
  options: { title?: string; size?: string } = {},
) {
  const size = parseSize(options.size);
  const projectDir = path.resolve(dir);
  const title = options.title?.trim() || path.basename(projectDir);
  if (title.length > 200) throw new Error("Keep the title under 200 characters.");
  await mkdir(path.dirname(projectDir), { recursive: true });
  // Never overwrite a project: like capture, the destination must be new.
  try {
    await mkdir(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `${projectDir} already exists. Choose a new project folder.`,
      );
    throw error;
  }
  try {
    const project: ReplayProject = {
      schemaVersion: 1,
      id: slug(path.basename(projectDir)) || slug(title) || "film",
      title,
      viewport: size,
      durationMs: BLANK_MS,
      createdAt: new Date().toISOString(),
      tts: { ...DEFAULT_TTS_CONFIG, instructions: "Speak clearly and naturally." },
      capture: { eventCount: 2, assetCount: 0, warnings: [] },
    };
    const bundle = validateBundle({
      project,
      edits: {
        clips: [
          {
            id: "opening",
            kind: "scene",
            src: "scenes/opening.html",
            durationMs: STARTER_MS,
            title: "Opening",
          },
        ],
        elements: [],
        camera: [],
        highlights: [],
      },
      narration: { segments: [] },
      css: "/* Persistent styles for the blank page under the scenes. */\n",
    });
    const events = Buffer.from(
      `${JSON.stringify(blankEvents(size, randomUUID()), null, 2)}\n`,
    );
    const captureHash = createHash("sha256").update(events).digest("hex");
    // No recorded elements: written before indexing, so the blank page's
    // <html> and <body> are not offered as editable recording elements.
    const index: ElementIndex = {
      schemaVersion: 1,
      captureId: captureHash.slice(0, 16),
      captureHash,
      elements: [],
    };
    await Promise.all([
      writeFile(path.join(projectDir, "events.json"), events),
      writeJson(path.join(projectDir, "elements.json"), index),
      writeJson(path.join(projectDir, "project.json"), bundle.project),
      writeJson(path.join(projectDir, "edits.json"), bundle.edits),
      writeJson(path.join(projectDir, "narration.json"), bundle.narration),
      writeJson(path.join(projectDir, "comments.json"), bundle.comments),
      writeFile(path.join(projectDir, "overrides.css"), bundle.css),
      writeFile(path.join(projectDir, "PLAN.md"), planTemplate(title, size)),
      readFile(
        path.resolve(here, "../../.agents/skills/demohunter-replay/SKILL.md"),
      ).then((guide) => writeFile(path.join(projectDir, "AGENTS.md"), guide)),
    ]);
    await ensureFormat(projectDir, await ensureElementIndex(projectDir, false));
    const capture = await packCapture(projectDir);
    const kit = await installSceneKit(projectDir);
    await writeFile(
      path.join(projectDir, "scenes/opening.html"),
      openingScene(title),
    );
    return {
      projectDir,
      title,
      size,
      captureId: capture.captureId,
      files: [
        "studio.json",
        "capture.dhcapture",
        "project.json",
        "edits.json",
        "narration.json",
        "comments.json",
        "overrides.css",
        "PLAN.md",
        "AGENTS.md",
        "scenes/opening.html",
        ...kit,
      ],
      next: [
        `Fill in ${path.join(projectDir, "PLAN.md")}`,
        `bun run studio kit ${projectDir} --mood calm`,
        `bun run studio sheet ${projectDir}`,
        `bun run studio export ${projectDir} --output <new-directory>`,
        "bun run studio",
      ],
    };
  } catch (error) {
    // A failed create must not leave a half-written project behind.
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
