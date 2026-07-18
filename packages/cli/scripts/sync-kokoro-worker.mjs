import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.resolve(cliRoot, "../tts-kokoro/worker/demohunter_kokoro_worker.py");
const destinationPath = path.join(cliRoot, "dist/workers/demohunter_kokoro_worker.py");
const source = await readFile(sourcePath);

await mkdir(path.dirname(destinationPath), { recursive: true });
await writeFile(destinationPath, source);

const copied = await readFile(destinationPath);
const sourceHash = sha256(source);
const copiedHash = sha256(copied);

if (sourceHash !== copiedHash) {
  throw new Error(`Kokoro worker copy verification failed: ${sourceHash} != ${copiedHash}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
