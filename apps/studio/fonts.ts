import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
/** Interface fonts are bundled locally (OFL), never loaded from a CDN. */
const files: Record<string, [pkg: string, file: string]> = {
  "geist.woff2": [
    "@fontsource-variable/geist",
    "geist-latin-wght-normal.woff2",
  ],
  "geist-mono.woff2": [
    "@fontsource-variable/geist-mono",
    "geist-mono-latin-wght-normal.woff2",
  ],
  "literata.woff2": [
    "@fontsource-variable/literata",
    "literata-latin-wght-normal.woff2",
  ],
  "literata-italic.woff2": [
    "@fontsource-variable/literata",
    "literata-latin-wght-italic.woff2",
  ],
};
const cache = new Map<string, Promise<Buffer>>();
export function fontFile(name: string): Promise<Buffer> | undefined {
  const entry = files[name];
  if (!entry) return undefined;
  let data = cache.get(name);
  if (!data) {
    const root = path.dirname(require.resolve(`${entry[0]}/package.json`));
    data = readFile(path.join(root, "files", entry[1]));
    cache.set(name, data);
  }
  return data;
}
