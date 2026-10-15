# DemoHunter Studio

An open-source, local-first application for captured browser demos. Explore recordings on your filesystem, preview and edit without rendering video, work with your preferred agent, and export the saved result for CI or sharing. No account, hosted backend or built-in language model.

## Start

From this source workspace, with Bun, Playwright Chromium and FFmpeg installed:

```sh
bun install
bun run studio
```

The library scans the current repository for saved captures and .tour.ts source files, links each recording to its tour, and shows the branch, open notes, agent changes, audio to update and tours changed after recording. Tours that are not recorded yet have **Record**, which runs the normal capture command (the app at the tour's baseURL must be running). The sidebar groups demos by repository folder and checks Chromium, FFmpeg, speech keys and the optional flite voice. Search, filter open comments/stale audio, preview actual first-frame thumbnails, open a recording and return to the library. New captures appear automatically. Choose another workspace with `bun run studio library /path/to/repo`. The service defaults to localhost:4310; --host and --port support private development previews.

```sh
bun run studio demo
bun run studio capture demos/example.tour.ts --project .demohunter/replays/my-demo
bun run studio open .demohunter/replays/my-demo
bun run studio list
```

`demo` creates a realistic four-scene invoice workflow with local sample speech when FFmpeg flite is available; --sample fractions creates a math lesson. Captures stop the built-in source app before playback. Capture uses DemoHunter's current two-pass tour runtime and rrweb; it does not record pixels or invoke a speech provider. The capture destination must be new. Existing `bun run replay` commands and experiments/replay/cli.ts remain aliases.

## Work with your agent

Studio is where you see and point; your agent (Claude Code, Codex or another MCP client) does the editing. Press `C` and click anything to add a **note**: it keeps the element and the moment. Click an element to get the selection toolbar: **Note**, **Copy for agent**, **Edit** (text, hide, zoom, highlight, fade-in) and **Inspect**, which opens the Element panel with a ready hand-off. `V` returns to selection, `⌘F` finds and replaces text, `⌘⇧C` copies the selection for your agent, Escape clears it.

**Connect agent** shows the exact `claude mcp add …` and `codex mcp add …` commands (or JSON for other clients) for a server bound to this one recording, plus the prompt to start with. No agent settings are changed automatically.

While an agent works, Studio shows it from real activity records only: the title bar pill, a target outline on the canvas (a light scan while it reads, a marching outline while it edits, a short settle when it is done, red when a call fails), stripes on the scene it changes and a checklist of tool calls in the related note. Your playhead and selection never move unless you turn on **Follow agent** or press **Show on canvas**. Notes show their state: open, agent working, agent replied, resolved.

The **Agent** panel groups tracked agent changes into turns (one MCP session without a long pause) with a readable change list. **Keep** marks a turn as reviewed in this browser only; **Undo turn** undoes the newest turn in one locked step and refuses to overwrite later direct-file edits. The header shows the git branch and how many project files changed.

```sh
bun run studio mcp .demohunter/replays/my-demo
bun run studio resolve .demohunter/replays/my-demo '<copied-element-link>'
bun run studio contract
```

An MCP agent can inspect selection/HTML/styles, edit elements, clips/camera/highlights/animations, handle comments, edit/regenerate narration, render screenshots and undo. Direct file changes refresh too, but cannot be attributed to an agent automatically.

The [agent skill](../../.agents/skills/demohunter-replay/SKILL.md) and each new project's AGENTS.md explain file editing. The browser holds the last valid preview through partial writes. UI/MCP edits check revisions. Narration cards autosave and preserve same-field conflicts for an explicit choice.

## Narration and export

Edit transcript cards, preview scenes, inspect real waveforms, change timing/voice, and regenerate a segment or all speech. Old speech is marked stale and suppressed. Provider settings live in project.json; API keys come from OPENAI_API_KEY/ELEVENLABS_API_KEY in the service environment only. Synthesis reuses DemoHunter's validated cache; complete cache hits work offline. Sample flite audio is clearly labeled.

```sh
bun run studio narrate .demohunter/replays/my-demo --fit
bun run studio export .demohunter/replays/my-demo \
  --output .demohunter/exports/my-demo --fps 24 --strict-audio
```

Or choose **Export video** in the editor. Both routes render the saved replay through the same player and produce video.mp4, captions.vtt, captions.json and a checksummed manifest.json. The source app is not revisited. Current speech is mixed; stale/draft speech is omitted unless --strict-audio makes that an error. Captions still carry the current script. Export refuses existing destinations and cancels if project content changes mid-render. Preview and agent inspection can continue. Exporting frames takes time; ordinary editing/preview does not encode video.

[CI example](ci-example.yml) documents capture → optional narration → export. CI can export a committed portable capture without running its original app. Upload/publish artifacts using your own pipeline; Studio never publishes automatically.

## Contract and boundaries

[Format/protocol v1](FORMAT.md) fixes filenames, identity, time semantics, revision rules and compatibility; [JSON Schemas](schemas/) support tools. [Architecture](ARCHITECTURE.md) describes the browser/service/storage boundaries and future Tauri/hosting path.

This is now an application workspace under apps/studio, still source-distributed rather than a published desktop package. The local service has no account/auth layer; use localhost or a trusted private network. Hosting with multiple users requires authorization and tenant scoping. Tauri packaging remains future work.

Replay captures visible DOM rather than the JavaScript heap/backend. Original app scripts do not execute. Text edits do not recompute calculations. Captured HTML does not identify original React/HTML source unless the app supplied provenance. Refs survive edits, not recapture. HTML/SVG work best; canvas/WebGL, cross-origin frames and native media have fidelity limits. Captured assets have a 10 MB resource limit. Keep demo data appropriate for sharing.

Clips use source milliseconds; effects use output milliseconds. Speech follows clip IDs. Fitting speech extends holds and does not move absolute effects. Source dimensions stay fixed; camera zoom does not reflow. Space plays, arrows seek, Escape exits selection, Focus enlarges preview.

## Check

```sh
bun run test:studio
bun run typecheck:studio
bun run build
```

The application uses skipLibCheck for rrweb ambient declarations; application code stays strictly checked. Restart the service after changing application source; recording files refresh automatically.
