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

describe("launch options", () => {
  test("pins the browser locale and time zone for the tour", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "demohunter-launch-e2e-"));
    tempRoots.push(cwd);
    const sitePath = path.join(cwd, "site", "index.html");
    await mkdir(path.dirname(sitePath), { recursive: true });
    await mkdir(path.join(cwd, "demos"), { recursive: true });
    await writeFile(sitePath, '<!doctype html><html lang="en"><body><h1>Dates</h1></body></html>\n');
    await writeFile(
      path.join(cwd, "demohunter.config.ts"),
      `export default {
  baseURL: ${JSON.stringify(pathToFileURL(sitePath).href)},
  launch: { headless: true, locale: "sv-SE", timezoneId: "Asia/Tokyo" },
};
`,
    );
    await writeFile(
      path.join(cwd, "demos", "dates.tour.ts"),
      `export default {
  id: "launch-options",
  title: "Launch options",
  async run({ page }) {
    const actual = await page.evaluate(() => ({
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    if (actual.language !== "sv-SE" || actual.timeZone !== "Asia/Tokyo") {
      throw new Error("Unexpected browser settings: " + JSON.stringify(actual));
    }
  },
};
`,
    );

    const processResult = Bun.spawn({
      cmd: [process.execPath, cliEntryPoint, "generate", "demos/dates.tour.ts", "--dry-run"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [exitCode, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stderr).text(),
    ]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  }, 30_000);
});
