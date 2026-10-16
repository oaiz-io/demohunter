import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { loadBundle, safeFile, writeJson } from "./storage.js";
import { targetSchema, validateBundle } from "./model.js";
import { elementPatchSchema } from "./element-edit.js";
import { regenerateNarration } from "./narration.js";
import { ReplayWorkspace, readOptional } from "./workspace.js";
import { readActivity } from "./activity.js";
import { contract } from "./contract.js";
import { historySummary } from "./storage.js";
import { fontFile } from "./fonts.js";
import { projectFrame } from "./poster.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mime: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".otf": "font/otf",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
};
const selectionSchema = z
  .object({
    nodeId: z.number().int().positive(),
    documentId: z.number().int().positive().optional(),
    elementRef: z.string().optional(),
    tag: z.string(),
    selector: z.string(),
    text: z.string(),
    attributes: z.record(z.string(), z.string()),
    sourceMs: z.number().finite().nonnegative(),
    outputMs: z.number().finite().nonnegative(),
  })
  .strict();

let assetsPromise:
  | Promise<{ js: Uint8Array; html: string; css: Buffer }>
  | undefined;
function browserAssets() {
  return (assetsPromise ??= (async () => {
    const compiled = await build({
      entryPoints: [path.join(here, "web/app.ts")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
    return {
      js: compiled.outputFiles[0]!.contents,
      html: await readFile(path.join(here, "web/index.html"), "utf8"),
      css: await readFile(path.join(here, "web/style.css")),
    };
  })());
}

export async function createReplayHandler(
  projectDir: string,
  options: {
    basePath?: string;
    library?: boolean;
    /** Studio library root: agents connect to the workspace, not one demo. */
    workspaceRoot?: string;
  } = {},
) {
  const basePath = options.basePath ?? "";
  const dir = path.resolve(projectDir);
  await loadBundle(dir);
  const workspace = await ReplayWorkspace.open(dir);
  const assets = await browserAssets();
  const appJs = assets.js;
  const html = assets.html
    .replaceAll('href="/', `href="${basePath}/`)
    .replaceAll('src="/', `src="${basePath}/`);
  const css = assets.css;
  let narrating = false,
    narrationMessage = "",
    narrationError = "";
  const jobs = new Set<Promise<unknown>>();
  let exportState: {
    running: boolean;
    message: string;
    error?: string;
    directory?: string;
  } = { running: false, message: "" };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; frame-src 'self' about: blob:; object-src 'none'; base-uri 'self'",
    );
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST") {
        // Local write endpoints may only be called from this editor or a local CLI.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host)
          return json(res, { error: "Cross-origin writes are disabled." }, 403);
        if (req.headers["sec-fetch-site"] === "cross-site")
          return json(res, { error: "Cross-site writes are disabled." }, 403);
      }
      if (req.method === "GET" && url.pathname === "/")
        return send(
          res,
          html.replace(
            'href="#studio-library"',
            options.library ? 'href="/"' : 'href="#" hidden',
          ),
          "text/html",
        );
      if (req.method === "GET" && url.pathname === "/app.js")
        return send(res, appJs, "text/javascript");
      if (req.method === "GET" && url.pathname === "/style.css")
        return send(res, css, "text/css");
      if (req.method === "GET" && url.pathname.startsWith("/fonts/")) {
        const font = fontFile(url.pathname.slice("/fonts/".length));
        if (!font) return json(res, { error: "Not found" }, 404);
        res.setHeader("Cache-Control", "public, max-age=86400");
        return send(res, await font, "font/woff2");
      }
      if (req.method === "GET" && url.pathname === "/api/frame") {
        const t = Number(url.searchParams.get("t") ?? 0);
        if (!Number.isFinite(t) || t < 0)
          return json(res, { error: "Invalid frame time" }, 400);
        res.setHeader("Cache-Control", "private, max-age=3600");
        return send(res, await projectFrame(dir, t), "image/png");
      }
      if (req.method === "GET" && url.pathname === "/api/contract")
        return json(res, contract);
      if (req.method === "GET" && url.pathname === "/api/activity")
        return json(res, await readActivity(dir));
      if (req.method === "GET" && url.pathname === "/api/project")
        return json(res, await loadBundle(dir));
      if (req.method === "GET" && url.pathname === "/api/workspace")
        return json(res, {
          index: workspace.index,
          projectDir: dir,
          // Workspace-scoped: the MCP server edits whichever demo is open
          // in Studio, so one connection serves every demo in the library.
          connection: options.workspaceRoot
            ? {
                command: process.execPath,
                args: [path.join(here, "cli.ts"), "mcp", options.workspaceRoot],
                scope: "workspace",
                name: `demohunter-${
                  path
                    .basename(options.workspaceRoot)
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "")
                    .slice(0, 40) || "studio"
                }`,
              }
            : {
                command: process.execPath,
                args: [path.join(here, "cli.ts"), "mcp", dir],
                scope: "project",
              },
          sourceBoundary:
            "Captured HTML is a recording artifact. Original source locations are available only when explicitly annotated by the app.",
        });
      if (req.method === "GET" && url.pathname === "/api/history")
        return json(res, await workspace.history());
      if (req.method === "GET" && url.pathname === "/api/events")
        return send(
          res,
          (await readFile(path.join(dir, "events.json"), "utf8")).replaceAll(
            "/files/",
            `${basePath}/files/`,
          ),
          "application/json",
        );
      if (req.method === "GET" && url.pathname === "/api/status") {
        try {
          const history = await historySummary(dir);
          return json(res, {
            revision: (await loadBundle(dir)).revision,
            narrating,
            narrationMessage,
            narrationError,
            command: await readOptional(dir, "preview-command.json"),
            historyCount: history.length,
            history: history.slice(0, 50),
            activity: await readActivity(dir),
            export: exportState,
          });
        } catch (error) {
          return json(res, {
            error: message(error),
            narrating,
            narrationMessage,
            narrationError,
          });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/export") {
        if (exportState.running)
          return json(res, { error: "An export is already running." }, 409);
        const input = z
          .object({
            revision: z.string(),
            fps: z.number().int().min(1).max(60).default(24),
            strictAudio: z.boolean().default(false),
          })
          .strict()
          .parse(await body(req));
        const current = await loadBundle(dir);
        if (current.revision !== input.revision)
          return json(
            res,
            {
              error:
                "Project changed. Review the latest revision before exporting.",
            },
            409,
          );
        exportState = { running: true, message: "Preparing saved replay…" };
        const destination = path.join(dir, "exports", `export-${Date.now()}`);
        const job = import("./export.js")
          .then(({ exportReplay }) =>
            exportReplay(dir, destination, {
              fps: input.fps,
              strictAudio: input.strictAudio,
              expectedRevision: input.revision,
              onProgress: (message) => {
                exportState.message = message;
              },
            }),
          )
          .then((result) => {
            exportState = {
              running: false,
              message: "Export ready",
              directory: result.directory,
            };
          })
          .catch((error) => {
            exportState = {
              running: false,
              message: "Export failed",
              error: message(error),
            };
          })
          .finally(() => jobs.delete(job));
        jobs.add(job);
        return json(res, { ok: true }, 202);
      }
      if (
        req.method === "GET" &&
        url.pathname.startsWith("/api/export/download/")
      ) {
        const name = url.pathname.split("/").at(-1)!;
        if (
          !["video.mp4", "captions.vtt", "manifest.json"].includes(name) ||
          !exportState.directory
        )
          return json(res, { error: "Export not available" }, 404);
        const file = await safeFile(
          dir,
          path.relative(dir, path.join(exportState.directory, name)),
        );
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        return send(
          res,
          await readFile(file),
          mime[path.extname(file)] ?? "application/json",
        );
      }
      if (req.method === "POST" && url.pathname === "/api/selection") {
        const value = await body(req);
        if (typeof value === "object" && value !== null && "clear" in value) {
          z.object({ clear: z.literal(true) })
            .strict()
            .parse(value);
          await unlink(path.join(dir, "selection.json")).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
          return json(res, { ok: true });
        }
        const selection = selectionSchema.parse(value);
        if (selection.elementRef) workspace.element(selection.elementRef);
        await writeJson(path.join(dir, "selection.json"), selection);
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/preview-state") {
        const value = z
          .object({
            outputMs: z.number().finite().nonnegative(),
            sourceMs: z.number().finite().nonnegative(),
            playing: z.boolean(),
            elementRef: z.string().optional(),
            html: z.string().max(30000).optional(),
            styles: z.record(z.string(), z.string()).optional(),
            bounds: z
              .object({
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
              })
              .optional(),
            acknowledgedCommand: z.string().optional(),
          })
          .strict()
          .parse(await body(req));
        if (value.elementRef) workspace.element(value.elementRef);
        await writeJson(path.join(dir, "preview-state.json"), {
          ...value,
          updatedAt: new Date().toISOString(),
        });
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/comments") {
        const value = z
          .discriminatedUnion("action", [
            z
              .object({
                action: z.literal("add"),
                expectedRevision: z.string(),
                elementRef: z.string().optional(),
                timeMs: z.number().finite().nonnegative(),
                body: z.string().min(1).max(10000),
                author: z.string().optional(),
              })
              .strict(),
            z
              .object({
                action: z.literal("update"),
                expectedRevision: z.string(),
                threadId: z.string(),
                status: z.enum(["open", "resolved"]).optional(),
                reply: z.string().min(1).max(10000).optional(),
                author: z.string().optional(),
              })
              .strict(),
          ])
          .parse(await body(req));
        return json(
          res,
          value.action === "add"
            ? await workspace.addComment(value)
            : await workspace.commentAction(value),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/element-edit") {
        const input = z
          .object({
            revision: z.string(),
            target: targetSchema,
            patch: elementPatchSchema,
          })
          .strict()
          .parse(await body(req));
        const result = await workspace.editElement(
          input.revision,
          input.target,
          input.patch,
        );
        return json(res, { revision: result.revision });
      }
      if (req.method === "POST" && url.pathname === "/api/undo") {
        const value = z
          .object({
            revision: z.string(),
            steps: z.number().int().min(1).max(50).default(1),
          })
          .strict()
          .parse(await body(req));
        return json(res, {
          revision: (await workspace.undo(value.revision, value.steps))
            .revision,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
        const request = z
          .object({
            file: z.enum([
              "edits.json",
              "narration.json",
              "project.json",
              "comments.json",
            ]),
            value: z.unknown(),
            revision: z.string(),
          })
          .strict()
          .parse(await body(req));
        const result = await workspace.change(
          request.revision,
          `Save ${request.file}`,
          (draft) => {
            const key = (
              {
                "edits.json": "edits",
                "narration.json": "narration",
                "project.json": "project",
                "comments.json": "comments",
              } as const
            )[request.file];
            Object.assign(draft, { [key]: request.value });
          },
        );
        return json(res, { ok: true, revision: result.revision });
      }
      if (req.method === "POST" && url.pathname === "/api/narrate") {
        const request = z
          .object({ segmentIds: z.array(z.string()).min(1).optional() })
          .strict()
          .parse(await body(req));
        if (narrating)
          return json(
            res,
            { error: "Narration is already regenerating." },
            409,
          );
        narrating = true;
        narrationError = "";
        narrationMessage = "Resolving narration…";
        const job = regenerateNarration(dir, {
          fit: true,
          segmentIds: request.segmentIds,
          onProgress: (text) => {
            narrationMessage = text;
          },
        })
          .then((result) => {
            narrationMessage = `${result.generated} segments ready${result.skipped ? `; ${result.skipped} changed during synthesis, retry to regenerate` : ""}.`;
          })
          .catch((error) => {
            narrationError = message(error);
          })
          .finally(() => {
            narrating = false;
            jobs.delete(job);
          });
        jobs.add(job);
        return json(res, { ok: true }, 202);
      }
      if (req.method === "GET" && url.pathname.startsWith("/files/")) {
        const relative = decodeURIComponent(
          url.pathname.slice("/files/".length),
        );
        if (!/^(assets|audio|scenes)\//.test(relative))
          return json(res, { error: "Unknown file." }, 404);
        // Scene pages are project code (like tour files): inline scripts and
        // styles run, but only local files load, so renders stay offline.
        if (relative.startsWith("scenes/"))
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'",
          );
        const file = await safeFile(dir, relative);
        let data = await readFile(file);
        if (path.extname(file) === ".css" && basePath)
          data = Buffer.from(
            data.toString().replaceAll("/files/", `${basePath}/files/`),
          );
        const type = mime[path.extname(file)] ?? "application/octet-stream";
        res.setHeader("Accept-Ranges", "bytes");
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          const start = Number(match?.[1]);
          const end = match?.[2] ? Number(match[2]) : data.length - 1;
          if (!match || start > end || end >= data.length) {
            res.setHeader("Content-Range", `bytes */${data.length}`);
            return send(res, "", type, 416);
          }
          res.setHeader(
            "Content-Range",
            `bytes ${start}-${end}/${data.length}`,
          );
          return send(res, data.subarray(start, end + 1), type, 206);
        }
        return send(res, data, type);
      }
      return json(res, { error: "Not found." }, 404);
    } catch (error) {
      return json(
        res,
        { error: message(error) },
        (error as { status?: number }).status ??
          ((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400),
      );
    }
  };
  return {
    handler,
    projectDir: dir,
    close: async () => {
      await Promise.all([...jobs]);
    },
  };
}

export async function serveReplay(
  projectDir: string,
  options: { port?: number; host?: string } = {},
) {
  const replay = await createReplayHandler(projectDir);
  const dir = replay.projectDir;
  const server = createServer(replay.handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4310, options.host ?? "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const hostname =
    options.host && !["0.0.0.0", "127.0.0.1", "::"].includes(options.host)
      ? options.host
      : "localhost";
  return {
    server,
    url: `http://${hostname}:${port}`,
    projectDir: dir,
    close: async () => {
      await replay.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function send(
  res: ServerResponse,
  data: string | Uint8Array,
  contentType: string,
  status = 200,
): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(data);
}
function json(res: ServerResponse, value: unknown, status = 200): void {
  send(res, JSON.stringify(value), "application/json", status);
}
async function body(req: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > 1_000_000) throw new Error("Request is too large.");
    chunks.push(data);
  }
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}
