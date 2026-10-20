# Research and decisions

- rrweb 2.1.7 is the current npm release checked on 2026-10-15. It provides record/Replayer, node mirrors, timed events, seek/pause, and local browser bundles. Sources: https://rrweb.com/docs/guide and https://github.com/rrweb-io/rrweb/blob/main/packages/rrweb/src/replay/index.ts.
- DOM snapshots and incremental events preserve rendered state, not executable application state. Replay scripts stay disabled. Original JavaScript, backend behavior, canvas/WebGL, third-party frames, and arbitrary CSS animation fidelity are outside this spike.
- Reuse collectTimeline/replayTimeline and resolveNarrationSegment directly inside an isolated source-run experiment. Draft narration duration lets capture work without keys; explicit synthesis uses existing cache/provider implementations.
- Keep capture immutable. Apply text/style/hide overrides after replay mutations and seeks; preserve mirrored nodes by updating text leaves rather than replacing subtrees. Rebuild from capture on file changes for clean undo. This is smaller than a full event compiler and appropriate for the experiment.
- Map output clip time to source capture time; apply all required prior state when seeking past a cut. Effects and narration use output time. Local asset bundling and browser libraries remove hosted replay dependencies.
- Use a small TypeScript browser UI, local HTTP server, and polling revisions rather than introducing an application framework or a cloud backend. External agents edit JSON/CSS; inspector context is written to selection.json.
- Begin with real DOM capture of a controlled math page. This tests the requested replay path rather than replacing it with authored animation scenes.
