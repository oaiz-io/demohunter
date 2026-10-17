// Render an SVG icon to PNGs and a macOS .icns (needs iconutil on macOS).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const [svgPath, outBase] = process.argv.slice(2);
const svg = readFileSync(svgPath, "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", '<svg width="1024" height="1024" ')}</body></html>`);
const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();
writeFileSync(`${outBase}.png`, png);
if (process.platform === "darwin") {
  const set = `${outBase}.iconset`;
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const px = size * scale;
      execFileSync("sips", ["-z", String(px), String(px), `${outBase}.png`, "--out", path.join(set, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "ignore" });
    }
  execFileSync("iconutil", ["-c", "icns", set, "-o", `${outBase}.icns`]);
  rmSync(set, { recursive: true, force: true });
}
console.log("wrote", `${outBase}.png`, process.platform === "darwin" ? `${outBase}.icns` : "");
