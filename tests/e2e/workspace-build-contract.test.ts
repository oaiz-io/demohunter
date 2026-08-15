import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPackageRoot = path.join(repoRoot, "packages/cli");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("workspace build contract", () => {
  test(
    "builds the workspace and exposes a single published demohunter package",
    async () => {
      await runRepoCommand(["run", "build"]);

      const builtEntryPoints = [
        "packages/cli/dist/index.js",
        "packages/cli/dist/index.d.ts",
        "packages/cli/dist/bin/demohunter.js",
        "packages/cli/dist/bin/demohunter.d.ts",
        "packages/cli/templates/starter/demohunter.config.ts",
        "packages/cli/templates/starter/demos/sample.tour.ts",
        "packages/cli/templates/starter/demos/sample-site/index.html",
      ];

      for (const relativePath of builtEntryPoints) {
        await access(path.join(repoRoot, relativePath));
      }

      const exportProbe = await runBunEval(`
      const demohunter = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/cli/dist/index.js")).href)});
      const cli = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/cli/dist/bin/demohunter.js")).href)});
      console.log(JSON.stringify({
        demohunter: {
          defineConfig: typeof demohunter.defineConfig,
          defineTour: typeof demohunter.defineTour,
          DEFAULT_DEMOHUNTER_CONFIG: typeof demohunter.DEFAULT_DEMOHUNTER_CONFIG,
        },
        cli: {
          runCli: typeof cli.runCli,
        },
      }));
    `);

      const exports = JSON.parse(exportProbe.stdout.trim()) as {
        demohunter: Record<string, string>;
        cli: Record<string, string>;
      };

      expect(exports.demohunter).toEqual({
        defineConfig: "function",
        defineTour: "function",
        DEFAULT_DEMOHUNTER_CONFIG: "object",
      });
      expect(exports.cli).toEqual({
        runCli: "function",
      });

      const declarations = await readFile(path.join(repoRoot, "packages/cli/dist/index.d.ts"), "utf8");
      expect(declarations).toContain("DemoHunterRunContext");
      expect(declarations).toContain("WaitForStableOptions");
      expect(declarations).not.toContain("@demohunter/");

      const binDeclarations = await readFile(path.join(repoRoot, "packages/cli/dist/bin/demohunter.d.ts"), "utf8");
      expect(binDeclarations).not.toContain("@demohunter/");

      const packed = await packCliPackage();
      const packedPaths = packed.files.map((file) => file.path).sort();
      expect(packedPaths).toContain("README.md");
      expect(packedPaths).toContain("LICENSE");
      expect(packedPaths).toContain("CHANGELOG.md");
      expect(packedPaths).toContain("dist/index.d.ts");

      await expectPackedTypesToWorkForConsumer(packed.filename);
      await expectPackageDocsToBeCleaned();
    },
    60_000,
  );
});

type PackedPackage = {
  filename: string;
  files: Array<{ path: string }>;
};

async function packCliPackage(): Promise<PackedPackage> {
  const packRoot = await makeTempRoot();
  const result = await spawnCommand(["npm", "pack", "--pack-destination", packRoot, "--json"], cliPackageRoot);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "npm pack failed");
  }

  const [packed] = JSON.parse(result.stdout) as PackedPackage[];

  if (packed === undefined) {
    throw new Error(`npm pack did not report a packed package: ${result.stdout}`);
  }

  return {
    ...packed,
    filename: path.join(packRoot, packed.filename),
  };
}

async function expectPackedTypesToWorkForConsumer(tarballPath: string): Promise<void> {
  const consumerRoot = await makeTempRoot();
  const packageRoot = path.join(consumerRoot, "node_modules/demohunter");
  const playwrightRoot = await realpath(path.join(cliPackageRoot, "node_modules/playwright"));
  const nodeTypesRoot = await realpath(path.join(repoRoot, "node_modules/@types/node"));

  await mkdir(packageRoot, { recursive: true });
  await mkdir(path.join(consumerRoot, "node_modules/@types"), { recursive: true });
  await symlink(playwrightRoot, path.join(consumerRoot, "node_modules/playwright"), "dir");
  await symlink(nodeTypesRoot, path.join(consumerRoot, "node_modules/@types/node"), "dir");
  await writeFile(path.join(consumerRoot, "package.json"), `{"type":"module"}\n`);

  const extractResult = await spawnCommand(
    ["tar", "-xzf", tarballPath, "-C", packageRoot, "--strip-components", "1"],
    consumerRoot,
  );

  if (extractResult.exitCode !== 0) {
    throw new Error(extractResult.stderr || extractResult.stdout || "Failed to extract packed package");
  }

  const packedPackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  expect(packedPackage.dependencies ?? {}).not.toHaveProperty("playwright");
  expect(packedPackage.peerDependencies).toMatchObject({
    playwright: ">=1.61",
  });

  await writeFile(
    path.join(consumerRoot, "index.ts"),
    `import { defineConfig, defineTour, type DemoHunterRunContext } from "demohunter";

export const config = defineConfig({ baseURL: "http://localhost:3000" });

export default defineTour({
  id: "consumer-check",
  title: "Consumer check",
  async run(context: DemoHunterRunContext) {
    await context.page.goto("/");
  },
});
`,
  );

  const tscResult = await spawnCommand(
    [
      path.join(repoRoot, "node_modules/.bin/tsc"),
      "--noEmit",
      "--moduleResolution",
      "node16",
      "--module",
      "node16",
      "--target",
      "es2022",
      "--lib",
      "esnext,dom",
      "--types",
      "node",
      "--strict",
      "index.ts",
    ],
    consumerRoot,
  );

  expect(tscResult.exitCode, tscResult.stderr || tscResult.stdout).toBe(0);
}

async function expectPackageDocsToBeCleaned(): Promise<void> {
  for (const fileName of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    await expect(access(path.join(cliPackageRoot, fileName))).rejects.toThrow();
  }
}

async function runRepoCommand(args: string[]): Promise<void> {
  const result = await spawnCommand([process.execPath, ...args], repoRoot);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Command failed: bun ${args.join(" ")}`);
  }
}

async function runBunEval(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return spawnCommand([process.execPath, "--eval", script], await makeTempRoot());
}

async function spawnCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processResult = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

async function makeTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-build-contract-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}
