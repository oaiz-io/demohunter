import { defineConfig } from "demohunter";

const outputDir = process.env.DEMOHUNTER_EXAMPLE_OUTPUT_DIR ?? ".demohunter";

export default defineConfig({
  baseURL: `http://127.0.0.1:${process.env.PORT ?? 3100}`,
  cacheDir: process.env.DEMOHUNTER_EXAMPLE_CACHE_DIR ?? `${outputDir}/cache`,
  outputDir,
});
