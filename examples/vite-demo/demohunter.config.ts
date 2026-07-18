import { defineConfig } from "demohunter";

const outputDir = process.env.DEMOHUNTER_EXAMPLE_OUTPUT_DIR ?? ".demohunter";

export default defineConfig({
  baseURL: "http://127.0.0.1:3200",
  cacheDir: process.env.DEMOHUNTER_EXAMPLE_CACHE_DIR ?? `${outputDir}/cache`,
  outputDir,
  record: {
    showActions: false,
  },
  // Kokoro remains opt-in: add a kokoro(...) descriptor with explicit local model/voices
  // and set tts: kokoroTTS(...) after importing both helpers from "demohunter".
});
