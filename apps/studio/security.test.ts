import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { serveReplay } from "./server.js";
import { serveLibrary } from "./library-server.js";
import { projectFixture } from "./test-support.js";
import { restrictFolder } from "./trust.js";

/** Raw request with an arbitrary Host header (fetch can't set it). */
function raw(url: string, opts: { host?: string; method?: string; body?: string; headers?: Record<string, string> } = {}) {
  const u = new URL(url);
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? "GET", headers: { ...(opts.host ? { host: opts.host } : {}), ...opts.headers } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

let fixture: { root: string; dir: string };
beforeAll(async () => {
  fixture = await projectFixture();
  await mkdir(path.join(fixture.dir, "assets"), { recursive: true });
  await mkdir(path.join(fixture.dir, "scenes"), { recursive: true });
  await writeFile(path.join(fixture.dir, "assets/evil.js"), "alert(1)");
  await writeFile(path.join(fixture.dir, "assets/page.html"), "<script>alert(1)</script>");
  await writeFile(path.join(fixture.dir, "assets/logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(path.join(fixture.dir, "scenes/intro.html"), "<p>Intro</p>");
  await writeFile(path.join(fixture.dir, "scenes/kit.js"), "export {}");
});
afterAll(() => rm(fixture.root, { recursive: true, force: true }));

describe("local service hardening", () => {
  test("only loopback Host names are served (DNS rebinding)", async () => {
    const app = await serveReplay(fixture.dir, { port: 0 });
    try {
      const port = new URL(app.url).port;
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`])
        expect((await raw(`${app.url}/api/project`, { host })).status).toBe(200);
      for (const host of [`attacker.example:${port}`, `127.0.0.1.attacker.example:${port}`]) {
        expect((await raw(`${app.url}/api/project`, { host })).status).toBe(421);
        const post = await raw(`${app.url}/api/selection`, { host, method: "POST", body: '{"clear":true}', headers: { origin: `http://${host}`, "content-type": "text/plain" } });
        expect(post.status).toBe(421);
      }
    } finally {
      await app.close();
    }
  });

  test("files: no traversal into other project files, assets never scripts, editor not framable", async () => {
    const app = await serveReplay(fixture.dir, { port: 0 });
    try {
      for (const p of ["/files/scenes/..%2fproject.json", "/files/assets/..%2f..%2fproject.json", "/files/assets/evil.js", "/files/assets/page.html"])
        expect((await fetch(app.url + p)).status).toBe(404);
      const svg = await fetch(app.url + "/files/assets/logo.svg");
      expect(svg.status).toBe(200);
      expect(svg.headers.get("content-security-policy")).toContain("sandbox");
      const scene = await fetch(app.url + "/files/scenes/intro.html");
      expect(scene.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
      const editor = await fetch(app.url + "/");
      expect(editor.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(await editor.text()).toContain("/vendor/rrweb.js");
      const vendor = await fetch(app.url + "/vendor/rrweb.js");
      expect(vendor.status).toBe(200);
      expect((await vendor.text()).length).toBeGreaterThan(10_000);
      const workspace = await fetch(app.url + "/api/workspace").then((r) => r.json());
      expect(workspace.trusted).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("symlinked recordings are refused", async () => {
    const { root, dir } = await projectFixture();
    try {
      await writeFile(path.join(root, "secret.txt"), "TOP SECRET");
      await rm(path.join(dir, "events.json"));
      await symlink(path.join(root, "secret.txt"), path.join(dir, "events.json"));
      const app = await serveReplay(dir, { port: 0 }).catch(() => undefined);
      if (app)
        try {
          const events = await fetch(app.url + "/api/events");
          expect(await events.text()).not.toContain("TOP SECRET");
        } finally {
          await app.close();
        }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restricted folders: scene scripts are off and the editor is told", async () => {
    const { root, dir } = await projectFixture();
    try {
      await mkdir(path.join(dir, "scenes"));
      await writeFile(path.join(dir, "scenes/intro.html"), "<script>window.ran = 1</script>");
      await writeFile(path.join(dir, "scenes/kit.js"), "export {}");
      restrictFolder(root);
      const app = await serveReplay(dir, { port: 0 });
      try {
        const scene = await fetch(app.url + "/files/scenes/intro.html");
        const scriptSrc = /script-src([^;]*)/.exec(scene.headers.get("content-security-policy") ?? "")?.[1] ?? "";
        expect(scriptSrc).not.toContain("'unsafe-inline'");
        expect((await fetch(app.url + "/files/scenes/kit.js")).status).toBe(403);
        expect((await fetch(app.url + "/api/workspace").then((r) => r.json())).trusted).toBe(false);
        // Behaviour, not just headers: even opened directly, the script
        // doesn't run (the response itself is sandboxed).
        const { chromium } = await import("playwright");
        const browser = await chromium.launch();
        try {
          const page = await browser.newPage();
          await page.goto(app.url + "/files/scenes/intro.html");
          expect(await page.evaluate(() => (window as any).ran ?? null).catch(() => null)).toBeNull();
        } finally {
          await browser.close();
        }
      } finally {
        await app.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the library refuses foreign hosts and oversized seen requests", async () => {
    const { root } = await projectFixture();
    const app = await serveLibrary(root, { port: 0 });
    try {
      const port = new URL(app.url).port;
      expect((await raw(`${app.url}/api/library`, { host: `evil.example:${port}` })).status).toBe(421);
      expect((await raw(`${app.url}/api/library`, { host: `127.0.0.1:${port}` })).status).toBe(200);
      const big = await fetch(`${app.url}/api/seen`, { method: "POST", body: "x".repeat(10_000) });
      expect(big.status).toBe(400);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("lift snapshots", () => {
  test("lifted copies of recorded elements carry no executable markup", async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const bundle = await build({
      stdin: {
        contents: `import { snapshotElement } from "./web/snapshot.ts"; (window as any).snap = snapshotElement;`,
        resolveDir: import.meta.dir,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<div id="card"><img src="x.png" onerror="alert(1)" alt="Logo"><a href="javascript:alert(1)" onclick="alert(2)">Link</a><iframe srcdoc="<script>alert(3)</script>"></iframe><button formaction="https://evil.example" onfocus="alert(4)">Go</button><svg><a xlink:href="javascript:alert(5)"><text>t</text></a></svg><p data-x="1">Text</p></div>`,
      );
      // Recorded pages deliver text through the DOM; raw-text elements would
      // serialise it unescaped (mutation XSS).
      await page.evaluate(() => {
        for (const tag of ["xmp", "noembed", "noframes"]) {
          const el = document.createElement(tag);
          el.textContent = `</${tag}><img src=x onerror="window.pwned=1">`;
          document.getElementById("card")!.append(el);
        }
      });
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      const html = await page.evaluate(() => (window as any).snap(document.getElementById("card")).html as string);
      expect(html).toContain("Text");
      expect(html).toContain('alt="Logo"');
      expect(html).not.toMatch(/\son\w+=/i);
      expect(html).not.toMatch(/javascript:|srcdoc|formaction|<iframe/i);
    } finally {
      await browser.close();
    }
  });
});

describe("round 2 hardening", () => {
  test("cross-site calls are refused; links are not served as scripts; exports can't be redirected", async () => {
    const { root, dir } = await projectFixture();
    try {
      await mkdir(path.join(dir, "scenes"));
      await writeFile(path.join(dir, "scenes/b.js"), "window.pwned = 1");
      await symlink(path.join(dir, "scenes/b.js"), path.join(dir, "scenes/a.json"));
      await mkdir(path.join(root, "elsewhere"));
      await symlink(path.join(root, "elsewhere"), path.join(dir, "exports"));
      const app = await serveReplay(dir, { port: 0 });
      try {
        const cross = await raw(`${app.url}/api/project`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } });
        expect(cross.status).toBe(403);
        const nav = await raw(`${app.url}/`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } });
        expect(nav.status).toBe(200);
        expect((await fetch(app.url + "/files/scenes/a.json")).status).toBe(404);
        const bundle = await fetch(app.url + "/api/project").then((r) => r.json());
        const exported = await fetch(app.url + "/api/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: bundle.revision }),
        });
        expect(exported.status).toBe(400);
        expect((await exported.json()).error).toContain("not a link");
      } finally {
        await app.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
