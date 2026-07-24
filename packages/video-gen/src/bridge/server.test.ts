import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveSiteRequestPath, startStaticServer } from "./server.js";

describe("static server", () => {
  test("serves site assets with correct MIME types and rejects traversal", async () => {
    const siteDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-site-"));
    try {
      await writeFile(path.join(siteDir, "index.html"), "<html>ok</html>");
      await writeFile(path.join(siteDir, "styles.css"), "body{}");
      await writeFile(path.join(siteDir, "app.js"), "console.log(1)");

      const server = await startStaticServer(siteDir);
      try {
        expect(server.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        const html = await fetch(server.baseURL);
        expect(html.status).toBe(200);
        expect(html.headers.get("content-type")).toContain("text/html");
        expect(await html.text()).toContain("ok");

        const css = await fetch(`${server.baseURL}/styles.css`);
        expect(css.headers.get("content-type")).toContain("text/css");

        const js = await fetch(`${server.baseURL}/app.js`);
        expect(js.headers.get("content-type")).toContain("text/javascript");

        const missing = await fetch(`${server.baseURL}/nope.html`);
        expect(missing.status).toBe(404);

        const traversal = await fetch(`${server.baseURL}/../../etc/passwd`);
        expect(traversal.status).toBe(404);

        const post = await fetch(server.baseURL, { method: "POST" });
        expect(post.status).toBe(405);
      } finally {
        await server.close();
        await server.close();
      }

      expect(resolveSiteRequestPath(siteDir, "/index.html")).toBe(path.join(siteDir, "index.html"));
      expect(resolveSiteRequestPath(siteDir, "/../../etc/passwd")).toBeUndefined();
    } finally {
      await rm(siteDir, { recursive: true, force: true });
    }
  });
});
