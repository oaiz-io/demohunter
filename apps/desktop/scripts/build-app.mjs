// Builds "out/DemoHunter Studio.app": the Electron runtime renamed, with
// the DemoHunter icon, running this checkout's desktop shell. The bundle
// links to the checkout (Studio runs from source with Bun), so rebuild only
// after upgrading Electron or changing the icon.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const electronDist = path.join(path.dirname(fileURLToPath(import.meta.resolve("electron/package.json"))), "dist");
const name = "DemoHunter Studio";
const out = path.join(desktop, "out", `${name}.app`);
if (process.platform !== "darwin") throw new Error("The .app bundle is macOS only; use `bun run desktop` elsewhere.");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
// ditto keeps the framework symlinks and permissions intact.
execFileSync("ditto", [path.join(electronDist, "Electron.app"), out]);
const contents = path.join(out, "Contents");
const plist = path.join(contents, "Info.plist");
const set = (key, value) => execFileSync("plutil", ["-replace", key, "-string", value, plist]);
const version = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).version;
set("CFBundleName", name);
set("CFBundleDisplayName", name);
set("CFBundleIdentifier", "io.oaiz.demohunter.studio");
set("CFBundleShortVersionString", version);
set("CFBundleIconFile", "icon.icns");
set("NSHumanReadableCopyright", "© OAIZ AB");
// Folders can be dropped on the Dock icon.
execFileSync("plutil", ["-replace", "CFBundleDocumentTypes", "-json", JSON.stringify([{ CFBundleTypeName: "Folder", CFBundleTypeRole: "Viewer", LSItemContentTypes: ["public.folder"], LSHandlerRank: "Alternate" }]), plist]);
fs.copyFileSync(path.join(desktop, "build/icon.icns"), path.join(contents, "Resources/icon.icns"));
fs.rmSync(path.join(contents, "Resources/electron.icns"), { force: true });
fs.rmSync(path.join(contents, "Resources/default_app.asar"), { force: true });
// The app folder is a symlink to this checkout's shell.
fs.symlinkSync(desktop, path.join(contents, "Resources/app"));
// Changing Info.plist invalidates the signature; re-sign ad hoc.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", out]);
execFileSync("touch", [out]);
console.log(out);
