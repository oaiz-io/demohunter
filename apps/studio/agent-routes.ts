import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  AgentHub,
  readAgentSettings,
  unsafeMode,
  updateAgentSettings,
  type AgentMessage,
} from "./agents.js";
import type { LocalLibrary } from "./library.js";
import { loadBundle } from "./storage.js";
import { scenesTrusted } from "./trust.js";

const run = promisify(execFile);
const branches = new Map<string, { at: number; branch?: string }>();
/** The worktree's branch, read-only and cached briefly (the panel polls). */
async function branchOf(root: string): Promise<string | undefined> {
  const cached = branches.get(root);
  if (cached && Date.now() - cached.at < 10_000) return cached.branch;
  let branch: string | undefined;
  try {
    const { stdout } = await run("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000 });
    branch = stdout.trim() || undefined;
  } catch {}
  branches.set(root, { at: Date.now(), branch });
  return branch;
}

/** HTTP surface of the in-Studio agents (library service, same origin). */
export async function handleAgentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  library: LocalLibrary,
  hub: AgentHub,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/agents")) return false;
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  // Agents run code: only same-origin JSON requests reach them (a cross-site
  // form can't send application/json without a CORS preflight, which fails).
  if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? ""))
    return json({ error: "Expected application/json." }, 415), true;
  try {
    // Which worktree a demo belongs to decides where its agents run.
    const where = async (project: unknown) => {
      if (typeof project !== "string") throw new Error("Missing project.");
      const dir = await library.resolve(project);
      const root = library.rootOf(dir) ?? library.root;
      return { dir, root, trusted: scenesTrusted(root) };
    };
    if (req.method === "GET" && url.pathname === "/api/agents") {
      const { root, trusted } = await where(url.searchParams.get("project"));
      return (
        json({
          root,
          // Where agents run: the repository checkout or worktree of this demo.
          // Restricted folders get no git calls.
          place: { name: path.basename(root), ...(trusted ? { branch: await branchOf(root) } : {}) },
          trusted,
          kinds: hub.kinds(),
          sessions: hub.list(root),
          settings: await readAgentSettings(root),
        }),
        true
      );
    }
    if (req.method === "POST" && url.pathname === "/api/agents/start") {
      const input = z
        .object({ project: z.string(), kind: z.enum(["claude", "codex"]) })
        .parse(await body(req));
      const { root, trusted } = await where(input.project);
      const settings = await readAgentSettings(root);
      return (
        json(
          await hub.start(input.kind, root, !trusted, {
            model: settings.models[input.kind],
            mode: settings.modes[input.kind],
          }),
        ),
        true
      );
    }
    if (req.method === "POST" && url.pathname === "/api/agents/settings") {
      const input = z
        .object({
          project: z.string(),
          autoSendNotes: z.boolean(),
          agent: z.enum(["claude", "codex"]),
        })
        .parse(await body(req));
      const { root } = await where(input.project);
      await updateAgentSettings(root, (settings) => {
        settings.autoSendNotes = input.autoSendNotes;
        settings.agent = input.agent;
      });
      return json({ ok: true }), true;
    }
    if (req.method === "POST" && url.pathname === "/api/agents/terminal") {
      const input = z
        .object({
          project: z.string(),
          kind: z.enum(["claude", "codex"]),
          purpose: z.enum(["signin", "run"]),
          // Model ids like "opus[1m]"; the terminal line quotes every argument.
          model: z.string().max(200).regex(/^[\w.:[\]-]+$/).optional(),
        })
        .strict()
        .parse(await body(req));
      const { root, trusted } = await where(input.project);
      return json(await hub.terminal(input.kind, root, !trusted, input.purpose, input.model)), true;
    }
    const match = /^\/api\/agents\/([0-9a-f-]{36})\/(stream|prompt|permission|option|cancel|stop)$/.exec(
      url.pathname,
    );
    if (!match) return json({ error: "Not found." }, 404), true;
    const session = hub.get(match[1]!);
    const action = match[2]!;
    if (req.method === "GET" && action === "stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send({ type: "snapshot", status: session.status, events: session.events, options: session.options });
      const unsubscribe = session.subscribe((message: AgentMessage) => send(message));
      const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
      return true;
    }
    if (req.method !== "POST") return json({ error: "Not found." }, 404), true;
    if (action === "prompt") {
      const input = z
        .object({
          text: z.string().trim().min(1).max(20_000),
          project: z.string(),
          outputMs: z.number().finite().nonnegative().optional(),
          selection: z
            .object({ ref: z.string().max(200).optional(), label: z.string().max(200).optional() })
            .optional(),
          notes: z.array(z.string().max(100)).max(50).optional(),
        })
        .strict()
        .parse(await body(req));
      const { dir, root } = await where(input.project);
      if (root !== session.root)
        throw new Error("This demo belongs to another worktree; start an agent there.");
      const { preamble, chips } = await context(dir, root, input);
      session.prompt(input.text, chips, preamble);
      return json({ ok: true }, 202), true;
    }
    if (action === "permission") {
      const input = z
        .object({ requestId: z.string(), optionId: z.string() })
        .parse(await body(req));
      session.answer(input.requestId, input.optionId);
      return json({ ok: true }), true;
    }
    if (action === "option") {
      const input = z
        .object({ project: z.string(), id: z.string().max(100), value: z.string().max(200) })
        .strict()
        .parse(await body(req));
      const { root } = await where(input.project);
      if (root !== session.root) throw new Error("This demo belongs to another worktree.");
      const options = await session.setOption(input.id, input.value);
      // Remembered for this worktree, so the next start uses the same model
      // and mode — except modes that stop asking, which are chosen each time.
      const option = options.find((o) => o.id === input.id);
      const choice = option?.choices.find((c) => c.value === input.value);
      if (option && choice && !(option.category === "mode" && unsafeMode(choice))) {
        const key = option.category === "model" ? "models" : "modes";
        await updateAgentSettings(root, (settings) => {
          settings[key] = { ...settings[key], [session.adapter.kind]: input.value };
        });
      }
      return json({ options }), true;
    }
    if (action === "cancel") return await session.cancel(), json({ ok: true }), true;
    session.stop();
    return json({ ok: true }), true;
  } catch (error) {
    json(
      { error: error instanceof Error ? error.message : String(error) },
      (error as { status?: number }).status ?? 400,
    );
    return true;
  }
}

/** What Studio tells the agent about the person's view, ahead of their words.
 * Built from the project on disk, so the page can't put words in Studio's mouth. */
async function context(
  dir: string,
  root: string,
  input: {
    project: string;
    outputMs?: number;
    selection?: { ref?: string; label?: string };
    notes?: string[];
  },
) {
  const bundle = await loadBundle(dir);
  const clock = (ms: number) =>
    `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${((ms / 1000) % 60).toFixed(1).padStart(4, "0")}`;
  const chips: string[] = [];
  const lines = [
    "[DemoHunter Studio — context added by Studio]",
    `Demo: "${bundle.project.title}" — project "${path.relative(root, dir) || "."}" (id ${input.project}).`,
  ];
  if (input.outputMs !== undefined) {
    lines.push(`Studio is showing ${clock(input.outputMs)}.`);
    chips.push(clock(input.outputMs));
  }
  if (input.selection?.ref) {
    // Captured page text: quoted like note bodies, so it can't pose as Studio.
    const ref = plain(input.selection.ref);
    const label = input.selection.label ? plain(input.selection.label) : undefined;
    lines.push(`Selected element: ${JSON.stringify(ref)}${label ? ` (${JSON.stringify(label)})` : ""}.`);
    chips.push(label ?? ref);
  }
  const notes = (input.notes ?? [])
    .map((id) => bundle.comments.threads.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t);
  if (notes.length) {
    lines.push("Notes to address:");
    for (const note of notes) {
      lines.push(
        `- note ${note.id} at ${clock(note.timeMs)}${note.elementRef ? ` on ${note.elementRef}` : ""}: ${JSON.stringify(note.body)}`,
      );
      chips.push(`Note: ${note.body.slice(0, 40)}${note.body.length > 40 ? "…" : ""}`);
    }
    lines.push("When a note is done, reply on it and resolve it with the DemoHunter tools.");
  }
  lines.push(
    "Use the demohunter MCP tools — they act on the demo open in Studio. Keep your replies short.",
  );
  return { preamble: lines.join("\n"), chips };
}

/** One line of text: control characters (newlines included) become spaces. */
const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();

async function body(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 100_000) throw new Error("Request is too large.");
  }
  return text ? JSON.parse(text) : {};
}
