import { fileURLToPath } from "node:url";
import { projectPoster } from "./poster.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { LocalLibrary } from "./library.js";
import { SeenDemos } from "./seen.js";
import { AgentHub } from "./agents.js";
import { handleAgentRoute } from "./agent-routes.js";
import { hostAllowed, restrictFolder } from "./trust.js";
import { createReplayHandler } from "./server.js";
import { contract } from "./contract.js";
import { fontFile } from "./fonts.js";
import { randomUUID } from "node:crypto";
import { loadBundle } from "./storage.js";
import {
  clearStudioSession,
  libraryProjectId,
  writeStudioSession,
} from "./workspace.js";
/** A tab that has not polled for this long no longer counts as viewing.
 * Hidden tabs may poll only once a minute under browser throttling. */
const VIEWER_TIMEOUT_MS = 90_000,
  SESSION_HEARTBEAT_MS = 15_000;
export async function serveLibrary(
  root: string,
  options: {
    port?: number;
    host?: string;
    /** Opened without being trusted (desktop app): scene scripts stay off. */
    restricted?: boolean;
  } = {},
) {
  const library = await LocalLibrary.open(root);
  if (options.restricted) restrictFolder(library.root);
  // Start scanning, but serve right away: the page shows and fills in.
  void library.scan().catch(() => {});
  const seen = new SeenDemos(library.root);
  // Coding agents the person starts from the editor (one per worktree).
  const agents = new AgentHub();
  const here = path.dirname(fileURLToPath(import.meta.url)),
    html = await readFile(path.join(here, "web/library.html")),
    css = await readFile(path.join(here, "web/library.css"));
  const bundle = async (entry: string) =>
    (
      await build({
        entryPoints: [path.join(here, entry)],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
      })
    ).outputFiles[0]!.contents;
  const js = await bundle("web/library-app.ts");
  // New demo: a chat with the person's agent and the demo taking shape.
  const newDemo = {
    html: await readFile(path.join(here, "web/new.html")),
    js: await bundle("web/new-app.ts"),
    css: Buffer.concat([await readFile(path.join(here, "web/style.css")), await readFile(path.join(here, "web/new.css"))]),
  };
  // Record which demo the person is viewing so the workspace MCP server edits
  // that one. Opening a demo or acting in it (any POST except the periodic
  // preview-state) claims focus; status polls keep the claim alive.
  const serverId = randomUUID();
  const viewers = new Map<
    string,
    { dir: string; host: string; seen: number; claimed: number }
  >();
  const sessionRoots = new Set<string>();
  let sessionOwner: string | undefined;
  let shown: string | undefined,
    shownAt = 0,
    writing = Promise.resolve();
  const noteViewer = (id: string, dir: string, claim: boolean, host = "") => {
    const now = Date.now();
    const viewer = viewers.get(id) ?? { dir, host, seen: 0, claimed: 0 };
    viewer.seen = now;
    viewer.host = host || viewer.host;
    if (claim) viewer.claimed = now;
    viewers.set(id, viewer);
    for (const [key, v] of viewers)
      if (now - v.seen > VIEWER_TIMEOUT_MS) viewers.delete(key);
    const best = Math.max(...[...viewers.values()].map((v) => v.claimed));
    const next =
      shown && viewers.get(shown)?.claimed === best
        ? shown
        : [...viewers.entries()]
            .filter(([, v]) => v.claimed === best)
            .sort((a, b) => b[1].seen - a[1].seen)[0]![0];
    if (next === shown && now - shownAt < SESSION_HEARTBEAT_MS) return;
    shown = next;
    shownAt = now;
    const target = viewers.get(next)!;
    // The opened folder and the worktree that owns the demo both record it,
    // so an agent connected in either one edits the demo on screen.
    const owner = library.rootOf(target.dir) ?? library.root;
    const previous = sessionOwner;
    sessionOwner = owner;
    writing = writing
      .then(async () => {
        // The worktree that held the previous demo must not keep pointing
        // its agents at a demo that is no longer on screen.
        if (previous && previous !== owner && previous !== library.root)
          await clearStudioSession(previous, serverId);
        const title = await loadBundle(target.dir)
          .then((b) => b.project.title)
          .catch(() => path.basename(target.dir));
        for (const root of new Set([library.root, owner])) {
          const projectDir = path.relative(root, target.dir) || ".";
          sessionRoots.add(root);
          await writeStudioSession(root, {
            protocolVersion: 1,
            projectDir,
            projectId:
              root === library.root
                ? next
                : libraryProjectId(projectDir === "." ? "" : projectDir),
            title,
            url: target.host
              ? `http://${target.host}/projects/${next}/`
              : undefined,
            updatedAt: new Date().toISOString(),
            serverId,
          });
        }
      })
      .catch(() => {});
  };
  const handlers = new Map<
    string,
    Promise<Awaited<ReturnType<typeof createReplayHandler>>>
  >();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
    );
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (data: string | Uint8Array, type: string, status = 200) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(data);
    };
    try {
      if (!hostAllowed(req, options.host))
        return send(JSON.stringify({ error: "Unknown host." }), "application/json", 421);
      if (req.headers["sec-fetch-site"] === "cross-site" && req.headers["sec-fetch-mode"] !== "navigate")
        return send(JSON.stringify({ error: "Cross-site requests are disabled." }), "application/json", 403);
      // Every worktree of a restricted project is restricted, including ones
      // found after start (posters render before a demo is opened).
      if (options.restricted) for (const r of library.roots) restrictFolder(r);
      if (req.method === "POST" && !url.pathname.startsWith("/projects/")) {
        // Library write endpoints may only be called from this app.
        const origin = req.headers.origin;
        if (
          (origin && new URL(origin).host !== req.headers.host) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return send(
            JSON.stringify({ error: "Cross-origin writes are disabled." }),
            "application/json",
            403,
          );
      }
      if (req.method === "GET" && url.pathname.startsWith("/fonts/")) {
        const font = fontFile(url.pathname.slice("/fonts/".length));
        if (!font)
          return send(
            JSON.stringify({ error: "Not found" }),
            "application/json",
            404,
          );
        return send(await font, "font/woff2");
      }
      if (req.method === "GET" && url.pathname === "/")
        return send(html, "text/html");
      if (req.method === "GET" && url.pathname === "/library.js")
        return send(js, "text/javascript");
      if (req.method === "GET" && url.pathname === "/library.css")
        return send(css, "text/css");
      if (req.method === "GET" && url.pathname === "/new")
        return send(newDemo.html, "text/html");
      if (req.method === "GET" && url.pathname === "/new.js")
        return send(newDemo.js, "text/javascript");
      if (req.method === "GET" && url.pathname === "/new.css")
        return send(newDemo.css, "text/css");
      if (req.method === "GET" && url.pathname === "/api/library") {
        const scan = await library.scan();
        return send(
          JSON.stringify({
            ...scan,
            recordings: await seen.annotate(scan.recordings),
          }),
          "application/json",
        );
      }
      if (await handleAgentRoute(req, res, url, library, agents, options.restricted)) return;
      if (req.method === "POST" && url.pathname === "/api/seen") {
        // The library and the editor mark a demo as looked at.
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) throw new Error("Request is too large.");
        }
        const id = (JSON.parse(body || "{}") as { id?: unknown }).id;
        const recording =
          typeof id === "string"
            ? (await library.scan()).recordings.find((r) => r.id === id)
            : undefined;
        if (!recording)
          return send(
            JSON.stringify({ error: "Recording not found" }),
            "application/json",
            404,
          );
        await seen.mark(recording);
        return send(JSON.stringify({ ok: true }), "application/json");
      }
      if (req.method === "GET" && url.pathname === "/api/contract")
        return send(JSON.stringify(contract), "application/json");
      const match = /^\/projects\/([a-f0-9]{16})(\/.*)?$/.exec(url.pathname);
      if (match) {
        const id = match[1]!,
          dir = await library.resolve(id);
        if (!match[2]) {
          res.writeHead(302, { Location: `/projects/${id}/${url.search}` });
          res.end();
          return;
        }
        if (match[2] === "/poster.png" && req.method === "GET") {
          return send(await projectPoster(dir), "image/png");
        }
        const sub = match[2],
          host = req.headers.host ?? "";
        if (req.method === "GET" && sub === "/") {
          // Headless renders are not a person viewing the demo.
          // A link from another site doesn't retarget connected agents.
          if (!url.searchParams.has("render") && req.headers["sec-fetch-site"] !== "cross-site")
            noteViewer(id, dir, true, host);
        } else if (req.method === "GET" && sub === "/api/status")
          noteViewer(id, dir, url.searchParams.get("focused") === "1", host);
        else if (req.method === "POST" && sub.startsWith("/api/"))
          noteViewer(id, dir, sub !== "/api/preview-state", host);
        let handler = handlers.get(id);
        if (!handler) {
          handler = createReplayHandler(dir, {
            host: options.host,
            basePath: `/projects/${id}`,
            library: true,
            // Agents connect in the worktree that holds the demo.
            workspaceRoot: library.rootOf(dir) ?? library.root,
          });
          handlers.set(id, handler);
          handler.catch(() => handlers.delete(id));
        }
        req.url = match[2] + url.search;
        await (await handler).handler(req, res);
        return;
      }
      send(JSON.stringify({ error: "Not found" }), "application/json", 404);
    } catch (error) {
      send(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        "application/json",
        400,
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4310, options.host ?? "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    library,
    url: `http://${options.host && options.host !== "0.0.0.0" ? options.host : "127.0.0.1"}:${port}`,
    close: async () => {
      agents.stopAll();
      await Promise.all(
        [...handlers.values()].map(async (h) => (await h).close()),
      );
      await writing;
      await Promise.all(
        [...sessionRoots].map((root) => clearStudioSession(root, serverId)),
      );
      // Idle keep-alive sockets would otherwise hold close() open.
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
