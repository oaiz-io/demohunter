import { copyFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(packageRoot, "src");
const distRoot = path.join(packageRoot, "dist");

const ASSETS = [
  "content/prompts/system.txt",
  "templates/base/layout.html",
  "templates/base/section.html",
  "templates/base/app.js",
  "templates/presets/minimal/styles.css",
  "templates/presets/terminal/styles.css",
  "templates/presets/notebook/styles.css",
];

async function assertExists(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Required asset missing: ${path.relative(packageRoot, filePath)}`);
  }
}

async function copyAsset(relativePath) {
  const source = path.join(srcRoot, relativePath);
  const destination = path.join(distRoot, relativePath);
  await assertExists(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

for (const asset of ASSETS) {
  await copyAsset(asset);
}

console.log(`Copied ${ASSETS.length} video-gen assets to dist/`);
