import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./git.js";

/**
 * "Create new demo": the person describes a demo and their own agent makes
 * it — writes a tour, records it as a Studio demo — while the New demo page
 * shows the tour's storyboard as it is written and the demo once captured.
 * Studio only briefs the agent and watches files; the agent does the work.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(["node_modules", ".git", ".demohunter", "dist", "build", ".next", ".turbo", "target", "vendor", ".venv", "venv", "coverage"]);

/** Files under `root` whose name passes `test` (git's list when it is a
 * repository; otherwise a bounded walk). Relative paths. */
async function find(root: string, patterns: string[], test: (name: string) => boolean): Promise<string[]> {
  const listed = await listFiles(root, patterns);
  if (listed) return listed.filter((f) => test(path.basename(f)) && !f.split("/").some((p) => SKIP.has(p)));
  const found: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || visited > 5000) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    visited += entries.length;
    await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !SKIP.has(e.name) && !e.isSymbolicLink()) await walk(full, depth + 1);
        else if (e.isFile() && test(e.name)) found.push(path.relative(root, full));
      }),
    );
  };
  await walk(root, 0);
  return found.sort();
}

export type StoryItem = { kind: "chapter" | "step" | "narrate" | "visit"; text: string };
export type TourDraft = {
  path: string;
  modifiedAt: string;
  id?: string;
  title?: string;
  items: StoryItem[];
};

/** A quoted string literal; `n` is the number of its quote's group. */
const string = (n: number) => `(["'\x60])((?:\\\\.|(?!\\${n})[^\\\\]){1,600})\\${n}`;
const CALL = new RegExp(String.raw`\b(chapter|step|narrateWhile|narrate|goto)\(\s*${string(2)}`, "g");
const unquote = (text: string) => text.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();

/** What a tour will show, in order, read from its source text: chapters,
 * steps, narration lines and page visits. Text only; never run. */
export function storyboard(source: string): Omit<TourDraft, "path" | "modifiedAt"> {
  const id = /\bid:\s*["'`]([a-z0-9-]{1,100})["'`]/.exec(source)?.[1];
  const title = new RegExp(String.raw`\btitle:\s*${string(1)}`).exec(source)?.[2];
  const items: StoryItem[] = [];
  for (const m of source.matchAll(CALL)) {
    if (items.length >= 200) break;
    const name = m[1]!;
    items.push({ kind: name === "narrateWhile" ? "narrate" : name === "goto" ? "visit" : (name as StoryItem["kind"]), text: unquote(m[3]!).slice(0, 400) });
  }
  return { ...(id ? { id } : {}), ...(title ? { title: unquote(title).slice(0, 200) } : {}), items };
}

async function head(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Tours written or changed since `sinceMs` (newest first, at most three),
 * with their storyboards. */
export async function recentTours(root: string, sinceMs: number): Promise<TourDraft[]> {
  const files = await find(root, ["*.tour.ts"], (n) => n.endsWith(".tour.ts"));
  const dated = (
    await Promise.all(
      files.map(async (f) => {
        const info = await stat(path.join(root, f)).catch(() => undefined);
        return info?.isFile() && info.mtimeMs >= sinceMs ? { f, at: info.mtimeMs } : undefined;
      }),
    )
  )
    .filter((x): x is { f: string; at: number } => !!x)
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  return Promise.all(
    dated.map(async ({ f, at }) => ({
      path: f,
      modifiedAt: new Date(at).toISOString(),
      ...storyboard(await head(path.join(root, f), 256_000).catch(() => "")),
    })),
  );
}

const shellQuote = (arg: string) => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** What Studio tells the agent on the New demo page, ahead of the person's
 * words: where to work, how a DemoHunter demo is made and recorded, and the
 * exact capture command for this Studio. */
export async function creationBrief(root: string, place: { name: string; branch?: string }): Promise<string> {
  const [configs, tours] = await Promise.all([
    find(root, ["demohunter.config.ts", "*/demohunter.config.ts"], (n) => n === "demohunter.config.ts"),
    find(root, ["*.tour.ts"], (n) => n.endsWith(".tour.ts")),
  ]);
  const cli = path.join(here, "cli.ts");
  const guide = path.resolve(here, "../../packages/cli/skills/demohunter/references/authoring.md");
  const template = path.resolve(here, "../../packages/cli/skills/demohunter/assets/tour.template.ts");
  const replaySkill = path.resolve(here, "../../.agents/skills/demohunter-replay/SKILL.md");
  const capture = `${shellQuote(process.execPath)} ${shellQuote(cli)} capture <tour file> --project .demohunter/replays/<tour id>`;
  const lines = [
    "[DemoHunter Studio — context added by Studio]",
    `The person is on DemoHunter Studio's "New demo" page and wants you to create a new demo, working in ${root} (${place.name}${place.branch ? ` · ${place.branch}` : ""}). Studio shows your progress live beside this chat: the tour's chapters, steps and narration as you write the file, then the recording, then the finished demo.`,
    "",
    "How a DemoHunter demo is made:",
    "1. Understand the product and the flow they describe: read the app's code and docs (routes, page structure, accessible names), how it runs locally and on which URL.",
    configs.length
      ? `2. Configuration: demohunter.config.ts sets baseURL, viewport and narration voice. Found: ${configs.slice(0, 5).join(", ")}. Use the one for the app the demo shows.`
      : '2. Configuration: there is no demohunter.config.ts yet. Create one in the folder of the app the demo shows: `export default { baseURL: "<the app\'s local URL>" };` (a plain object; add viewport `{ width: 1440, height: 900 }` if useful).',
    `3. Write ONE tour file, \`<tour id>.tour.ts\` (id: lowercase-kebab-case, unique), ${tours.length ? `next to the existing tours (e.g. ${tours.slice(0, 4).join(", ")}; read one first and follow its helpers and login)` : "in a `demos/` folder beside the config"}. A tour is Playwright: \`beforeRecord\` gets to the starting state (log in, open the page) off camera; \`run\` is what the viewer sees, built from \`chapter("…")\`, \`step("…", async () => …)\`, \`narrate("…")\` and \`narrateWhile("…", async () => …)\` around normal page actions.${existsSync(guide) ? ` Read the authoring guide first: ${guide}${existsSync(template) ? `; starter: ${template}` : ""}.` : ""} If the project doesn't depend on the \`demohunter\` package, don't import it: default export a plain object \`{ id, title, beforeRecord, run }\` (defineTour only returns its argument). Narration: short, plain sentences about what is on screen; real product names and copy only, nothing invented.`,
    "4. Make sure the app answers at baseURL. If it isn't running, start its dev server in the background and leave it running.",
    `5. Record it as an editable Studio demo (a DOM capture in a headless browser: no video, no API key), from the config's folder:\n   ${capture}\n   It plays the tour twice and takes a while. If it fails, fix the tour (selectors, waits, login) and run it again; a --project folder that exists is refused, so remove a failed one you created first.`,
    "6. When it is captured Studio shows it here and the person opens it in the editor. Reply with a one- or two-line summary. Narration stays a draft (no audio) until they generate it in Studio.",
    "",
    `Don't commit. Keep replies short: the person watches the demo take shape and sees your tool calls.${existsSync(replaySkill) ? ` For editing a captured demo later: ${replaySkill}.` : ""}`,
  ];
  return lines.join("\n");
}

/** Captures under way since `sinceMs`: replay folders that capture has made
 * but not finished (no project.json yet), beside each config. */
export async function capturesInProgress(root: string, sinceMs: number): Promise<string[]> {
  const configs = await find(root, ["demohunter.config.ts", "*/demohunter.config.ts"], (n) => n === "demohunter.config.ts");
  const bases = [...new Set(["", ...configs.map((c) => path.dirname(c)).map((d) => (d === "." ? "" : d))])];
  const found: string[] = [];
  for (const base of bases) {
    const replays = path.join(root, base, ".demohunter", "replays");
    for (const entry of await readdir(replays, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(replays, entry.name);
      const info = await stat(dir).catch(() => undefined);
      if (!info || info.birthtimeMs < sinceMs) continue;
      if (!existsSync(path.join(dir, "project.json"))) found.push(path.relative(root, dir));
    }
  }
  return found;
}
