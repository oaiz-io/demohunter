import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntryPoint = path.join(repoRoot, "packages/cli/src/bin/demohunter.ts");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("recording and teardown", () => {
  test("stops the recording before authored teardown runs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "demohunter-teardown-e2e-"));
    tempRoots.push(cwd);
    const sitePath = path.join(cwd, "site", "index.html");
    await mkdir(path.dirname(sitePath), { recursive: true });
    await mkdir(path.join(cwd, "demos"), { recursive: true });
    await writeFile(
      sitePath,
      '<!doctype html><html lang="en"><body style="background: #fff"><h1>Visible work</h1></body></html>\n',
    );
    await writeFile(
      path.join(cwd, "demohunter.config.ts"),
      `export default {
  baseURL: ${JSON.stringify(pathToFileURL(sitePath).href)},
  record: { showActions: false, showChapters: false },
};
`,
    );
    // Teardown turns the whole page red and lingers, like visible cleanup would.
    await writeFile(
      path.join(cwd, "demos", "teardown.tour.ts"),
      `export default {
  id: "teardown-off-camera",
  title: "Teardown off camera",
  async run({ page }) {
    await page.getByRole("heading", { name: "Visible work" }).waitFor();
    await page.waitForTimeout(1_000);
  },
  async teardown({ page }) {
    await page.evaluate(() => {
      document.body.innerHTML = "";
      document.documentElement.style.background = "rgb(255, 0, 0)";
      document.body.style.background = "rgb(255, 0, 0)";
    });
    await page.waitForTimeout(1_500);
  },
};
`,
    );

    const generate = await run([process.execPath, cliEntryPoint, "generate", "demos/teardown.tour.ts"], cwd);
    expect(generate.exitCode).toBe(0);

    const videoPath = path.join(cwd, ".demohunter", "teardown-off-camera", "video.mp4");
    const lastFrame = await run(
      [
        "ffmpeg", "-v", "error", "-sseof", "-0.2", "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
      ],
      cwd,
    );
    expect(lastFrame.exitCode).toBe(0);
    const [red = 0, green = 0, blue = 0] = lastFrame.bytes;

    expect({ red, green, blue, teardownVisible: red > 200 && green < 80 && blue < 80 }).toEqual({
      red,
      green,
      blue,
      teardownVisible: false,
    });
  }, 60_000);
});

async function run(cmd: string[], cwd: string): Promise<{ bytes: Uint8Array; exitCode: number; stderr: string }> {
  const processResult = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).arrayBuffer(),
    new Response(processResult.stderr).text(),
  ]);

  return { bytes: new Uint8Array(stdout), exitCode, stderr };
}
