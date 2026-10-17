# DemoHunter Studio desktop (experimental)

A native macOS window around the same local Studio service as `bun run studio`.
It needs Bun and this checkout; nothing is uploaded and no cloud service is used.

```sh
bun run desktop        # run from source
bun run desktop:app    # build out/DemoHunter Studio.app (named, with icon) and open it
bun run test:desktop   # Electron end-to-end tests (Playwright)
```

- Opens the last repository, or a welcome window with recent repositories.
- A repository shows the demos of all its worktrees (sidebar per worktree with branch and changes); any other folder is scanned for demos beneath it.
- ⌘O opens a repository; drop a folder on the window or the Dock icon; File → Close Repository returns to the welcome window.
- Remembers the window size and position, runs as a single instance, and shows startup errors with **Try again**.
- Loads your login shell's environment, so `OPENAI_API_KEY`/`ELEVENLABS_API_KEY` and `ffmpeg` work as in the terminal.

The `.app` links to this checkout (Studio runs from source), so rebuild it only after upgrading Electron or changing the icon. Regenerate the icon with `node scripts/render-icon.mjs build/icon.svg build/icon`.
