# Studio format and editing protocol v1

This directory defines the local, portable source of truth. No database, account, hosted API or agent vendor is needed. The committed [JSON Schemas](schemas/) describe the individual files. `loadBundle` additionally validates cross-file constraints, source bounds, target exclusivity and unique IDs. Agent clients can call `get_contract` and `get_schema`.

## Identity and compatibility

`studio.json` identifies `format: "demohunter.studio"`, `formatVersion: 1`, `protocolVersion: 1`, a UUID `projectId`, and a `captureId` derived from the SHA-256 of immutable events.json bytes. project.json retains its own `schemaVersion: 1`. The manifest fixes the canonical filenames; arbitrary file indirection is not accepted. Optional source tour/config paths are provenance relative to the capture's consumer repository, not executable commands.

A project without studio.json is a supported legacy capture. First open adds the manifest without changing its content revision or rewriting captured events. Manifest creation is atomic across cooperating processes. Unknown major versions and malformed files fail before content mutation. There is no automatic lossy downgrade. Compatible readers must preserve v1 field meanings; new semantics requiring new reader behavior require explicit version/capability negotiation. Recapturing creates a new capture/project, never overwrites edited data.

DOM events currently use pinned rrweb 2.1.7. A different incompatible event encoding requires a format revision or explicit migration. This is a documented v1 contract for Studio, separate from DemoHunter's existing video-output manifest format.

## Canonical and derived files

| Files                   | Contract                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| studio.json             | Identity, format/protocol versions, filenames, optional source provenance                            |
| project.json            | Title, source viewport/duration, TTS configuration, capture warnings                                 |
| events.json, assets/    | Original recording and bundled resources; immutable                                                  |
| elements.json, sources/ | Versioned index and readable captured HTML; derived from the immutable capture, then stable          |
| edits.json              | Clips, persistent element overrides, camera, highlights, optional animations                         |
| narration.json, audio/  | Script/voice overrides and portable generated audio with request identity                            |
| comments.json           | Element/time-anchored threads, replies and resolution state; missing legacy file means empty threads |
| overrides.css           | Persistent page styles                                                                               |

Copied references use `demohunter://capture/<captureId>/element/<ref>?t=<output-ms>`. HTTP links also include the capture/ref/time so links resolve independently of a machine's absolute folder location. The registry maps refs to document/node IDs, hierarchy and annotated HTML. Refs survive edits, not recapture. Original application source is known only when the app supplied `data-demohunter-source` / `data-demohunter-line`. Editing inspection snippets does not change playback.

Runtime files are not canonical: selection.json, preview-state.json, preview-command.json, lock files, .history/, .studio/ (activity/poster cache), and exports/. Runtime/derived writes do not alter content revision. They may be discarded when moving a project. Keep audio/ and bundled assets for portable playback.

## Time and mutations

All persisted times are milliseconds. Clip ranges are source time; rate and end holds map them to output time. Narration offsets are relative to a clip's output start. Camera, highlights, animation and comment times are output time. Absolute effects do not move automatically when clips are reordered or fitted. Layout-preserving hiding uses visibility; display:none reflows. Text replacement does not recompute app logic.

UI/MCP mutations read an opaque revision, validate, acquire the advisory project lock and compare expectedRevision before writing. Conflicts return HTTP 409 or a clear MCP tool error. Reread and merge intent; never retry a stale whole file blindly. Tracked changes preserve up to 50 undo entries. Undo refuses to overwrite later direct-file changes.

Filesystem agents are first-class writers: read current data, preserve unrelated fields, validate, then replace files atomically. The advisory lock cannot protect writers that ignore it. Coordinate simultaneous direct writes. Invalid/partial edits retain the last valid browser preview. Transcript drafts use field-level conflict handling; other inspector/timing controls require reviewing unsaved manual input after external changes.

Narration text/settings determine audio identity. Keep stale audio metadata; the player suppresses it rather than playing the wrong script. Synthesis merges only matching current request identities. Credentials come only from the environment. Regeneration is explicit and may cost provider credits; fully cached requests work offline.

## Agent activity

MCP operations publish observed tool name, caller-reported client name, session/operation IDs, optional target ref/segment, timestamps and running/succeeded/failed status under .studio/activity/. A heartbeat detects interrupted operations. These are local feedback records, not model reasoning or authorization claims. They do not select elements or seek playback automatically; the human can choose Show element. Feedback failures never turn a committed content edit into an apparent failed tool call. Direct filesystem edits refresh normally but are not attributed to a named agent.
