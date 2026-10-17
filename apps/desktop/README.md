# DemoHunter Studio desktop (alpha)

A native macOS window around the same local Studio service as `bun run studio`. Nothing is uploaded and no cloud service is used.

## Download

Unsigned Apple-silicon builds are published as the rolling [`studio-desktop-alpha`](https://github.com/oaiz-io/demohunter/releases/tag/studio-desktop-alpha) pre-release (built by `.github/workflows/desktop-alpha.yml`).

1. Open the `.dmg` and drag **DemoHunter Studio** to Applications.
2. It is signed ad hoc, not notarized: the first time, right-click the app → **Open** → **Open** (or System Settings → Privacy & Security → **Open Anyway**).
3. First launch downloads Chromium for rendering (about 270 MB, once). Export needs ffmpeg (`brew install ffmpeg`). Narration reads `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` from your login shell.

## From source

```sh
bun run desktop          # run from this checkout
bun run desktop:app      # out/DemoHunter Studio.app linked to this checkout
bun run desktop:package  # standalone .app + .dmg + .zip in out/ (macOS)
bun run test:desktop     # Electron end-to-end tests (Playwright)
```

## Behaviour

- Opens the last project, or a welcome window with recent projects. ⌘O opens a repository or folder; drop a folder on the window or the Dock icon.
- A repository shows the demos of all its worktrees; any other folder is scanned for demos beneath it.
- Remembers the window, runs as a single instance, and shows startup errors with **Try again**.
- **Folder trust.** Scene pages are code. A folder you haven't trusted opens restricted: scene scripts don't run (static scenes still render) and Studio does not start inside the folder, so its `bunfig.toml` and `.env` are ignored. **File → Trust This Folder…** (or the editor notice) enables them for that folder.
- The bridge to the window (choose/open a folder, open or reveal export files inside the project) answers only Studio's own top frame; other permissions are denied and links open in your browser.

## Known limits (alpha)

Apple silicon only; no auto-update, notarization or Electron fuse hardening yet. Trusted folders' scene pages share Studio's origin, so trust only repositories whose authors you trust. Regenerate the icon with `node scripts/render-icon.mjs build/icon.svg build/icon`.
