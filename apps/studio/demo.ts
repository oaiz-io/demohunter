import { createServer } from "node:http";
import path from "node:path";
import { DEFAULT_DEMOHUNTER_CONFIG } from "@demohunter/sdk";
import type { DemoHunterTour } from "@demohunter/sdk";
import { captureReplay } from "./capture.js";

export const demoHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fractions, made visible</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f5ef;color:#24352f;font-family:Arial,sans-serif}.lesson{display:grid;grid-template-columns:230px 1fr;min-height:700px}.sidebar{border-right:1px solid #dadfd4;padding:38px 26px;background:#eaece2}.brand{font-weight:800;font-size:18px;letter-spacing:-.5px}.brand span{color:#658064}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#758075;margin-top:64px}.sidebar h2{font-size:26px;font-weight:500;line-height:1.25}.lesson-nav{display:grid;gap:22px;margin-top:44px;color:#718071;font-size:13px}.lesson-nav .active{color:#253e2b;font-weight:bold}.main{padding:44px 60px}.topline{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#728172}.pill{border:1px solid #cfd6c8;padding:8px 13px;border-radius:30px}.main h1{font-family:Georgia,serif;font-weight:400;font-size:54px;letter-spacing:-2px;max-width:600px;margin:38px 0 14px}.subtitle{color:#778171;font-size:16px}.visual{display:flex;gap:35px;align-items:center;margin:45px 0 24px}.fraction-card{border:1px solid #d4d9cb;border-radius:18px;background:#fffef9;padding:25px;width:245px;min-height:215px;text-align:center}.fraction{display:inline-grid;font-family:Georgia,serif;font-size:46px;line-height:1.05;min-width:60px}.fraction b{font-weight:400}.fraction b:first-child{border-bottom:2px solid #425a40;padding-bottom:6px;margin-bottom:6px}.bars{display:flex;height:32px;margin-top:24px;gap:4px}.bars i{flex:1;background:#e6e9dc;border-radius:4px}.bars i.filled{background:#a7bb83}.equals{font:35px Georgia,serif;color:#86927c}.caption{font-size:14px;color:#58734c;margin-top:22px;min-height:40px}.teacher-note{border-left:3px solid #c4a36c;padding:10px 16px;color:#958061;font-size:12px;margin-top:25px;background:#f0ece1}button{background:#294333;color:white;border:0;border-radius:8px;padding:12px 20px;cursor:pointer;font-size:12px}.footer{display:flex;justify-content:space-between;align-items:center;margin-top:24px;color:#86917b;font-size:11px}
</style></head><body><div class="lesson"><aside class="sidebar" id="lesson-sidebar"><div class="brand">field<span>notes</span> / learn</div><div class="eyebrow">Mathematics · 06</div><h2>A little more<br>understanding.</h2><div class="lesson-nav"><span class="active">01 &nbsp; Seeing fractions</span><span>02 &nbsp; Equal parts</span><span>03 &nbsp; Try it yourself</span></div></aside><main class="main"><div class="topline"><span>THE EVERYDAY MATH SERIES</span><span class="pill">Lesson 06 / 3 min</span></div><h1 id="lesson-title">Different numbers.<br>The same amount.</h1><p class="subtitle" id="lesson-subtitle">A visual introduction to equivalent fractions.</p><div class="visual" id="fraction-comparison"><div class="fraction-card" id="first-fraction"><div class="fraction"><b>1</b><b>2</b></div><div class="bars"><i class="filled"></i><i></i></div></div><span class="equals">=</span><div class="fraction-card" id="second-fraction"><div class="fraction"><b id="numerator">2</b><b id="denominator">4</b></div><div class="bars" id="second-bars"><i class="filled"></i><i class="filled"></i><i></i><i></i></div></div></div><p class="caption" id="explanation">One half and two quarters cover the same space.</p><aside class="teacher-note" id="teacher-note">TEACHER NOTE · Draft example. Remove this note before sharing.</aside><div class="footer"><span id="step-label">01 — START WITH WHAT YOU SEE</span><button id="next-step">Explore the next step →</button></div></main></div><script>
let step=0;document.querySelector('#next-step').addEventListener('click',()=>{step++;if(step===1){document.querySelector('#numerator').textContent='3';document.querySelector('#denominator').textContent='6';document.querySelector('#second-bars').innerHTML='<i class="filled"></i><i class="filled"></i><i class="filled"></i><i></i><i></i><i></i>';document.querySelector('#explanation').textContent='Multiply the top and bottom by the same number.';document.querySelector('#step-label').textContent='02 — MORE PARTS, SAME AMOUNT';}else{document.querySelector('#lesson-subtitle').textContent='The pieces get smaller. The total stays the same.';document.querySelector('#explanation').textContent='1/2 = 2/4 = 3/6. Three ways to describe one half.';document.querySelector('#step-label').textContent='03 — ONE IDEA, MANY EXPRESSIONS';document.querySelector('#next-step').textContent='You have got it ✓';}});
</script></body></html>`;

export async function createDemo(projectDir: string): Promise<string> {
  const app = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(demoHtml);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as { port: number }).port;
  const tour: DemoHunterTour = {
    id: "fractions-replay",
    title: "Fractions, made visible",
    async run({ page, narrate, narrateWhile, chapter }) {
      await chapter("Seeing fractions");
      await narrate(
        "One half and two quarters look different, but they describe the same amount.",
      );
      await chapter("Equal parts");
      await narrateWhile(
        "Multiply the top and bottom by three. We now have three sixths, still exactly one half.",
        async ({ sleep }) => {
          await sleep(700);
          await page
            .getByRole("button", { name: "Explore the next step" })
            .click();
        },
      );
      await chapter("The same amount");
      await narrateWhile(
        "The pieces get smaller, but the total stays the same. That is what equivalent fractions mean.",
        async ({ sleep }) => {
          await sleep(700);
          await page
            .getByRole("button", { name: "Explore the next step" })
            .click();
        },
      );
    },
  };
  try {
    return await captureReplay({
      projectDir,
      tourFile: { path: "built-in:fractions", tour },
      loadedConfig: {
        projectRoot: process.cwd(),
        configPath: "built-in:fractions",
        config: {
          ...DEFAULT_DEMOHUNTER_CONFIG,
          baseURL: `http://127.0.0.1:${port}`,
          outputDir: path.dirname(projectDir),
          cacheDir: path.resolve(".demohunter/cache"),
          viewport: { width: 1120, height: 700 },
          record: {
            ...DEFAULT_DEMOHUNTER_CONFIG.record,
            cursor: false,
            showCursor: false,
            showClickRipple: false,
          },
        },
      },
    });
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
}
