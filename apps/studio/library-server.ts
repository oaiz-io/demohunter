import { fileURLToPath } from "node:url";
import { projectPoster } from "./poster.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { LocalLibrary } from "./library.js";
import { createReplayHandler } from "./server.js";
import { contract } from "./contract.js";
import { fontFile } from "./fonts.js";
export async function serveLibrary(
  root: string,
  options: { port?: number; host?: string } = {},
) {
  const library = await LocalLibrary.open(root);
  await library.scan();
  const here = path.dirname(fileURLToPath(import.meta.url)),
    html = await readFile(path.join(here, "web/library.html")),
    css = await readFile(path.join(here, "web/library.css"));
  const js = (
    await build({
      entryPoints: [path.join(here, "web/library-app.ts")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
    })
  ).outputFiles[0]!.contents;
  const handlers = new Map<
    string,
    Promise<Awaited<ReturnType<typeof createReplayHandler>>>
  >();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'",
    );
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (data: string | Uint8Array, type: string, status = 200) => {
      res.writeHead(status, { "Content-Type": type });
      res.end(data);
    };
    try {
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
      if (req.method === "GET" && url.pathname === "/api/library")
        return send(JSON.stringify(await library.scan()), "application/json");
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
        let handler = handlers.get(id);
        if (!handler) {
          handler = createReplayHandler(dir, {
            basePath: `/projects/${id}`,
            library: true,
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
      await Promise.all(
        [...handlers.values()].map(async (h) => (await h).close()),
      );
      // Idle keep-alive sockets would otherwise hold close() open.
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
