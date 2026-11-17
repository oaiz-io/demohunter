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

const filmPage = `<!doctype html><html><head><meta name="demohunter:duration" content="5000"></head>
<body style="margin:0;font-family:Arial,sans-serif">
<h1 id="line" style="margin:0;width:600px;line-height:1.2">Tides turn twice a day</h1>
<div id="box" style="width:400px;height:200px;line-height:1.2;overflow:hidden">The moon pulls the sea toward it, and the earth turns underneath.</div>
<h2 id="long" style="margin:0;width:100px">Supercalifragilistic</h2>
<div style="width:800px;height:450px;overflow:hidden"><div id="photo" style="width:800px;height:450px;background:#456"></div></div>
<script type="module">
  import { fitText, readTime, kenBurns } from "./motion.js";
  const line = document.getElementById("line"), box = document.getElementById("box");
  window.result = {
    line: fitText(line, { max: 400 }),
    box: fitText(box, { max: 200, min: 8 }),
    long: fitText(document.getElementById("long"), { max: 90, min: 14 }),
    again: fitText(line, { max: 400 }),
    reads: [readTime(""), readTime("Hi"), readTime("one two three"), readTime("  a b c d e f g h i j  ")],
  };
  window.measure = () => ({
    lineFits: line.scrollWidth <= line.clientWidth && line.getClientRects().length === 1 && line.clientHeight < 1.3 * parseFloat(line.style.fontSize) * 1.2,
    boxFits: box.scrollHeight <= box.clientHeight && box.scrollWidth <= box.clientWidth,
  });
  window.burns = kenBurns(document.getElementById("photo"), { from: { x: 0, y: 0, scale: 1 }, to: { x: -40, y: 20, scale: 1.5 }, at: 1000, dur: 2000, easing: "linear" });
  window.whole = kenBurns(document.createElement("div"), { at: 1000 });
</script></body></html>`;

test("kit fitText, readTime and kenBurns", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      if (!name)
        return new Response(filmPage, { headers: { "Content-Type": "text/html" } });
      return new Response(await readFile(path.join(kit, name)), {
        headers: { "Content-Type": "text/javascript" },
      });
    },
  });
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await tab.goto(`http://127.0.0.1:${server.port}/`);
    await tab.waitForFunction(() => (window as any).result && (window as any).burns);
    const result = await tab.evaluate(() => (window as any).result);
    // readTime: 500 + 300 per word, at least 800.
    expect(result.reads).toEqual([800, 800, 1400, 3500]);
    // The largest size that fits; one more pixel would not; same answer twice.
    expect(result.line).toBeGreaterThan(30);
    expect(result.line).toBeLessThan(400);
    expect(result.again).toBe(result.line);
    expect(await tab.evaluate(() => (window as any).measure())).toEqual({ lineFits: true, boxFits: true });
    const bigger = await tab.evaluate((px) => {
      const line = document.getElementById("line")!;
      line.style.whiteSpace = "nowrap";
      line.style.fontSize = `${px}px`;
      const over = line.scrollWidth > line.clientWidth;
      const box = document.getElementById("box")!;
      return { over, box: box.style.fontSize };
    }, result.line + 1);
    expect(bigger.over).toBe(true);
    expect(result.box).toBeGreaterThan(8);
    expect(result.box).toBeLessThan(200);
    // A word that never fits gets the minimum.
    expect(result.long).toBe(14);

    // kenBurns is a seekable animation of the scene clock.
    const at = (ms: number) =>
      tab.evaluate((ms) => {
        const a = (window as any).burns as Animation;
        a.pause();
        a.currentTime = ms;
        return getComputedStyle(document.getElementById("photo")!).transform;
      }, ms);
    expect(await at(0)).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(await at(2000)).toBe("matrix(1.25, 0, 0, 1.25, -20, 10)");
    expect(await at(5000)).toBe("matrix(1.5, 0, 0, 1.5, -40, 20)");
    expect(await at(2000)).toBe("matrix(1.25, 0, 0, 1.25, -20, 10)");
    // Without dur it runs to the end of the scene (5000 ms).
    expect(
      await tab.evaluate(() => ((window as any).whole as Animation).effect!.getTiming().duration),
    ).toBe(4000);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30000);
