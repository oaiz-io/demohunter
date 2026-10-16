import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const kit = path.join(import.meta.dir, "scene-kit");
const page = `<!doctype html><html><body style="margin:0;width:1920px;height:1080px">
<div id="stage" style="position:absolute;inset:0"></div>
<script type="module">
  import { cursorClick, CURSOR_TIP } from "./show.js";
  window.tip = CURSOR_TIP;
  window.cursor = cursorClick(document.getElementById("stage"), { x: 700, y: 420 }, { at: 1000 });
</script></body></html>`;

// Regression: a cursor positioned with \`transform\` and pressed with \`scale\`
// slid toward the page corner on every click (CSS applies scale before
// transform). The kit cursor must keep its tip on target through the press.
test("kit cursor clicks with its tip fixed on the target", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      if (!name)
        return new Response(page, { headers: { "Content-Type": "text/html" } });
      return new Response(await readFile(path.join(kit, name)), {
        headers: { "Content-Type": "text/javascript" },
      });
    },
  });
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    await tab.goto(`http://127.0.0.1:${server.port}/`);
    await tab.waitForFunction(() => (window as any).cursor);
    const tips = await tab.evaluate(() => {
      const out: { t: number; x: number; y: number }[] = [];
      for (const t of [960, 1000, 1050, 1100, 1150, 1220, 1400]) {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = t;
        }
        const r = (window as any).cursor
          .querySelector("svg")
          .getBoundingClientRect();
        // The tip sits at (2, 2) of the 28-wide arrow, scaled with the press.
        const k = r.width / 28;
        out.push({ t, x: r.x + 2 * k, y: r.y + 2 * k });
      }
      return out;
    });
    for (const tip of tips) {
      expect(Math.abs(tip.x - 700)).toBeLessThan(1);
      expect(Math.abs(tip.y - 420)).toBeLessThan(1);
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30000);
