---
quick_id: 260902-m9p
status: complete
completed: 2026-09-02
commit: 954a271
---

# Quick Task 260902-m9p Summary

Aligned DemoHunter with its new OAIZ Labs ownership and improved the public open-source documentation.

## Completed

- Named OAIZ AB in the MIT copyright notice and npm package author metadata.
- Updated repository, issue, changelog, CLI-help, config, and demo links to `oaiz-io/demohunter`.
- Reduced the README from 198 lines to 123 lines and kept the first-use flow prominent.
- Added a documentation index and marked early OSS and cloud plans as historical.
- Added contribution and security policies.
- Corrected stale Playwright and TTS statements in project and agent guidance.

## Verification

- `bun run verify`: 296 passed, 1 optional live test skipped, 0 failed.
- Public Markdown link audit: 11 files checked.
- Package metadata JSON and OAIZ ownership fields validated.
- `git diff --check`: passed.

## Follow-up

GitHub private vulnerability reporting is disabled on `oaiz-io/demohunter`. Enable it in repository settings when OAIZ is ready to accept reports through GitHub. Until then, `SECURITY.md` directs reporters to request a private channel through OAIZ without sending sensitive details.
