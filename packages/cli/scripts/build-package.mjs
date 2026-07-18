import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(cliRoot, "../..");
const bunCommand = process.env.DEMOHUNTER_BUN_COMMAND ?? "bun";

run(bunCommand, ["run", "build:internals"], repoRoot);
run(bunCommand, ["run", "build"], cliRoot);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
  });

  if (result.status === 0) return;

  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  throw new Error(`Package build failed with exit code ${result.status ?? "unknown"}: ${command} ${args.join(" ")}`);
}
