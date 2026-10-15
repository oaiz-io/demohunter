# Local-first Studio application

GSD init.quick 261015-er8. Work in this session; no delegation. Preserve prior work.

1. Promote experiment to apps/studio with replay CLI compatibility. Keep browser contracts/render model separate from filesystem/HTTP/MCP adapters; no cloud dependency or speculative desktop shell.
2. Define v1 portable format and protocol, generated JSON Schemas, explicit compatibility policy, legacy reader, provenance and revision semantics.
3. Add bounded filesystem library discovery of captures/tours, search/filter/status, project-isolated routes, source/capture command handoff, multi-tab safety, live refresh and error handling.
4. Persist real MCP operation activity independently of canonical content. Display actor/tool/target/status, subtle element pulses, recent activity, optional focus; respect playhead and reduced-motion preferences.
5. Export edited replay to MP4/captions/checksummed output locally for CI, preserving source-independent playback and narration identity checks.
6. Verify contracts, migration, discovery/path safety, real MCP feedback, multi-project browser interactions, narration and actual ffmpeg output. Document deployment/Tauri boundary and limitations.

Primary research: Paper MCP https://paper.design/docs/mcp (explicit visual feedback during inspection, targeted HTML edits); Tauri https://v2.tauri.app/concept/architecture/ and https://v2.tauri.app/develop/sidecar/ (web frontend/core boundary, external binary packaging per target and scoped permissions); MCP progress https://modelcontextprotocol.io/specification/latest/basic/utilities/progress (request-scoped progress; does not convey private reasoning). Studio will expose observed tool activity only.
