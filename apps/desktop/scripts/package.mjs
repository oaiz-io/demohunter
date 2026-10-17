// Builds a standalone, downloadable "DemoHunter Studio.app" (alpha) plus a
// .dmg and .zip in apps/desktop/out/. Unlike build-app.mjs (which links to
// this checkout), the bundle carries everything Studio needs: its sources,
// production dependencies and a Bun runtime. Chromium for rendering is
// downloaded on first launch; ffmpeg (for export) comes from the system.
//
//   node apps/desktop/scripts/package.mjs
//
// macOS only. Builds for the architecture it runs on. Signed ad hoc (not
// notarized), so first launch needs right-click → Open.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Packaging is macOS only.");
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const repo = path.resolve(desktop, "../..");
const out = path.join(desktop, "out");
const stage = path.join(out, "stage");
const name = "DemoHunter Studio";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const version = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).version;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const log = (msg) => console.log(`\n▸ ${msg}`);

// ------------------------------------------------------------ stage sources
log("Staging sources");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const skip = (rel) =>
  /(^|\/)(node_modules|dist|out|\.demohunter|\.studio|\.context|coverage)(\/|$)/.test(rel) ||
  /\.test\.ts$/.test(rel) ||
  /(^|\/)tests?(\/|$)/.test(rel);
function copyTree(from, to, base = from) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const rel = path.relative(base, src);
    if (skip(rel) || entry.isSymbolicLink()) continue;
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyTree(src, dst, base);
    } else fs.copyFileSync(src, dst);
  }
}
// Studio runs TypeScript from source and imports packages/*/src directly.
// Only files git tracks are bundled, so local .env files, logs or captures
// in the checkout never end up in a download.
// The agent guide (MCP get_guide) ships with Studio.
const tracked = execFileSync("git", ["ls-files", "-z", "--", "apps/studio", "packages", ".agents/skills/demohunter-replay"], { cwd: repo })
  .toString()
  .split("\0")
  .filter((rel) => rel && !skip(rel) && fs.existsSync(path.join(repo, rel)));
for (const rel of tracked) {
  fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
  fs.copyFileSync(path.join(repo, rel), path.join(stage, rel));
}
fs.mkdirSync(path.join(stage, "apps/desktop/build"), { recursive: true });
for (const file of ["main.cjs", "preload.cjs", "build/icon.png"])
  fs.copyFileSync(path.join(desktop, file), path.join(stage, "apps/desktop", file));
copyTree(path.join(desktop, "ui"), path.join(stage, "apps/desktop/ui"));
const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
fs.writeFileSync(
  path.join(stage, "apps/desktop/package.json"),
  JSON.stringify({ name: desktopPkg.name, private: true, version, main: "main.cjs" }, null, 2),
);
const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
// Electron loads Resources/app/package.json; main points at the shell.
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "demohunter-studio",
      productName: name,
      version,
      private: true,
      type: rootPkg.type,
      main: "apps/desktop/main.cjs",
      workspaces: ["apps/studio", "packages/*"],
      dependencies: { playwright: rootPkg.devDependencies.playwright },
    },
    null,
    2,
  ),
);

// ------------------------------------------------------- production modules
log("Installing production dependencies");
const bunPkg = path.dirname(
  fileURLToPath(import.meta.resolve(`@oven/bun-darwin-${arch === "arm64" ? "aarch64" : "x64"}/package.json`)),
);
const bunBin = path.join(bunPkg, "bin/bun");
// Hoisted: real folders (no symlink store), so the bundle is self-contained.
// The repo's lockfile keeps versions identical to development.
fs.copyFileSync(path.join(repo, "bun.lock"), path.join(stage, "bun.lock"));
sh(bunBin, ["install", "--omit", "dev", "--linker", "hoisted"], { cwd: stage });
fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
fs.copyFileSync(bunBin, path.join(stage, "bin/bun"));
fs.chmodSync(path.join(stage, "bin/bun"), 0o755);
// Workspace packages are linked into node_modules: keep the links, but make
// them relative so they survive copying into the app; copy anything that
// points outside the bundle.
function fixLinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(full);
      fs.rmSync(full);
      if (target.startsWith(stage + path.sep)) fs.symlinkSync(path.relative(dir, target), full);
      else fs.cpSync(target, full, { recursive: true, dereference: true });
    } else if (entry.isDirectory() && (entry.name.startsWith("@") || entry.name === ".bin")) fixLinks(full);
  }
}
fixLinks(path.join(stage, "node_modules"));

// ------------------------------------------------------------ app bundle
log("Assembling the app");
const electronDist = path.join(path.dirname(fileURLToPath(import.meta.resolve("electron/package.json"))), "dist");
const appDir = path.join(out, `${name}.app`);
fs.rmSync(appDir, { recursive: true, force: true });
sh("ditto", [path.join(electronDist, "Electron.app"), appDir]);
const contents = path.join(appDir, "Contents");
const plist = path.join(contents, "Info.plist");
const set = (key, value) => execFileSync("plutil", ["-replace", key, "-string", value, plist]);
set("CFBundleName", name);
set("CFBundleDisplayName", name);
set("CFBundleIdentifier", "io.oaiz.demohunter.studio");
set("CFBundleShortVersionString", version);
set("CFBundleVersion", version);
set("CFBundleIconFile", "icon.icns");
set("NSHumanReadableCopyright", "© OAIZ AB");
execFileSync("plutil", ["-replace", "CFBundleDocumentTypes", "-json", JSON.stringify([{ CFBundleTypeName: "Folder", CFBundleTypeRole: "Viewer", LSItemContentTypes: ["public.folder"], LSHandlerRank: "Alternate" }]), plist]);
fs.copyFileSync(path.join(desktop, "build/icon.icns"), path.join(contents, "Resources/icon.icns"));
fs.rmSync(path.join(contents, "Resources/electron.icns"), { force: true });
fs.rmSync(path.join(contents, "Resources/default_app.asar"), { force: true });
sh("ditto", [stage, path.join(contents, "Resources/app")]);
log("Signing (ad hoc)");
sh("codesign", ["--force", "--deep", "--sign", "-", appDir]);

// ------------------------------------------------------------ disk images
log("Creating .dmg and .zip");
const base = `DemoHunter-Studio-${version}-alpha-mac-${arch}`;
const dmgRoot = path.join(out, "dmg");
fs.rmSync(dmgRoot, { recursive: true, force: true });
fs.mkdirSync(dmgRoot);
sh("ditto", [appDir, path.join(dmgRoot, `${name}.app`)]);
fs.symlinkSync("/Applications", path.join(dmgRoot, "Applications"));
const dmg = path.join(out, `${base}.dmg`);
fs.rmSync(dmg, { force: true });
sh("hdiutil", ["create", "-volname", `${name} ${version} alpha`, "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmg]);
fs.rmSync(dmgRoot, { recursive: true, force: true });
const zip = path.join(out, `${base}.zip`);
fs.rmSync(zip, { force: true });
sh("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appDir, zip]);
for (const file of [dmg, zip]) console.log(`${file}  ${(fs.statSync(file).size / 1e6).toFixed(0)} MB`);
