import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntryPoint = path.join(repoRoot, "packages/cli/src/bin/demohunter.ts");
const tempRoots: string[] = [];
const firstRunBlockersTimeoutMs = 20_000;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("oss onboarding contract", () => {
  test("public docs advertise the npm install path", async () => {
    const [readme, gettingStarted, troubleshooting] = await Promise.all([
      readFile(path.join(repoRoot, "README.md"), "utf8"),
      readFile(path.join(repoRoot, "docs/getting-started.md"), "utf8"),
      readFile(path.join(repoRoot, "docs/troubleshooting.md"), "utf8"),
    ]);

    expect(readme).toContain("npm install --save-dev demohunter");
    expect(readme).toContain("npx playwright install chromium");
    expect(readme).toContain("npx demohunter init");
    expect(readme).toContain("npx demohunter generate");
    expect(readme).toContain("npx demohunter add-skill");
    expect(readme).toContain("OPENAI_API_KEY");
    expect(readme).not.toContain("REPO_ROOT");
    expect(readme).not.toContain("bun x demohunter");
    expect(readme).not.toContain("bun run");
    expect(readme).not.toMatch(/packages\/cli\/dist/);

    expect(gettingStarted).toContain("npm install --save-dev demohunter");
    expect(gettingStarted).toContain("npx playwright install chromium");
    expect(gettingStarted).toContain("npx demohunter init");
    expect(gettingStarted).toContain("npx demohunter generate");
    expect(gettingStarted).toContain("npx demohunter add-skill");
    expect(gettingStarted).not.toContain("REPO_ROOT");

    expect(troubleshooting).toContain("OPENAI_API_KEY");
    expect(troubleshooting).toContain("ffmpeg");
    expect(troubleshooting).toContain("ERR_CONNECTION_REFUSED");
    expect(troubleshooting).toContain("npx playwright install chromium");
  });

  test("public CI runs verify and dry-runs the publish", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/cache@v5");
    expect(workflow).toContain("apt-get install -y ffmpeg");
    expect(workflow).toContain(
      "bun run --cwd packages/cli playwright install --with-deps chromium",
    );
    expect(workflow).not.toContain("bun x playwright install");
    expect(workflow).toContain("bun run verify");
    expect(workflow).toContain("npm publish --dry-run");
    expect(workflow).not.toContain("OPENAI_API_KEY:");
    expect(workflow).not.toContain("DEMOHUNTER_RUN_LIVE_OPENAI_TESTS: \"1\"");
  });

  test("release workflow can publish the current initial version before bumping future releases", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("- current");
    expect(workflow).toContain("default: current");
    expect(workflow).toContain('if [[ "${{ inputs.bump }}" != "current" ]]; then');
    expect(workflow).toContain("--workspaces=false");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain('npm view "demohunter@$VERSION" version');
    expect(workflow).toContain("for attempt in {1..10}; do");
    expect(workflow).toContain("sleep 6");
    expect(workflow).toContain('git checkout --detach "${{ steps.bump.outputs.tag }}"');
    expect(workflow).toContain("npm publish --access public");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN:");
  });

  test("surfaces actionable guidance for first-run blockers", async () => {
    const missingConfigCwd = await makeTempProject();
    const missingConfig = await runCli(missingConfigCwd, ["generate", "demos/sample.tour.ts"]);
    expect(missingConfig.exitCode).toBe(1);
    expect(missingConfig.stderr).toContain("Could not find demohunter.config.ts");
    expect(missingConfig.stderr).toContain('Run "demohunter init"');

    const invalidTourCwd = await writeProject({
      config: 'export default { baseURL: "http://127.0.0.1:4173" };\n',
      tour: "export default { nope: true };\n",
    });
    const invalidTour = await runCli(invalidTourCwd, ["generate", "demos/sample.tour.ts"]);
    expect(invalidTour.exitCode).toBe(1);
    expect(invalidTour.stderr).toContain("Tour file must default export");

    const unreachableCwd = await writeProject({
      config: 'export default { baseURL: "http://127.0.0.1:4173" };\n',
      tour: 'export default { id: "sample-smoke", title: "Sample", async run() {} };\n',
    });
    const unreachable = await runCli(unreachableCwd, ["generate", "demos/sample.tour.ts"]);
    expect(unreachable.exitCode).toBe(1);
    expect(unreachable.stderr).toContain("DemoHunter could not reach baseURL http://127.0.0.1:4173.");

    const missingKeyCwd = await writeProject({
      config: 'export default { baseURL: new URL("./site/index.html", import.meta.url).href };\n',
      tour: 'export default { id: "sample-smoke", title: "Sample", async run({ narrate }) { await narrate("Fresh narration"); } };\n',
      site: "<!doctype html><html><body><main><h1>Local site</h1></main></body></html>\n",
    });
    const missingKey = await runCli(missingKeyCwd, ["generate", "demos/sample.tour.ts"]);
    expect(missingKey.exitCode).toBe(1);
    expect(missingKey.stderr).toContain("OPENAI_API_KEY");
    expect(missingKey.stderr).toContain("narration cache");
  }, firstRunBlockersTimeoutMs);
});

async function makeTempProject(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-oss-onboarding-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function writeProject(input: { config: string; tour: string; site?: string }): Promise<string> {
  const cwd = await makeTempProject();
  await mkdir(path.join(cwd, "demos"), { recursive: true });
  if (input.site !== undefined) {
    await mkdir(path.join(cwd, "site"), { recursive: true });
    await writeFile(path.join(cwd, "site", "index.html"), input.site);
  }
  await writeFile(path.join(cwd, "demohunter.config.ts"), input.config);
  await writeFile(path.join(cwd, "demos", "sample.tour.ts"), input.tour);
  return cwd;
}

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processResult = Bun.spawn({
    cmd: [process.execPath, cliEntryPoint, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: buildEnv(),
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

function buildEnv(): Record<string, string | undefined> {
  const env = {
    ...process.env,
  } as Record<string, string | undefined>;

  delete env.OPENAI_API_KEY;
  delete env.DEMOHUNTER_RUN_LIVE_OPENAI_TESTS;

  return env;
}
