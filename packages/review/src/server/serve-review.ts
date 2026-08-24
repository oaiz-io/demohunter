import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { VIEWER_CSP } from "../viewer/render-viewer.js";

export const REVIEW_SERVER_HOST = "127.0.0.1";

export type ReviewServer = {
  /** Always a 127.0.0.1 origin. The server never binds another interface. */
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
};

export type ServeReviewOptions = {
  root: string;
  port?: number;
};

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": VIEWER_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cache-control": "no-store",
};

/**
 * Serves one generated review directory over loopback only.
 *
 * The review artifact contains a verbatim copy of source code from the
 * repository, so the server is deliberately minimal and closed: loopback bind,
 * Host pinning against DNS rebinding, GET/HEAD only, no directory listing, and
 * a realpath containment check that blocks both `..` traversal and symlinks
 * that point outside the review root.
 */
export async function serveReview(options: ServeReviewOptions): Promise<ReviewServer> {
  const root = await realpath(path.resolve(options.root));
  const server = http.createServer((request, response) => {
    void handleRequest(root, request, response).catch(() => {
      writePlain(response, 500, "Internal Server Error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, REVIEW_SERVER_HOST);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("DemoHunter Review server could not bind a loopback port.");
  }

  return {
    baseUrl: `http://${REVIEW_SERVER_HOST}:${address.port}`,
    port: address.port,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    writePlain(response, 405, "Method Not Allowed");
    return;
  }

  if (!isLoopbackHost(request.headers.host)) {
    // Refuse Host headers that are not loopback so a rebound DNS name cannot
    // reach a review artifact from a page in the developer's browser.
    writePlain(response, 421, "Misdirected Request");
    return;
  }

  const requestPath = decodeRequestPath(request.url ?? "/");

  if (requestPath === undefined) {
    writePlain(response, 400, "Bad Request");
    return;
  }

  const candidate = resolveRequestPath(root, requestPath);

  if (candidate === undefined) {
    writePlain(response, 403, "Forbidden");
    return;
  }

  const resolved = await resolveExistingFile(root, candidate);

  if (resolved === undefined) {
    writePlain(response, 404, "Not Found");
    return;
  }

  const contentType = MIME_TYPES[path.extname(resolved.filePath).toLowerCase()]
    ?? "application/octet-stream";
  const range = parseRangeHeader(request.headers.range, resolved.size);

  if (range === "invalid") {
    applySecurityHeaders(response);
    response.setHeader("content-range", `bytes */${resolved.size}`);
    writePlain(response, 416, "Range Not Satisfiable");
    return;
  }

  applySecurityHeaders(response);
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("content-type", contentType);

  if (range === undefined) {
    response.setHeader("content-length", String(resolved.size));
    response.writeHead(200);

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(resolved.filePath).pipe(response);
    return;
  }

  response.setHeader("content-length", String(range.end - range.start + 1));
  response.setHeader("content-range", `bytes ${range.start}-${range.end}/${resolved.size}`);
  response.writeHead(206);

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(resolved.filePath, { start: range.start, end: range.end }).pipe(response);
}

export function decodeRequestPath(requestUrl: string): string | undefined {
  try {
    return decodeURIComponent(new URL(requestUrl, `http://${REVIEW_SERVER_HOST}`).pathname);
  } catch {
    return undefined;
  }
}

/**
 * Maps a request path to a candidate file inside the root, or undefined when
 * the request escapes it. Runs before any filesystem access.
 */
export function resolveRequestPath(root: string, requestPath: string): string | undefined {
  if (requestPath.includes("\0")) {
    return undefined;
  }

  const normalized = requestPath.replace(/\\/g, "/");
  const relative = normalized.replace(/^\/+/, "");
  const candidate = path.resolve(root, relative === "" ? "index.html" : relative);

  return isInside(root, candidate) ? candidate : undefined;
}

async function resolveExistingFile(
  root: string,
  candidate: string,
): Promise<{ filePath: string; size: number } | undefined> {
  const attempts = [candidate, path.join(candidate, "index.html")];

  for (const attempt of attempts) {
    let realPath: string;

    try {
      // realpath resolves symlinks, so a link inside the review directory that
      // points at /etc/passwd fails the containment check below.
      realPath = await realpath(attempt);
    } catch {
      continue;
    }

    if (!isInside(root, realPath)) {
      continue;
    }

    const stats = await stat(realPath).catch(() => undefined);

    if (stats === undefined || !stats.isFile()) {
      continue;
    }

    return { filePath: realPath, size: stats.size };
  }

  return undefined;
}

export function parseRangeHeader(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined | "invalid" {
  if (header === undefined) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (match === null) {
    // Multi-range and unknown units fall back to a full response, which is a
    // valid answer under RFC 9110.
    return undefined;
  }

  const [, rawStart, rawEnd] = match;

  if (rawStart === "" && rawEnd === "") {
    return "invalid";
  }

  if (size === 0) {
    return "invalid";
  }

  if (rawStart === "") {
    const suffixLength = Number.parseInt(rawEnd!, 10);

    if (suffixLength === 0) {
      return "invalid";
    }

    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number.parseInt(rawStart!, 10);
  const end = rawEnd === "" ? size - 1 : Math.min(Number.parseInt(rawEnd!, 10), size - 1);

  if (start > end || start >= size) {
    return "invalid";
  }

  return { start, end };
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }

  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0]!;

  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }

  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function applySecurityHeaders(response: ServerResponse): void {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(header, value);
  }
}

function writePlain(response: ServerResponse, status: number, message: string): void {
  applySecurityHeaders(response);
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.writeHead(status);
  response.end(`${message}\n`);
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
