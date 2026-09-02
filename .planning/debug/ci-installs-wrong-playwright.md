---
status: resolved
trigger: CI failed on PR #25 because the installed Chromium runtime did not match the Playwright version used by tests.
created: 2026-09-02
updated: 2026-09-02
---

# Debug: CI installs the wrong Playwright browser

## Symptoms

- Expected: CI installs the Chromium revision required by the lockfile and `bun run verify` passes.
- Actual: The install step passes, but all browser launches fail during verification.
- Error: Playwright expects `chromium_headless_shell-1228`, but it does not exist.
- Reproduction: Run PR CI with Bun 1.4.0.

## Current Focus

- hypothesis: `bun x playwright` cannot find a root Playwright binary and downloads the latest CLI instead of using the Playwright 1.61 CLI installed in `packages/cli`.
- test: Compare the installed browser revision in CI logs with the revision requested by the test runtime.
- expecting: CI installs revision 1234 while the runtime requests revision 1228.
- next_action: Complete. The workflows now invoke the workspace-local Playwright binary.

## Evidence

- timestamp: 2026-09-02T16:32:00+02:00
  observation: The CI install log shows Playwright Chromium revision 1234.
- timestamp: 2026-09-02T16:32:00+02:00
  observation: The verification error requests Playwright Chromium headless shell revision 1228.
- timestamp: 2026-09-02T16:32:00+02:00
  observation: `packages/cli/node_modules/.bin/playwright --version` reports 1.61.0, and there is no root `node_modules/.bin/playwright`.

## Eliminated

- hypothesis: The browser download or operating-system dependency install failed.
  reason: Both downloads completed and the install step exited successfully.

## Resolution

- root_cause: `bun x playwright` ran from the repository root, which has no Playwright binary. Bun 1.4 downloaded the latest Playwright CLI and installed browser revision 1234. Tests load Playwright 1.61 from `packages/cli` and require browser revision 1228.
- fix: CI, release, and weekly dependency workflows now run Playwright from `packages/cli`. The contribution guide uses the same command. The onboarding contract rejects the unpinned root command.
- verification: The workspace-local command reports Playwright 1.61.0 and Chromium revision 1228. The four onboarding contract tests pass, and `git diff --check` passes.
- files_changed: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/weekly-bun-dependencies.yml`, `tests/e2e/oss-onboarding-contract.test.ts`, `CONTRIBUTING.md`
