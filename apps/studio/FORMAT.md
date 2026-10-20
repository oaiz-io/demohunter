# Studio format and editing protocol

This directory defines the local, portable source of truth. No database, account, hosted API or agent vendor is needed. The committed [JSON Schemas](schemas/) describe the individual files. `loadBundle` additionally validates cross-file constraints, source bounds, target exclusivity and unique IDs. Agent clients can call `get_contract` and `get_schema`.

## Identity and compatibility

`studio.json` identifies `format: "demohunter.studio"`, `formatVersion: 2`, `protocolVersion: 1`, a UUID `projectId`, and a `captureId` derived from the SHA-256 of immutable events.json bytes. project.json retains its own `schemaVersion: 1`. The manifest fixes the canonical filenames; arbitrary file indirection is not accepted. Optional source tour/config paths are provenance relative to the capture's consumer repository, not executable commands. An optional `source.tourSha256` records the tour file's SHA-256 at capture so a library can show that the tour changed after recording; readers that do not know it may ignore it.


v2 stores immutable files in `capture.dhcapture`, a ZIP archive. The manifest's
`capture: {file: "capture.dhcapture", sha256: "<64 hex characters>"}` fixes its
identity. Inside are `capture.json` (`format: "demohunter.capture"`,
`formatVersion: 1`, full `captureHash`), original `events.json` bytes, the matching
`elements.json`, and `assets/`. Entry order and timestamps are fixed when packed.
Readers check the archive hash, recording hash and element identity. Archives
are read in memory; entries are not extracted. Paths and duplicate entries are
checked before decompression. Compressed and expanded size is limited to 256 MiB,
with at most 10,000 files. Missing LFS objects produce a `git lfs pull` error.

v1 loose projects remain readable. `bun run studio pack <project>` explicitly
migrates them, without recording again. It preserves event bytes, element refs,
project identity, source provenance, edits, comments, audio, scenes and content
revision. It writes and validates the bundle, commits the v2 manifest, then
removes loose capture files and derived `sources/`. Older Studio readers reject
v2 instead of treating it as a damaged v1 project. New captures use v2.

A project without studio.json is a supported legacy capture. First open adds the manifest without changing its content revision or rewriting captured events. Manifest creation is atomic across cooperating processes. Unknown major versions and malformed files fail before content mutation. There is no automatic lossy downgrade. Compatible readers must preserve v1 field meanings; new semantics requiring new reader behavior require explicit version/capability negotiation. Recapturing creates a new capture/project, never overwrites edited data.

DOM events currently use pinned rrweb 2.1.7. A different incompatible event encoding requires a format revision or explicit migration. This is a documented v1 contract for Studio, separate from DemoHunter's existing video-output manifest format.

## Canonical and derived files

| Files                   | Contract                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| studio.json             | Identity, format/protocol versions, filenames, optional source provenance                            |
| project.json            | Title, source viewport/duration, TTS configuration, capture warnings                                 |
| capture.dhcapture       | Immutable recording, assets and frozen element index; ZIP with manifest checksum                      |
| sources/ (v1 only)      | Derived inspection HTML; v2 generates requested HTML through MCP without writing files                |
| edits.json              | Clips (recording or HTML scene), element overrides, camera, highlights, animations, overlays, audio  |
| scenes/                 | Scene and overlay pages (HTML/CSS/JS/fonts/images); part of the content revision                     |
| narration.json, audio/  | Script/voice overrides and portable generated audio with request identity                            |
| comments.json           | Element/time-anchored threads, replies and resolution state; missing legacy file means empty threads |
| overrides.css           | Persistent page styles                                                                               |

Copied references use `demohunter://capture/<captureId>/element/<ref>?t=<output-ms>`. HTTP links also include the capture/ref/time so links resolve independently of a machine's absolute folder location. The registry maps refs to document/node IDs, hierarchy and annotated HTML. Refs survive edits, not recapture. Original application source is known only when the app supplied `data-demohunter-source` / `data-demohunter-line`. Editing inspection snippets does not change playback.

Comment references use `demohunter://capture/<captureId>/comment/<threadId>?t=<output-ms>`. HTTP note links add `comment=<threadId>` to the fragment and open that exact thread, including resolved notes. `resolve_reference` also accepts a bare `comment-…` ID within its bound project. It returns the current thread, replies, status and output time, plus captured HTML when the note has an element. Comment identity takes priority over an optional element in the same link.

Runtime files are not canonical: selection.json, preview-state.json, preview-command.json, lock files, .history/, .studio/ (activity), and exports/. Studio's per-worktree state in `.demohunter/studio/` (seen.json for new/updated badges, agents.json for in-app agent preferences) is git-ignored runtime state too. Runtime/derived writes do not alter content revision. They may be discarded when moving a project. Keep audio/ and bundled assets for portable playback.

## Time and mutations

All persisted times are milliseconds. A scene clip (`kind: "scene"`, `src`, `durationMs`) plays its page while the recording holds the frame where it stands (or where the next clip starts). Overlay and audio times are output time; an overlay's optional `backdrop` (`blur` px, `dim` 0–1, `easeMs`) softens the recording underneath while it is up; `scenes/lifts/` holds elements lifted from the recording (HTML with inline computed styles plus their rect); `audio.music[].offsetMs` skips into the file. Music gain = volume × fades × duck while current narration plays; preview and export share this envelope. Scene pages are pure functions of time and load only local files. Clip ranges are source time; rate and end holds map them to output time. Narration offsets are relative to a clip's output start. Camera, highlights, animation and comment times are output time. Absolute effects do not move automatically when clips are reordered or fitted. Layout-preserving hiding uses visibility; display:none reflows. Text replacement does not recompute app logic.

Element overrides accept a captured target (`ref`, `nodeId` with optional `documentId`, or `selector`) or an HTML target (`scene: "scenes/title.html"`, `selector: "#title"`). Use one target kind. Scene targets apply to each instance of that source file. Optional `transform: {x, y, scaleX, scaleY}` adds a translation in document pixels and scale factors (0.05–20, default 1) to the authored transform. The authored transform origin remains in use. Both preview and export apply these overrides after seeking the scene. Camera and frame scaling do not change the saved units.

The direct editor and MCP `apply_element_edit` share a targeted patch operation. It changes only the supplied text, style properties, visibility or transform fields. A null text, style value or transform clears that override; `reset: true` removes all overrides for that exact target. The browser keeps drafts until a revision-checked save succeeds. Conflicts require an explicit choice. A drag or resize saves once at its end. Inline canvas text editing saves a single `text` patch through the same operation when you press Enter or Tab, or click outside. Multi-line text also saves `style["white-space"]: "pre-line"` on elements that would otherwise collapse line breaks.

`text` replaces the element's displayed text for the whole video and wins over later recorded text changes. Studio keeps the recorded text nodes. It compares the new text with the current text and keeps unchanged characters in their original nodes. Each changed run goes to the node it replaces, so nested formatting such as `<b>` or links remains. `<br>` elements are kept or hidden as the new line breaks require. Overrides apply from ancestors to descendants, so a nested element's own text edit takes precedence over its paragraph's. On a text-like `<input>` or a `<textarea>`, `text` sets the displayed value (and an input's `value` attribute). It replaces values from recorded input events during playback, seeking and export.

UI/MCP mutations read an opaque revision, validate, acquire the advisory project lock and compare expectedRevision before writing. Conflicts return HTTP 409 or a clear MCP tool error. Reread and merge intent; never retry a stale whole file blindly. Tracked changes preserve up to 50 undo entries in `.history/edits.json`. Each entry may name its `author` (MCP actor, session ID, tool and target ref/thread/segment; absent for local UI/CLI writes) and a short `changes` list (kind, label, file, ref, before/after). Undo can take `steps` to undo a whole agent turn in one locked operation and refuses to overwrite later direct-file changes. History snapshots the JSON files and overrides.css, so undo compares a content revision over exactly those; scene and audio writes (`write_project_file`, `lift_element`, narration audio) change the project revision but never break an undo chain. A damaged `.history/edits.json` is set aside as `edits.json.corrupt-<time>` and history starts over. The lock file (`.project.lock`, `.narration.lock`) holds the owner's pid and time; a lock whose process is gone or that was not refreshed for 30 s is taken over. Project files are never read through symlinks.

Filesystem agents are first-class writers: read current data, preserve unrelated fields, validate, then replace files atomically. The advisory lock cannot protect writers that ignore it. Coordinate simultaneous direct writes. Invalid/partial edits retain the last valid browser preview. Transcript drafts use field-level conflict handling. Element drafts keep the base revision and require an explicit choice after a concurrent write.

Narration text/settings determine audio identity. Keep stale audio metadata; the player suppresses it rather than playing the wrong script. Synthesis merges only matching current request identities. Credentials come only from the environment. Regeneration is explicit and may cost provider credits; fully cached requests work offline.

## Agent activity

MCP operations publish observed tool name, caller-reported client name, session/operation IDs, optional target ref/segment, timestamps and running/succeeded/failed status under .studio/activity/. A heartbeat detects interrupted operations. These are local feedback records, not model reasoning or authorization claims. They do not select elements or seek playback automatically; the human can choose Show element. Feedback failures never turn a committed content edit into an apparent failed tool call. Direct filesystem edits refresh normally but are not attributed to a named agent.
