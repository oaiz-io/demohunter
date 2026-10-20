import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import { fixture, projectFixture } from "./test-support.js";
import { writeJson } from "./storage.js";
import { serveReplay } from "./server.js";
let n = 100;
const t = (v: string) => ({ type: 3, id: n++, textContent: v });
const el = (
  tag: string,
  attributes: Record<string, string>,
  childNodes: unknown[] = [],
) => ({ type: 2, id: n++, tagName: tag, attributes, childNodes });
// The inline editor draws its text over the element; with selection and caret
// hidden it must match the preview pixel for pixel (camera zoom included).
const shots = process.env.DH_SHOTS ?? path.resolve(".context");
test("inline text editor is aligned with the text it rewrites", async () => {
  await mkdir(shots, { recursive: true });
  const { root, dir } = await projectFixture();
  const b = fixture();
  b.edits.clips = [
    { id: "a", sourceStartMs: 0, sourceEndMs: 1000, rate: 1, holdMs: 0 },
    { id: "s", kind: "scene", src: "scenes/s.html", durationMs: 2000 },
  ];
  b.edits.camera = [
    { id: "z", startMs: 0, endMs: 1000, scale: 1.4, x: 400, y: 300 },
  ];
  b.narration.segments = [];
  await writeJson(path.join(dir, "edits.json"), b.edits);
  await writeJson(path.join(dir, "narration.json"), b.narration);
  const A = (s: string) => `position:absolute;margin:0;${s}`;
  const body = el("body", { style: "margin:0;font-family:Georgia,serif" }, [
    el(
      "h1",
      {
        id: "h",
        style: A(
          "left:120px;top:60px;width:300px;font:600 32px/40px Georgia,serif;letter-spacing:.5px;color:#1d2a44",
        ),
      },
      [t("Original heading")],
    ),
    el(
      "p",
      {
        id: "p",
        style: A("left:120px;top:130px;width:520px;font:20px/28px sans-serif"),
      },
      [t("Hello "), el("b", { id: "b" }, [t("world")]), t(" today")],
    ),
    el(
      "p",
      {
        id: "wrap",
        style: A(
          "left:120px;top:180px;width:260px;font:16px/22px sans-serif;text-align:justify",
        ),
      },
      [
        t(
          "A longer paragraph that wraps across several lines so the editor must wrap at the same width.",
        ),
      ],
    ),
    el(
      "button",
      {
        id: "btn",
        style: A(
          "left:120px;top:290px;width:140px;height:44px;font:15px sans-serif;border-radius:8px;border:1px solid #888;background:#f4f4f4",
        ),
      },
      [t("Save draft")],
    ),
    el(
      "div",
      {
        id: "flex",
        style: A(
          "left:300px;top:290px;height:44px;display:flex;align-items:center;gap:8px;padding:0 12px;font:15px sans-serif;background:#eef",
        ),
      },
      [
        el("span", {
          style: "width:16px;height:16px;background:#36c;display:block",
        }),
        t("Flex label"),
      ],
    ),
    el(
      "div",
      {
        id: "center",
        style: A(
          "left:120px;top:360px;width:300px;text-align:center;font:italic 18px/26px Georgia,serif;background:#fef",
        ),
      },
      [t("Centred italic text")],
    ),
    el("input", {
      id: "in",
      type: "text",
      value: "ada@example.com",
      style: A(
        "left:120px;top:410px;width:260px;height:34px;box-sizing:border-box;padding:4px 10px;font:16px sans-serif;border:1px solid #999",
      ),
    }),
    el(
      "span",
      { id: "inl", style: A("left:450px;top:420px;font:14px sans-serif") },
      [
        t("Before "),
        el("a", { id: "lnk", href: "http://x.test/" }, [t("a link")]),
        t(" after"),
      ],
    ),
  ]);
  await writeJson(path.join(dir, "events.json"), [
    {
      type: 4,
      timestamp: 1000,
      data: { href: "http://example.test", width: 1120, height: 700 },
    },
    {
      type: 2,
      timestamp: 1001,
      data: {
        initialOffset: { left: 0, top: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [el("html", {}, [el("head", {}), body])],
        },
      },
    },
  ]);
  await mkdir(path.join(dir, "assets"));
  await mkdir(path.join(dir, "scenes"));
  await writeFile(
    path.join(dir, "scenes/s.html"),
    '<!doctype html><html><body style="margin:0;background:#f5f1e8"><h1 id="hero" style="position:absolute;left:180px;top:140px;margin:0;font:700 56px/1.1 sans-serif;width:600px">Scene title that wraps onto two lines</h1></body></html>',
  );
  const rr = path.dirname(createRequire(import.meta.url).resolve("rrweb"));
  await writeFile(
    path.join(dir, "assets/rrweb.js"),
    await readFile(path.join(rr, "rrweb.umd.cjs")),
  );
  await writeFile(
    path.join(dir, "assets/rrweb.css"),
    await readFile(path.join(rr, "style.css")),
  );
  const preview = await serveReplay(dir, { port: 0 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    });
    await page.goto(preview.url);
    await page.waitForFunction(
      () => (window as any).__replayLab?.state().ready,
    );
    await page.evaluate(() => (window as any).__replayLab.scenesReady());
    await page.locator('[data-tab="edit"]').click();
    await page.addStyleTag({
      content:
        "#selection-toolbar,.direct-outline,#hover-box,.text-edit-marks,.inline-text-ring,.inline-text-status,#selection-box{visibility:hidden!important}",
    });
    const results: string[] = [];
    const check = async (
      name: string,
      frameSel: string,
      sel: string,
      dx = 0.5,
      ms = 500,
    ) => {
      await page.evaluate((x) => (window as any).__replayLab.seek(x), ms);
      const loc = page.frameLocator(frameSel).locator(sel);
      const box = (await loc.boundingBox())!;
      const clip = {
        x: Math.floor(box.x - 6),
        y: Math.floor(box.y - 6),
        width: Math.ceil(box.width + 12),
        height: Math.ceil(box.height + 12),
      };
      await page.mouse.move(5, 5);
      const before = await page.screenshot({ clip });
      await page.mouse.dblclick(box.x + box.width * dx, box.y + box.height / 2);
      const f = page
        .frameLocator(frameSel)
        .locator("demohunter-text-editor .f");
      await f.waitFor();
      await f.evaluate((n: any) => {
        const st = n.ownerDocument.createElement("style");
        st.textContent = ".f{caret-color:transparent!important}";
        n.getRootNode().append(st);
        n.setSelectionRange(0, 0);
      });
      await page.evaluate(() => {
        for (const e of document.querySelectorAll<HTMLElement>(
          ".inline-text-ring,.inline-text-status",
        ))
          e.style.visibility = "hidden";
      });
      await page.waitForTimeout(50);
      const during = await page.screenshot({ clip });
      await writeFile(`${shots}/align-${name}-before.png`, before);
      await writeFile(`${shots}/align-${name}-editing.png`, during);
      const diff = await page.evaluate(
        async ([a, b]) => {
          const load = async (s: string) => {
            const i = new Image();
            i.src = "data:image/png;base64," + s;
            await i.decode();
            const c = document.createElement("canvas");
            c.width = i.width;
            c.height = i.height;
            const x = c.getContext("2d")!;
            x.drawImage(i, 0, 0);
            return x.getImageData(0, 0, i.width, i.height).data;
          };
          const p = await load(a!),
            q = await load(b!);
          const W = new Image();
          W.src = "data:image/png;base64," + a;
          await W.decode();
          const w = W.width,
            h = W.height;
          let ink = 0;
          for (let i = 0; i < p.length; i += 4)
            if (p[i]! + p[i + 1]! + p[i + 2]! < 450) ink++;
          let best = { d: 1e9, dx: 0, dy: 0 };
          for (let dy = -4; dy <= 4; dy++)
            for (let dx = -4; dx <= 4; dx++) {
              let d = 0;
              for (let y = 4; y < h - 4; y++)
                for (let x = 4; x < w - 4; x++) {
                  const i = (y * w + x) * 4,
                    j = ((y + dy) * w + x + dx) * 4;
                  const e =
                    Math.abs(p[i]! - q[j]!) +
                    Math.abs(p[i + 1]! - q[j + 1]!) +
                    Math.abs(p[i + 2]! - q[j + 2]!);
                  if (e > 60) d++;
                }
              if (d < best.d) best = { d, dx, dy };
            }
          return { d: best.d, ink, shift: `${best.dx},${best.dy}` };
        },
        [before.toString("base64"), during.toString("base64")],
      );
      results.push(
        `${name}: ${diff.d}/${diff.ink} px differ at best shift ${diff.shift}`,
      );
      // Mixed formatting is typed in the paragraph's own style.
      if (name !== "paragraph-mixed") {
        expect(diff.shift).toBe("0,0");
        expect(diff.d / Math.max(1, diff.ink)).toBeLessThan(0.01);
      }
      await page.keyboard.press("Escape");
      await f.waitFor({ state: "detached" });
    };
    await check("heading-zoom", "#replay iframe", "#h", 0.3);
    await check("paragraph-mixed", "#replay iframe", "#p", 0.03);
    await check("bold-inline", "#replay iframe", "#b");
    await check("wrapped", "#replay iframe", "#wrap", 0.2);
    await check("button", "#replay iframe", "#btn");
    await check("flex", "#replay iframe", "#flex", 0.6);
    await check("center", "#replay iframe", "#center");
    await check("input", "#replay iframe", "#in", 0.3);
    await check("link", "#replay iframe", "#lnk");
    await check("scene-wrap", ".scene-frame.scene", "#hero", 0.3, 1500);
    if (process.env.DH_SHOTS) console.log(results.join("\n"));
  } finally {
    await browser.close();
    await preview.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
