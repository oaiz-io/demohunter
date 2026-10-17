// DemoHunter Studio desktop shell (experimental).
// Starts the local Studio service for a repository and shows it in a native
// window. The service, MCP and exports are the same as `bun run studio`.
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, net, protocol, screen, session, shell } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const cli = path.join(root, "apps/studio/cli.ts");
const iconPng = path.join(__dirname, "build/icon.png");
const NAME = "DemoHunter Studio";
// Tests check what would be opened without launching Finder or a browser.
const dryShell = process.env.DEMOHUNTER_DESKTOP_DRY_SHELL === "1";
const openExternal = (url) => !dryShell && shell.openExternal(url);
// Automated tests run the app invisibly: no window on screen, no Dock icon,
// no focus stealing (pages still load and render offscreen).
const hidden = process.env.DEMOHUNTER_DESKTOP_HIDDEN === "1";
if (hidden && process.platform === "darwin") app.dock?.hide();

app.setName(NAME);
// Tests (and side-by-side profiles) use their own settings directory.
if (process.env.DEMOHUNTER_DESKTOP_USER_DATA) app.setPath("userData", process.env.DEMOHUNTER_DESKTOP_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let server, window, workspace, pending, studioOrigin, quitting = false;
/** Only the shell's pages and this Studio service run inside the window
 * (they get the desktop bridge); everything else opens in the browser. */
const isOwnPage = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "app:" || (!!studioOrigin && u.origin === studioOrigin);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- settings

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function settings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    // Older settings stored recent repositories as plain paths.
    s.recent = (s.recent ?? []).map((r) => (typeof r === "string" ? { path: r } : r));
    return s;
  } catch {
    return { recent: [] };
  }
}
function save(patch) {
  const s = { ...settings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
const recent = () => settings().recent.filter((r) => isDirectory(r.path));
function remember(dir) {
  save({ recent: [{ path: dir, openedAt: Date.now() }, ...settings().recent.filter((r) => r.path !== dir)].slice(0, 10) });
  app.addRecentDocument(dir);
}
/** Folders the person chose to trust: their scene pages run scripts and Studio
 * starts inside them (so their Bun config and .env apply). Everything else
 * opens restricted. */
const isTrusted = (dir) => (settings().trusted ?? []).includes(dir);
async function trustFolder() {
  // The folder on screen when asked — not whatever opens while the sheet is up.
  const target = workspace;
  if (!target || isTrusted(target)) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    buttons: ["Trust Folder", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Trust “${path.basename(target)}”?`,
    detail: `${target}\n\nScene pages in this folder's demos are code: trusting it lets their scripts run, and Studio starts inside the folder with its Bun settings and .env file. Only trust folders whose authors you trust.`,
  });
  if (response !== 0) return false;
  save({ trusted: [...new Set([...(settings().trusted ?? []), target])] });
  if (workspace === target) await openRepository(target);
  return true;
}
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- service

/** The Bun that runs Studio: $BUN, else the version pinned by this package
 * (known to work with Playwright), else one on the system. */
function bun() {
  if (process.env.BUN && fs.existsSync(process.env.BUN)) return process.env.BUN;
  // The downloadable app ships its own Bun next to the Studio sources.
  const bundled = path.join(root, "bin", "bun");
  if (fs.existsSync(bundled)) return bundled;
  try {
    const pkg = require.resolve(`@oven/bun-${process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch}/package.json`);
    const pinned = path.join(path.dirname(pkg), "bin/bun");
    if (fs.existsSync(pinned)) return pinned;
  } catch {}
  for (const p of [path.join(process.env.HOME ?? "", ".bun/bin/bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"])
    if (fs.existsSync(p)) return p;
  try {
    return execFileSync("/bin/zsh", ["-lc", "command -v bun"]).toString().trim();
  } catch {
    return "bun";
  }
}
// Apps launched from Finder get a minimal environment; load the login
// shell's so speech API keys, PATH (ffmpeg) etc. match the terminal.
let shellEnv;
function loginEnv() {
  if (shellEnv) return shellEnv;
  shellEnv = { ...process.env };
  if (process.env.DEMOHUNTER_DESKTOP_USER_DATA) return shellEnv;
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-lic", "env -0"], { timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.toString().split("\0")) {
      const i = line.indexOf("=");
      if (i > 0) shellEnv[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {}
  // Homebrew's ffmpeg is found even when the login shell doesn't add it.
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"].filter((d) => !(shellEnv.PATH ?? "").split(":").includes(d));
  shellEnv.PATH = [shellEnv.PATH, ...extra].filter(Boolean).join(":");
  return shellEnv;
}

/** Studio renders thumbnails and exports with Playwright's Chromium. A fresh
 * install (e.g. the downloadable app) fetches it once, with a status page. */
let browserReady;
function playwrightCli() {
  try {
    return path.join(path.dirname(require.resolve("playwright/package.json", { paths: [path.join(root, "apps/studio")] })), "cli.js");
  } catch {
    return undefined;
  }
}
function run(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(bun(), args, { cwd: path.join(root, "apps/studio"), env: { ...loginEnv(), FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out = (out + d).slice(-4000)));
    child.once("error", (e) => resolve({ code: -1, out: String(e.message) }));
    child.once("close", (code) => resolve({ code, out }));
  });
}
/** true/false, or undefined when the check itself could not run. */
function hasBrowser() {
  return run(["-e", "const { chromium } = require('playwright'); process.stdout.write(require('fs').existsSync(chromium.executablePath()) ? 'yes' : 'no')"]).then((r) =>
    r.code !== 0 ? undefined : r.out.trim().endsWith("yes"),
  );
}
function ensureBrowser(dir) {
  return (browserReady ??= (async () => {
    // When even the check fails, Studio's own startup error says more.
    if ((await hasBrowser()) !== false) return;
    const cliPath = playwrightCli();
    if (!cliPath) return;
    if (dir) await showStatus(dir, undefined, false, "Downloading the browser Studio renders with (first run, about 150 MB)…");
    const result = await run([cliPath, "install", "chromium"]);
    if (result.code !== 0) {
      browserReady = undefined;
      throw new Error(`Could not download Chromium for rendering.\n${result.out}`);
    }
  })());
}

function stopStudio() {
  const s = server;
  server = undefined;
  s?.kill();
}

/** Start Studio for a repository; resolves with its URL. */
function startStudio(dir) {
  stopStudio();
  return new Promise((resolve, reject) => {
    const trusted = isTrusted(dir);
    const child = spawn(bun(), [cli, dir, "--port", "0", ...(trusted ? [] : ["--restricted"])], {
      // Untrusted folders never become Bun's working directory, so a
      // repository's bunfig.toml preload or .env can't run or load.
      cwd: trusted ? dir : app.getPath("userData"),
      env: { ...loginEnv(), FORCE_COLOR: "0", DEMOHUNTER_EXIT_WITH_STDIN: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    server = child;
    let output = "",
      url;
    const onData = (data) => {
      output = (output + data.toString()).slice(-20000);
      url ??= /DemoHunter Studio: (http:\/\/[^\s]+)/.exec(output)?.[1];
      if (url) resolve(url);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => reject(new Error(`Could not start Bun (${error.message}).`)));
    child.once("exit", (code, signal) => {
      if (!url) return reject(new Error(output.trim() || `Studio stopped (${signal ?? code}).`));
      // The service stopped on its own while the window was showing it.
      if (server === child && !quitting) {
        server = undefined;
        showStatus(dir, output.trim() || `Studio stopped (${signal ?? code}).`, true);
      }
    });
  });
}

// ---------------------------------------------------------------- windows

function showStatus(dir, error, stopped = false, message) {
  const q = new URLSearchParams({ name: path.basename(dir), path: dir });
  if (message) q.set("message", message);
  // The startup banner is not part of the problem.
  if (error) q.set("error", error.replace(/^(DemoHunter Studio: .*|Workspace: .*|No account or hosted service required\.)\n?/gm, "").trim().slice(-4000));
  if (stopped) q.set("stopped", "1");
  return window.loadURL(`app://ui/status.html?${q}`);
}
function showWelcome() {
  stopStudio();
  workspace = undefined;
  studioOrigin = undefined;
  window.setTitle(NAME);
  window.setRepresentedFilename("");
  buildMenus();
  return window.loadURL("app://ui/welcome.html");
}

async function openRepository(dir) {
  dir = path.resolve(dir);
  // One entry per folder, however it was reached (symlinks, /tmp → /private/tmp).
  try {
    dir = fs.realpathSync(dir);
  } catch {}
  if (!isDirectory(dir)) return dialog.showErrorBox(NAME, `Not a folder: ${dir}`);
  if (!window) return (pending = dir);
  workspace = dir;
  remember(dir);
  window.setTitle(`${path.basename(dir)} — ${NAME}`);
  window.setRepresentedFilename(dir);
  buildMenus();
  await showStatus(dir);
  try {
    await ensureBrowser(dir);
    const url = await startStudio(dir);
    if (workspace === dir) {
      studioOrigin = new URL(url).origin;
      await window.loadURL(url);
    }
  } catch (error) {
    if (workspace === dir) await showStatus(dir, String(error.message ?? error));
  }
}
async function chooseRepository() {
  const result = await dialog.showOpenDialog(window, {
    title: "Open a repository or folder",
    message: "A repository shows the demos in all of its worktrees.",
    buttonLabel: "Open",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: workspace,
  });
  if (!result.canceled && result.filePaths[0]) await openRepository(result.filePaths[0]);
}

function windowBounds() {
  const saved = settings().window ?? {};
  const size = Number.isFinite(saved.width) && Number.isFinite(saved.height) ? { width: Math.max(960, saved.width), height: Math.max(600, saved.height) } : { width: 1440, height: 900 };
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return size;
  // Only restore a position that is still on a connected display.
  const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, ...size }).workArea;
  const visible = saved.x >= area.x - 40 && saved.y >= area.y - 40 && saved.x + 200 <= area.x + area.width && saved.y + 100 <= area.y + area.height;
  return visible ? { x: saved.x, y: saved.y, ...size } : size;
}
function createWindow() {
  const bounds = windowBounds();
  window = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    title: NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#f3f3f1",
    icon: iconPng,
    show: false,
    // Offscreen test windows still paint, so screenshots work.
    paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  if (settings().window?.maximized) window.maximize();
  if (!hidden) window.once("ready-to-show", () => window.show());
  // Match the window background to the page, so resizing never flashes a
  // different colour at the edges.
  window.webContents.on("did-finish-load", () =>
    window.webContents
      .executeJavaScript(
        "[document.body, document.documentElement].map((e) => getComputedStyle(e).backgroundColor).find((c) => !/^rgba\\(.*, 0\\)$|transparent/.test(c)) ?? 'rgb(255, 255, 255)'",
      )
      .then((colour) => /^rgba?\(/.test(colour) && !/, 0\)$/.test(colour) && window.setBackgroundColor(colour))
      .catch(() => {}),
  );
  // Keep the repository in the native title (Window menu, Mission Control).
  window.on("page-title-updated", (event) => event.preventDefault());
  let timer;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.isDestroyed() || window.isFullScreen()) return;
      save({ window: { ...window.getNormalBounds(), maximized: window.isMaximized() } });
    }, 300);
  };
  for (const e of ["resize", "move", "maximize", "unmaximize"]) window.on(e, persist);
  window.on("close", () => {
    clearTimeout(timer);
    if (!window.isFullScreen()) save({ window: { ...window.getNormalBounds(), maximized: window.isMaximized() } });
  });
  window.on("closed", () => {
    window = undefined;
    stopStudio();
  });
  // Links that leave Studio open in the default browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url) && !isOwnPage(url)) openExternal(url);
    return { action: "deny" };
  });
  // Top-level navigation stays on the shell and Studio; links the person
  // followed in Studio's own page open in the browser, and top-level
  // navigations started by embedded frames (scene pages) are blocked. Frames'
  // own navigation is limited by the editor's CSP (frame-src 'self').
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || isOwnPage(event.url)) return;
    event.preventDefault();
    if (event.initiator === window.webContents.mainFrame && /^https?:/.test(event.url)) openExternal(event.url);
  });
}

// ---------------------------------------------------------------- menus

function buildMenus() {
  const repos = recent();
  const recentItems = repos.length
    ? [
        ...repos.map((r) => ({ label: r.path.replace(process.env.HOME ?? "\0", "~"), click: () => openRepository(r.path) })),
        { type: "separator" },
        { label: "Clear Menu", click: () => (save({ recent: [] }), app.clearRecentDocuments(), buildMenus()) },
      ]
    : [{ label: "No Recent Repositories", enabled: false }];
  const studio = (js) => () => window?.webContents.getURL().startsWith("http") && window.webContents.executeJavaScript(js);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          { label: "Open Repository or Folder…", accelerator: "CmdOrCtrl+O", click: chooseRepository },
          { label: "Open Recent", submenu: recentItems },
          { type: "separator" },
          { label: "Show in Finder", enabled: !!workspace, click: () => workspace && shell.openPath(workspace) },
          { label: "Trust This Folder…", enabled: !!workspace && !isTrusted(workspace), click: trustFolder },
          { label: "Close Repository", enabled: !!workspace, accelerator: "CmdOrCtrl+Shift+W", click: showWelcome },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Demos", enabled: !!workspace, accelerator: "CmdOrCtrl+Shift+D", click: studio("location.href = '/'") },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [{ label: "DemoHunter on GitHub", click: () => shell.openExternal("https://github.com/oaiz-io/demohunter") }],
      },
    ]),
  );
  if (process.platform === "darwin")
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        ...repos.slice(0, 5).map((r) => ({ label: path.basename(r.path), click: () => openRepository(r.path) })),
        ...(repos.length ? [{ type: "separator" }] : []),
        { label: "Open Repository or Folder…", click: chooseRepository },
      ]),
    );
}

// ---------------------------------------------------------------- app

/** A folder passed on the command line (`electron . <dir>` or a second launch). */
function folderArg(argv) {
  return argv.slice(1).find((a) => !a.startsWith("-") && path.resolve(a) !== __dirname && isDirectory(a));
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_event, argv, cwd) => {
  const dir = argv.slice(1).find((a) => !a.startsWith("-") && path.resolve(cwd, a) !== __dirname && isDirectory(path.resolve(cwd, a)));
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
  if (dir) openRepository(path.resolve(cwd, dir));
});
// Folders dropped on the dock icon, or opened with `open -a`.
app.on("open-file", (event, file) => {
  event.preventDefault();
  if (isDirectory(file)) openRepository(file);
});

app.whenReady().then(async () => {
  // Bundled shell pages, the icon and the Studio interface fonts only.
  const fonts = { "geist.woff2": "geist", "geist-mono.woff2": "geist-mono" };
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const rel = path.posix.normalize(decodeURIComponent(`${url.host}${url.pathname}`)).replace(/\/+$/, "");
    let file;
    if (rel === "ui/icon.png") file = iconPng;
    else if (/^ui\/[\w.-]+$/.test(rel)) file = path.join(__dirname, rel);
    else if (rel.startsWith("ui/fonts/") && fonts[rel.slice("ui/fonts/".length)]) {
      const pkg = fonts[rel.slice("ui/fonts/".length)];
      const dir = path.dirname(require.resolve(`@fontsource-variable/${pkg}/package.json`, { paths: [path.join(root, "apps/studio")] }));
      file = path.join(dir, "files", `${pkg}-latin-wght-normal.woff2`);
    }
    if (!file || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return new Response(response.body, { status: response.status, headers });
  });
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(iconPng));
  app.setAboutPanelOptions({
    applicationName: NAME,
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: "© OAIZ AB · OAIZ Labs open source",
    website: "https://github.com/oaiz-io/demohunter",
    iconPath: iconPng,
  });

  // The bridge answers only the shell's pages and Studio's top frame — never
  // scene pages or other frames inside them.
  const own = (event) => !!event.senderFrame && event.senderFrame === window?.webContents.mainFrame && isOwnPage(event.senderFrame.url);
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!own(event)) throw new Error("Not allowed.");
      return fn(...args);
    });
  handle("info", () => {
    const seen = new Set();
    const list = [];
    for (const r of recent()) {
      let real = r.path;
      try {
        real = fs.realpathSync(r.path);
      } catch {}
      if (seen.has(real)) continue;
      seen.add(real);
      list.push({ ...r, path: real, name: path.basename(real) });
    }
    return { version: app.getVersion(), home: app.getPath("home"), recent: list };
  });
  handle("open", (dir) => typeof dir === "string" && openRepository(dir));
  handle("choose", chooseRepository);
  handle("trust", trustFolder);
  // Only export results (video, captions, manifest) inside the open folder
  // or one of its worktrees — never arbitrary files that could be launched.
  const exportFile = /\/exports\/[^/]+\/(video\.mp4|captions\.vtt|captions\.json|manifest\.json)$/;
  const inWorkspace = (file) => {
    if (typeof file !== "string" || !workspace) return;
    let real;
    try {
      real = fs.realpathSync(path.resolve(workspace, file));
    } catch {
      return;
    }
    if (!exportFile.test(real)) return;
    const roots = [workspace];
    try {
      const out = execFileSync("git", ["-C", workspace, "worktree", "list", "--porcelain"], { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString();
      for (const line of out.split("\n")) if (line.startsWith("worktree ")) roots.push(line.slice(9));
    } catch {}
    const inside = roots.some((root) => {
      try {
        const r = fs.realpathSync(root);
        return real.startsWith(r + path.sep);
      } catch {
        return false;
      }
    });
    return inside ? real : undefined;
  };
  handle("open-file", async (file) => {
    const f = inWorkspace(file);
    if (f && !dryShell) await shell.openPath(f);
    return !!f;
  });
  handle("show-file", (file) => {
    const f = inWorkspace(file);
    if (f && !dryShell) shell.showItemInFolder(f);
    return !!f;
  });
  handle("open-repository", chooseRepository);
  // No camera, microphone, notifications, etc.; clipboard writes (copy
  // buttons) and fullscreen only for Studio's own top frame.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(["clipboard-sanitized-write", "fullscreen"].includes(permission) && details.isMainFrame !== false && isOwnPage(details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => ["clipboard-sanitized-write", "fullscreen"].includes(permission) && isOwnPage(origin));

  createWindow();
  buildMenus();
  const start = pending ?? folderArg(process.argv) ?? recent()[0]?.path;
  if (start) await openRepository(start);
  else await showWelcome();
}).catch((error) => {
  dialog.showErrorBox(NAME, String(error?.stack ?? error));
  app.quit();
});
app.on("activate", () => {
  if (window) return;
  createWindow();
  showWelcome();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  stopStudio();
});
