import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads the installed `demohunter` version by walking up from this module.
 *
 * Both the source tree (`packages/cli/src/...`) and the published bundle
 * (`dist/bin/...`) sit under the CLI package root, so the same walk works
 * without a build-time constant that could drift from package.json.
 */
export function readPackageVersion(startDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir;

  while (true) {
    const candidate = path.join(dir, "package.json");

    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };

      if (parsed.name === "demohunter" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Not the package manifest we are looking for; keep walking up.
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return "unknown";
    }

    dir = parent;
  }
}
