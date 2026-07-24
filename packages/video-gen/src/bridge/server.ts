import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { VideoGenError } from "../pipeline/errors.js";
import { isPathInside } from "../util/fs.js";

export type StaticServer = {
  baseURL: string;
  close: () => Promise<void>;
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export async function startStaticServer(siteDir: string): Promise<StaticServer> {
  const root = path.resolve(siteDir);
  await access(root);

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        response.end("Method Not Allowed");
        return;
      }

      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const relativePath = decodeURIComponent(requestUrl.pathname);
      const candidate = resolveSiteRequestPath(root, relativePath);
      if (candidate === undefined) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }

      let fileStat;
      try {
        fileStat = await stat(candidate);
      } catch {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }

      if (!fileStat.isFile()) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }

      const extension = path.extname(candidate);
      const contentType = MIME_TYPES[extension] ?? "application/octet-stream";
      response.writeHead(200, {
        "content-type": contentType,
        "content-length": fileStat.size,
        "cache-control": "no-store",
      });

      if (request.method === "HEAD") {
        response.end();
        return;
      }

      createReadStream(candidate).pipe(response);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Internal Server Error");
    }
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    throw new VideoGenError(
      "SERVER_FAILED",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await close();
    throw new VideoGenError("SERVER_FAILED", "Static server failed to bind a local port.");
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close,
  };
}

/** Resolve a request path under the site root, or undefined when traversal/escape is detected. */
export function resolveSiteRequestPath(siteDir: string, requestPath: string): string | undefined {
  const root = path.resolve(siteDir);
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const candidate = path.resolve(root, `.${normalized}`);
  if (candidate !== root && !isPathInside(root, candidate)) {
    return undefined;
  }
  return candidate;
}
