import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VIEWER_CSP } from "../viewer/render-viewer.js";
import {
  decodeRequestPath,
  isLoopbackHost,
  parseRangeHeader,
  resolveRequestPath,
  REVIEW_SERVER_HOST,
  serveReview,
  type ReviewServer,
} from "./serve-review.js";

describe("resolveRequestPath", () => {
  const root = path.resolve("/tmp/review-root");

  test("serves index.html for the directory root", () => {
    expect(resolveRequestPath(root, "/")).toBe(path.join(root, "index.html"));
  });

  test("resolves a nested asset", () => {
    expect(resolveRequestPath(root, "/assets/viewer.css")).toBe(
      path.join(root, "assets/viewer.css"),
    );
  });

  test("refuses to escape the root", () => {
    for (const requestPath of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/..%2fsecret.txt",
      "/\\..\\..\\secret.txt",
    ]) {
      const resolved = resolveRequestPath(root, requestPath.replace(/%2f/gi, "/"));

      // Either rejected outright, or normalized to something inside the root.
      expect(resolved === undefined || resolved.startsWith(`${root}${path.sep}`)).toBe(true);
      expect(resolved ?? "").not.toContain(`..${path.sep}`);
    }
  });

  test("refuses a NUL byte", () => {
    expect(resolveRequestPath(root, "/index.html\0.png")).toBeUndefined();
  });
});

describe("decodeRequestPath", () => {
  test("decodes percent-escapes and drops the query string", () => {
    expect(decodeRequestPath("/assets/my%20file.css?v=1")).toBe("/assets/my file.css");
    expect(decodeRequestPath("/a/../b")).toBe("/b");
  });

  test("decodes an encoded traversal so the containment check can see it", () => {
    expect(decodeRequestPath("/%2e%2e%2fsecret.txt")).toBe("/../secret.txt");
  });

  test("returns undefined for an undecodable path", () => {
    expect(decodeRequestPath("/%E0%A4%A")).toBeUndefined();
  });
});

describe("isLoopbackHost", () => {
  test("accepts loopback names and rejects everything else", () => {
    expect(isLoopbackHost("127.0.0.1:8080")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]:8080")).toBe(true);
    expect(isLoopbackHost("evil.example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe("parseRangeHeader", () => {
  test("returns undefined when no range is requested", () => {
    expect(parseRangeHeader(undefined, 100)).toBeUndefined();
  });

  test("parses closed, open, and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  test("clamps an end past the file and rejects an unsatisfiable range", () => {
    expect(parseRangeHeader("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader("bytes=100-200", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=50-10", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=-0", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=0-0", 0)).toBe("invalid");
  });

  test("falls back to a full response for multi-range and unknown units", () => {
    expect(parseRangeHeader("bytes=0-1,5-6", 100)).toBeUndefined();
    expect(parseRangeHeader("items=0-1", 100)).toBeUndefined();
  });
});

describe("serveReview", () => {
  let root: string;
  let outside: string;
  let server: ReviewServer;

  beforeAll(async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-review-server-"));
    root = path.join(tempRoot, "review");
    outside = path.join(tempRoot, "outside");

    await mkdir(path.join(root, "assets"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, "index.html"), "<!doctype html><title>review</title>", "utf8");
    await writeFile(path.join(root, "assets", "viewer.css"), "body{}", "utf8");
    await writeFile(path.join(root, "video.mp4"), "0123456789", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "top secret", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "linked-secret.txt"));

    server = await serveReview({ root });
  });

  afterAll(async () => {
    await server.close();
    await rm(path.dirname(root), { force: true, recursive: true });
  });

  test("binds loopback only", () => {
    expect(REVIEW_SERVER_HOST).toBe("127.0.0.1");
    expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
  });

  test("serves the index with the same CSP the document declares", async () => {
    const response = await fetch(`${server.baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(VIEWER_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain("<title>review</title>");
  });

  test("serves assets with an accurate content type", async () => {
    const response = await fetch(`${server.baseUrl}/assets/viewer.css`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  test("rejects a non-loopback Host header", async () => {
    const response = await fetch(`${server.baseUrl}/`, {
      headers: { host: "review.evil.example" },
    });

    expect(response.status).toBe(421);
  });

  test("rejects methods other than GET and HEAD", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await fetch(`${server.baseUrl}/`, { method });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  test("answers HEAD without a body but with the real length", async () => {
    const response = await fetch(`${server.baseUrl}/video.mp4`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
  });

  test("blocks path traversal", async () => {
    for (const target of ["/../outside/secret.txt", "/%2e%2e/outside/secret.txt", "/assets/../../outside/secret.txt"]) {
      const response = await fetch(`${server.baseUrl}${target}`);

      expect([403, 404]).toContain(response.status);
      expect(await response.text()).not.toContain("top secret");
    }
  });

  test("blocks a symlink that points outside the review directory", async () => {
    const response = await fetch(`${server.baseUrl}/linked-secret.txt`);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("top secret");
  });

  test("404s a missing file and does not list directories", async () => {
    expect((await fetch(`${server.baseUrl}/missing.html`)).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/assets/`)).status).toBe(404);
  });

  test("supports range requests so the walkthrough can seek", async () => {
    const response = await fetch(`${server.baseUrl}/video.mp4`, {
      headers: { range: "bytes=2-5" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("2345");
  });

  test("reports an unsatisfiable range", async () => {
    const response = await fetch(`${server.baseUrl}/video.mp4`, {
      headers: { range: "bytes=50-60" },
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  test("stops listening after close", async () => {
    const temporary = await serveReview({ root });
    const url = temporary.baseUrl;

    expect((await fetch(url)).status).toBe(200);
    await temporary.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});
