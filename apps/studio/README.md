# DemoHunter Studio

An open-source, local-first application for captured browser demos. Explore recordings on your filesystem, preview and edit without rendering video, work with your preferred agent, and export the saved result for CI or sharing. No account, hosted backend or built-in language model.

## Start

From this source workspace, with Bun, Playwright Chromium and FFmpeg installed:

```sh
bun install
bun run studio
```

The library scans the current workspace for saved captures and .tour.ts source files. Search, filter open comments/stale audio, preview actual first-frame thumbnails, open a recording and return to the library. New captures appear automatically. Choose another workspace with `bun run studio library /path/to/repo`. The service defaults to localhost:4310; --host and --port support private development previews.

```sh
bun run studio demo
bun run studio capture demos/example.tour.ts --project .demohunter/replays/my-demo
bun run studio open .demohunter/replays/my-demo
bun run studio list
```

`demo` creates a realistic four-scene invoice workflow with local sample speech when FFmpeg flite is available; --sample fractions creates a math lesson. Captures stop the built-in source app before playback. Capture uses DemoHunter's current two-pass tour runtime and rrweb; it does not record pixels or invoke a speech provider. The capture destination must be new. Existing `bun run replay` commands and experiments/replay/cli.ts remain aliases.

## Work with your agent

The preview is the main workspace. Click a paused frame to select an element, or use **Comment** (`C`) to point and leave feedback. Comments open first; **Script** (`S`) opens the narration. Each comment has **Copy for agent** with the element reference, timestamp and relevant files. Paste it into your preferred agent and review its changes live. `V` returns to selection and Escape clears it.

**Scenes** opens navigation and element search on demand. The selected element's manual edits and source details stay collapsed until needed. **More options** holds precise timing, the detailed timeline, undo and keyboard help. Focus expands the canvas; choosing a commenting or script action brings the sidebar back.

Select an element or use the searchable element list. Copy its stable link or full context, attach a comment, then paste it into your agent. **Connect your agent** shows the exact executable and arguments for a project-bound stdio MCP server. No agent settings are changed automatically.

```sh
bun run studio mcp .demohunter/replays/my-demo
bun run studio resolve .demohunter/replays/my-demo '<copied-element-link>'
bun run studio contract
```

An MCP agent can inspect selection/HTML/styles, edit elements, clips/camera/highlights/animations, handle comments, edit/regenerate narration, render screenshots and undo. The editor shows who is inspecting/editing and highlights the target subtly; Show element is explicit so activity cannot hijack your playhead. Agent activity lists recent actual tool operations. Direct file changes refresh too, but cannot be attributed to an agent automatically.

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
