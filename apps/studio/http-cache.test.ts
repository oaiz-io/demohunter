import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serveReplay } from "./server.js";
import { projectFixture } from "./test-support.js";

test("bundles and polls revalidate with an ETag; changing project data is never cached", async () => {
  const { root, dir } = await projectFixture();
  const app = await serveReplay(dir, { port: 0 });
  try {
    const js = await fetch(`${app.url}/app.js`);
    const tag = js.headers.get("ETag")!;
    expect(js.headers.get("Cache-Control")).toBe("no-cache");
    expect(tag).toMatch(/^"[\w-]+"$/);
    const body = await js.text();
    // Minified, and the schemas (zod) are not in the client bundle.
    expect(body.length).toBeLessThan(400_000);
    expect(body).not.toContain("ZodError");
    const again = await fetch(`${app.url}/app.js`, { headers: { "If-None-Match": tag } });
    expect(again.status).toBe(304);
    const css = await fetch(`${app.url}/style.css`, { headers: { "If-None-Match": tag } });
    expect(css.status).toBe(200);
    expect(css.headers.get("ETag")).not.toBe(tag);
    // Only content-hash asset names are immutable.
    const asset = await fetch(`${app.url}/files/assets/test.css`);
    expect(asset.headers.get("Cache-Control")).toBe("no-store"); // not a hash name
    // Project state can change under the same URL: never cached.
    for (const route of ["/api/project", "/api/status", "/"])
      expect((await fetch(`${app.url}${route}`)).headers.get("Cache-Control")).toBe("no-store");
    // The status poll: an unchanged state is a 304; a direct file edit is not.
    const status = await fetch(`${app.url}/api/status`);
    const statusTag = status.headers.get("ETag")!;
    const before = (await status.json()) as { revision: string };
    const same = await fetch(`${app.url}/api/status`, { headers: { "If-None-Match": statusTag } });
    expect(same.status).toBe(304);
    expect(same.headers.get("Cache-Control")).toBe("no-store");
    const cssFile = path.join(dir, "overrides.css");
    await writeFile(cssFile, `${await readFile(cssFile, "utf8").catch(() => "")}\nh1{color:red}\n`);
    const changed = await fetch(`${app.url}/api/status`, { headers: { "If-None-Match": statusTag } });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { revision: string }).revision).not.toBe(before.revision);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
