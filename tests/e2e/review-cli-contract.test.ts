import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDemohunterTarballPath } from "../helpers/demohunter-tarball.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntryPoint = path.join(repoRoot, "packages/cli/src/bin/demohunter.ts");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("review cli contract", () => {
  test(
    "scaffolds, generates, serves, and verifies a review from a real repository",
    async () => {
      const cwd = await makeReviewProject();

      // --- init -------------------------------------------------------------
      const init = await runCli(cwd, ["review", "init", "--base", "main", "--id", "pr-e2e-review"]);
      expect(init.exitCode, init.stderr).toBe(0);
      expect(init.stdout).toContain("Scaffolded reviews/pr-e2e-review.review.ts");
      expect(init.stdout).toContain("Changed files: 3");

      const scaffold = await readFile(path.join(cwd, "reviews/pr-e2e-review.review.ts"), "utf8");
      expect(scaffold).toContain('id: "pr-e2e-review"');
      expect(scaffold).toContain("src/app.ts");
      // Scaffolds never carry shas; the lock records them instead.
      expect(scaffold).not.toMatch(/\b[0-9a-f]{40}\b/);

      // --- generate ---------------------------------------------------------
      await writeFile(path.join(cwd, "reviews/pr-e2e-review.review.ts"), authoredReview(), "utf8");
      await runGit(cwd, ["add", "--all"]);
      await runGit(cwd, ["commit", "--quiet", "-m", "author the review"]);

      const generate = await runCli(cwd, [
        "review",
        "generate",
        "reviews/pr-e2e-review.review.ts",
        "--base",
        "main",
        "--run-verification",
        "--no-video",
      ]);
      expect(generate.exitCode, generate.stderr).toBe(0);
      expect(generate.stdout).toContain("Verification:    passed");
      expect(generate.stdout).toContain("changed files");

      const reviewDir = path.join(cwd, ".demohunter/reviews/pr-e2e-review");
      for (const artifact of ["index.html", "review.lock.json", "assets/viewer.css", "data/review.json"]) {
        await access(path.join(reviewDir, artifact));
      }

      const lock = JSON.parse(await readFile(path.join(reviewDir, "review.lock.json"), "utf8")) as {
        git: { headSha: string; mergeBaseSha: string; worktree: { clean: boolean } };
        coverage: { complete: boolean; accountedCount: number; totalCount: number };
        verification: { status: string };
      };
      const headSha = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      const mergeBaseSha = (await runGit(cwd, ["merge-base", "main", "HEAD"])).stdout.trim();

      expect(lock.git.headSha).toBe(headSha);
      expect(lock.git.mergeBaseSha).toBe(mergeBaseSha);
      expect(lock.git.worktree.clean).toBe(true);
      expect(lock.coverage.complete).toBe(true);
      expect(lock.coverage.accountedCount).toBe(lock.coverage.totalCount);
      expect(lock.verification.status).toBe("passed");

      // The generated artifact must not dirty the tree it describes.
      expect((await runGit(cwd, ["status", "--porcelain"])).stdout.trim()).toBe("");

      // --- verify -----------------------------------------------------------
      const verify = await runCli(cwd, ["review", "verify", "pr-e2e-review"]);
      expect(verify.exitCode, verify.stderr).toBe(0);
      expect(verify.stdout).toContain("Review artifact verified");
      expect(verify.stdout).not.toContain("FAIL ");

      // --- serve ------------------------------------------------------------
      await expectServedOnLoopback(cwd, reviewDir);

      // --- staleness --------------------------------------------------------
      await writeFile(path.join(cwd, "src/app.ts"), "export const app = 3;\n", "utf8");
      await runGit(cwd, ["add", "--all"]);
      await runGit(cwd, ["commit", "--quiet", "-m", "move HEAD"]);

      const stale = await runCli(cwd, ["review", "verify", "pr-e2e-review"]);
      expect(stale.exitCode).toBe(1);
      expect(stale.stdout).toContain("FAIL stale");
      expect(stale.stderr).toContain("failed verification");
    },
    180_000,
  );

  test(
    "refuses to generate from a dirty work tree and names the unaccounted files",
    async () => {
      const cwd = await makeReviewProject();
      await writeProjectFile(cwd, "reviews/pr-e2e-review.review.ts", authoredReview());
      await runGit(cwd, ["add", "--all"]);
      await runGit(cwd, ["commit", "--quiet", "-m", "author the review"]);

      await writeFile(path.join(cwd, "src/app.ts"), "export const app = 99;\n", "utf8");
      const dirty = await runCli(cwd, [
        "review",
        "generate",
        "reviews/pr-e2e-review.review.ts",
        "--base",
        "main",
        "--no-video",
      ]);
      expect(dirty.exitCode).toBe(1);
      expect(dirty.stderr).toContain("work tree is not clean");

      await runGit(cwd, ["checkout", "--", "src/app.ts"]);
      await writeFile(path.join(cwd, "src/unexplained.ts"), "export const extra = true;\n", "utf8");
      await runGit(cwd, ["add", "--all"]);
      await runGit(cwd, ["commit", "--quiet", "-m", "add an unexplained file"]);

      const incomplete = await runCli(cwd, [
        "review",
        "generate",
        "reviews/pr-e2e-review.review.ts",
        "--base",
        "main",
        "--no-video",
      ]);
      expect(incomplete.exitCode).toBe(1);
      expect(incomplete.stderr).toContain("src/unexplained.ts");
      expect(incomplete.stderr).toContain("coverage group");
    },
    180_000,
  );
});

/** Starts `review serve`, checks the real response, then shuts it down. */
async function expectServedOnLoopback(cwd: string, reviewDir: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, cliEntryPoint, "review", "serve", "pr-e2e-review"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  try {
    const baseUrl = await readServedUrl(child.stdout);

    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const indexResponse = await fetch(`${baseUrl}/`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-security-policy")).toContain("default-src 'none'");

    const html = await indexResponse.text();
    expect(html).toBe(await readFile(path.join(reviewDir, "index.html"), "utf8"));
    expect(html).toContain('<section id="coverage">');

    expect((await fetch(`${baseUrl}/assets/viewer.css`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/../../../etc/passwd`)).status).not.toBe(200);
    expect((await fetch(`${baseUrl}/`, { headers: { host: "evil.example" } })).status).toBe(421);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}

async function readServedUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        throw new Error(`review serve exited before printing a URL: ${buffered}`);
      }

      buffered += decoder.decode(value, { stream: true });
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(buffered);

      if (match !== null) {
        return match[0];
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function makeReviewProject(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "demohunter-review-e2e-"));
  tempRoots.push(cwd);

  const tarballPath = await getDemohunterTarballPath();

  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      { name: "review-e2e-fixture", private: true, type: "module", dependencies: { demohunter: `file:${tarballPath}` } },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(cwd, "demohunter.config.ts"),
    'export default { baseURL: "http://127.0.0.1:4173" };\n',
  );

  await runGit(cwd, ["init", "--quiet", "--initial-branch=main", "."]);
  await runGit(cwd, ["config", "user.email", "review@example.com"]);
  await runGit(cwd, ["config", "user.name", "Review Fixture"]);
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\nbun.lock\n.demohunter/\n");
  await writeProjectFile(cwd, "src/app.ts", "export const app = 1;\n");
  await writeProjectFile(cwd, "src/app.test.ts", "export const covered = false;\n");
  await runGit(cwd, ["add", "--all"]);
  await runGit(cwd, ["commit", "--quiet", "-m", "base"]);

  await runGit(cwd, ["checkout", "--quiet", "-b", "feature"]);
  await writeProjectFile(cwd, "src/app.ts", "export const app = 2;\n");
  await writeProjectFile(cwd, "src/app.test.ts", "export const covered = true;\n");
  await writeProjectFile(cwd, "README.md", "# fixture\n");
  await runGit(cwd, ["add", "--all"]);
  await runGit(cwd, ["commit", "--quiet", "-m", "feature work"]);

  const install = await spawnCommand([process.execPath, "install"], cwd);
  expect(install.exitCode, install.stderr).toBe(0);

  return cwd;
}

function authoredReview(): string {
  return `import {
  changeSet,
  coverageGroup,
  defineReview,
  diffEvidence,
  verificationCommand,
} from "demohunter";

export default defineReview({
  id: "pr-e2e-review",
  title: "End-to-end review fixture",
  problem: { summary: "The exported constant needed to change." },
  chapters: [
    changeSet({
      id: "core",
      title: "Core change",
      intent: "Bumps the exported constant.",
      narration: "The exported constant moves from one to two.",
      files: ["src/app.ts"],
      evidence: [diffEvidence({ id: "app-diff", path: "src/app.ts", note: "Check the new value." })],
      reviewerChecks: [{ id: "value", check: "The exported value is two." }],
    }),
  ],
  verification: [
    verificationCommand({
      id: "noop",
      label: "Exit zero",
      command: ["node", "-e", "process.exit(0)"],
      rationale: "Stands in for the project's real test command.",
    }),
  ],
  coverage: {
    groups: [
      coverageGroup({
        id: "tests-and-docs",
        title: "Tests and docs",
        rationale: "Reviewed together with the behaviour above.",
        patterns: ["**/*.test.ts", "**/*.md", "reviews/**"],
      }),
    ],
  },
});
`;
}

async function writeProjectFile(cwd: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(cwd, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function runCli(cwd: string, args: string[]) {
  return spawnCommand([process.execPath, cliEntryPoint, ...args], cwd);
}

async function runGit(cwd: string, args: string[]) {
  const result = await spawnCommand(["git", ...args], cwd);

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  return result;
}

async function spawnCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}
