# DemoHunter Studio

An open-source, local-first application for captured browser demos. Explore recordings on your filesystem, preview and edit without rendering video, work with your preferred agent, and export the saved result for CI or sharing. No account, hosted backend or built-in language model.

## Start

From this source workspace, with Bun 1.3 or newer (Bun 1.2 cannot launch Playwright's browsers), Playwright Chromium and FFmpeg installed:

```sh
bun install
bun run studio
```

The library scans the current repository for saved captures and .tour.ts source files and links each recording to its tour. It shows the repository name, branch and one card per recording with a first-frame thumbnail, duration, path, last edit and one status: open notes, or a tour changed after capture. Search by title or path, open a recording and return to the library. Test and fixture captures are left out. When the folder you open is a git repository's top level (the main checkout or any linked worktree), Studio also lists every worktree of that repository from `git worktree list`: the Projects sidebar nests that project's worktrees (those with demos; the rest fold away) with branch, uncommitted changes and ahead/behind, badges worktrees with new or updated demos, and cards show which worktree a demo lives in. "New" means not opened yet; "Updated" means re-captured or changed by an agent since you last opened it (your own edits don't count). In the desktop app the sidebar also lists recent projects and has an Open… button. Studio never searches for repositories on its own; subfolders and plain folders are scanned as before. Viewing a demo records it for agents connected in the opened folder and in the demo's own worktree, and Connect agent points at the demo's worktree. Studio does not record: make and re-record demos with the CLI below; new captures appear automatically. Choose another workspace with `bun run studio /path/to/repo`. There is one way to open Studio; open a demo from the library. The service defaults to localhost:4310; --host and --port support private development previews.

```sh
bun run studio demo
bun run studio capture demos/example.tour.ts --project .demohunter/replays/my-demo
bun run studio list
```

`demo` creates a realistic four-scene invoice workflow with local sample speech when FFmpeg flite is available; --sample fractions creates a math lesson. Captures stop the built-in source app before playback. Capture uses DemoHunter's current two-pass tour runtime and rrweb; it does not record pixels or invoke a speech provider. The capture destination must be new.

## Work with your agent

Select an element, then press **Edit** in its toolbar. You can also open the **Edit** panel and click an element. Drag to move it. Drag a corner to resize it; hold Shift to keep its proportions. Change text, text color, background color, font size, opacity, position, scale, width or height in the panel. Arrow keys move the selected element by one pixel (Shift: ten). **Hide** keeps its space; **Remove** closes the space. Find hidden elements in the element list, then choose **Restore** or **Reset edits**.

To rewrite text, double-click it on the canvas. An editor opens over the text in the same font, size and wrapping, with the text selected; playback pauses. The preview updates as you type. **Enter** saves, **Shift+Enter** adds a line break, **Esc** cancels and clicking outside saves. **Tab** saves and moves to the next text on the frame in reading order (**Shift+Tab**: previous). Studio edits the innermost element that holds the clicked text, so double-clicking a bold word changes only that word. Unchanged words keep their formatting and links. Double-click a recorded input to change the value it shows; the recorded typing no longer replaces it. A text edit applies to that element for the whole video. A warning appears when the new text no longer fits the original box. While you hover the canvas in the Edit panel, dashed outlines mark rewritten text.

The same controls work on recorded page elements, HTML scenes and overlays. Changes appear at once and save to `edits.json`. They apply wherever the element appears. The source recording and HTML stay intact. Undo restores saved changes. If an agent changes the project during an edit, Studio keeps your draft and asks you to apply it to the latest version or use the saved version. Export waits for pending element edits to save.

Press `C` and click an element to add a **note** with its element and time. The selection toolbar has **Edit**, **Note** and **Copy for agent**. `V` returns to selection; double-click text to rewrite it in place. The editor has Edit, Notes, Script and Agent panels. Your agent can use the same saved overrides through MCP or project files.

**Connect agent** shows the exact `claude mcp add …` and `codex mcp add …` commands (or JSON for other clients) for one server per repository. It edits the demo you have open in Studio (or one the agent names with `project`), plus the prompt to start with. No agent settings are changed automatically.

Each note shows its stable comment ID. Click the ID to copy it, use **Copy link** to copy a link to that exact note, or use **Copy for agent** to copy the note, replies, ID, link and element context. Double-click the note text to copy the same agent context. These actions stay available after replies and resolution. Canvas, timeline and note-card pins open the matching note. Your agent can pass a copied link or comment ID to MCP `resolve_reference`.

While an agent works, Studio shows it from real activity records only: the title bar pill, a target outline on the canvas (a light scan while it reads, a marching outline while it edits, a short settle when it is done, red when a call fails), stripes on the scene it changes and a checklist of tool calls in the related note. Your playhead and selection never move unless you press **Show on canvas**. Notes show their state: open, agent working, agent replied, resolved.

The **Agent** panel groups tracked agent changes into turns (one MCP session without a long pause) with a readable change list. **Undo turn** undoes the newest turn in one locked step and refuses to overwrite later direct-file edits.

```sh
bun run studio mcp            # the workspace; follows the demo open in Studio
bun run studio kit .demohunter/replays/my-demo --mood calm
bun run studio resolve .demohunter/replays/my-demo '<copied-element-link>'
bun run studio contract
```

An MCP agent can inspect selection/HTML/styles, edit elements, clips/camera/highlights/animations, add HTML intro/outro scenes and overlays, music and sound effects, handle comments, edit/regenerate narration, render screenshots and undo. Direct file changes refresh too, but cannot be attributed to an agent automatically.

## Scenes, music and sound

Intros, outros and chapter cards are HTML pages in the demo's `scenes/` folder, placed in the timeline like clips; overlays sit on top of the recording. Studio drives every animation from the timeline, so preview and export are frame-exact. `lift` copies a real element of the recording (a card, a button) into `scenes/lifts/` (a revision-checked scene-file write, like `write_project_file`; MCP `lift_element` takes `expectedRevision`) so an overlay can pick it up from the page, bring it to the camera and animate it while the page blurs behind it. `kit` adds the scene helper (`scenes/kit/motion.js`) and a generated, license-free score with sound effects in the same key; the timeline's Sound track shows the music bed and every effect, including sounds a scene declares. Export mixes narration, music (ducked under the voice) and effects and normalises loudness to −16 LUFS. It renders in parallel (one browser per four cores, up to four; `--workers` to change) and joins the segments without re-encoding: a 67 s 1080p film exports in under 30 seconds.

The [agent skill](../../.agents/skills/demohunter-replay/SKILL.md) and each new project's AGENTS.md explain file editing. The browser holds the last valid preview through partial writes. UI/MCP edits check revisions. Narration cards autosave and preserve same-field conflicts for an explicit choice.

## Narration and export

Edit transcript cards, see real waveforms, and regenerate a segment or all speech. Voice settings and timing live in project.json and narration.json (or go through your agent). Old speech is marked stale and suppressed. Provider settings live in project.json; API keys come from OPENAI_API_KEY/ELEVENLABS_API_KEY in the service environment only. Synthesis reuses DemoHunter's validated cache (`<workspace>/.demohunter/cache` by default, or `--cache-dir`); complete cache hits work offline. Sample flite audio is clearly labeled.

Playback waits for active speech to load before advancing the timeline. Small audio timing differences use a gradual speed correction; timeline seeks reposition speech once. Removed or stale speech stops immediately. If the browser blocks audio, click Play again to retry.

```sh
bun run studio narrate .demohunter/replays/my-demo --fit
bun run studio export .demohunter/replays/my-demo \
  --output .demohunter/exports/my-demo --fps 24 --strict-audio
```

Or choose **Export video** in the editor (24 fps; missing speech is left silent). Both routes render the saved replay through the same player and produce video.mp4, captions.vtt, captions.json and a checksummed manifest.json. The source app is not revisited. Current speech is mixed; stale/draft speech is omitted unless --strict-audio makes that an error. Captions still carry the current script. Export refuses existing destinations and cancels if project content changes mid-render. Preview and agent inspection can continue. Exporting frames takes time; ordinary editing/preview does not encode video.

[CI example](ci-example.yml) documents capture → optional narration → export. CI can export a committed portable capture without running its original app. Upload/publish artifacts using your own pipeline; Studio never publishes automatically.

## Contract and boundaries

[Format/protocol v1](FORMAT.md) fixes filenames, identity, time semantics, revision rules and compatibility; [JSON Schemas](schemas/) support tools. [Architecture](ARCHITECTURE.md) describes the browser/service/storage boundaries and the desktop/hosting path.

This is an application workspace under apps/studio. The macOS desktop app (apps/desktop, alpha) wraps the same service in an Electron window; an unsigned build for Apple silicon is published as the rolling `studio-desktop-alpha` GitHub pre-release. The local service has no account/auth layer; use localhost or a trusted private network. Hosting with multiple users requires authorization and tenant scoping. Studio answers only loopback host names (DNS-rebinding guard) unless started with an explicit `--host`. Scene pages are project code and run their scripts; `--restricted` (used by the desktop app for folders you haven't trusted) renders them without scripts. Captured assets are served as inert data and the replay player ships with Studio, never from a project folder.

Replay captures visible DOM rather than the JavaScript heap/backend. Original app scripts do not execute. Text edits do not recompute calculations. Captured HTML does not identify original React/HTML source unless the app supplied provenance. Refs survive edits, not recapture. HTML/SVG work best; canvas/WebGL, cross-origin frames and native media have fidelity limits. Captured assets have a 10 MB resource limit. Keep demo data appropriate for sharing.

Clips use source milliseconds; effects use output milliseconds. Speech follows clip IDs. Fitting speech extends holds and does not move absolute effects. Source dimensions stay fixed; camera zoom does not reflow. Space plays, arrows seek, Escape exits selection, Focus enlarges preview.

## Check

```sh
bun run test:studio
bun run typecheck:studio
bun run test:desktop      # macOS (or Linux with a display): Electron end-to-end tests
bun run build
```

The application uses skipLibCheck for rrweb ambient declarations; application code stays strictly checked. Restart the service after changing application source; recording files refresh automatically.
