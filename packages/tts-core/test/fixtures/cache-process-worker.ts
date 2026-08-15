import { appendFile } from "node:fs/promises";

import {
  createNarrationRequest,
  resolveNarrationFromCache,
  type NarrationProvider,
} from "../../src/index.ts";

const [cacheDir, invocationLog, label] = process.argv.slice(2);

if (cacheDir === undefined || invocationLog === undefined || label === undefined) {
  throw new Error("Expected cache directory, invocation log, and process label arguments.");
}

const request = createNarrationRequest({
  provider: "multiprocess-fixture",
  model: "fixture-v1",
  voice: "fixture",
  format: "wav",
  sampleRate: 24_000,
  instructions: "",
  text: "Coordinate this cache write.",
});
const provider: NarrationProvider = {
  async synthesize(preparedRequest) {
    await appendFile(invocationLog, `${label}\n`, "utf8");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));

    return {
      request: preparedRequest,
      output: { kind: "bytes", bytes: new Uint8Array([7, 4, 1, 8, 5, 2]) },
      metadata: {
        provider: preparedRequest.provider,
        model: preparedRequest.model,
        voice: preparedRequest.voice,
        format: preparedRequest.format,
        sampleRate: preparedRequest.sampleRate,
      },
    };
  },
};

const result = await resolveNarrationFromCache({
  cacheDir,
  request,
  provider,
  measureDurationMs: async () => 600,
  lockWaitTimeoutMs: 5_000,
  lockPollIntervalMs: 10,
});

process.stdout.write(`${JSON.stringify({
  source: result.source,
  key: result.entry.key,
  metadataPath: result.entry.metadataPath,
})}\n`);
