# Original product research

> Historical document. This index records the initial product split. For current user documentation, start with the [documentation index](README.md).

The original research was split into two documents:

* `docs/phase_1_oss_core.md`
* `docs/phase_2_cloud_offering.md`

Use `docs/phase_1_oss_core.md` for the simple OSS scope:

* thin wrapper on top of Playwright
* local `.demohunter/` generation
* subtitles, video, manifest, and narration cache
* no auth abstractions, no built-in player, no cloud dependency

Use `docs/phase_2_cloud_offering.md` for the later hosted product:

* upload generated OSS output
* watch pages and sharing
* managed TTS
* publish flow
* cloud generation later
