# Quick task 261117-spd: Studio speed fixes

## Problem

The product assessment (`thoughts/research/2026-11-17-product-assessment/`) measured why Studio is slow. The library poll runs git in every worktree. Posters and thumbnails start a new Chromium, and any edit makes all of them stale. The capture file is unzipped and hashed on each load. Responses are never cached. A backward scrub seeks two times for each pointer event. `update()` does all work on each frame. Polls run when the page is hidden.

## Tasks

Do them in this order. Each task has its own commit with a before and after number.

1. Library scan: `git ls-files --cached` only, a stat probe for `.demohunter` folders, a cached worktree list, `git status` only for changed worktrees (throttled), file watching with a poll as fallback, ETag and 304 on `/api/library`, a deterministic and cached plain-folder walk, no `command` string per tour.
2. Posters, thumbnails and MCP screenshots: one warm browser with an idle timeout, cache keys from visual data per clip, small JPEG thumbnails, a size-bounded LRU cache, debounce and cancel of superseded renders, MCP `get_screenshot` through the warm renderer.
3. Capture file: no validate-and-discard read in `loadBundle`, lazy single-entry reads with native zlib, a size and mtime key instead of a hash on each load.
4. HTTP caching and payload: `immutable` for revisioned URLs, ETag for bundles and CSS, minified bundles, zod out of the client bundles.
5. Scrub and seek: one seek per animation frame, no redundant seek in `setPlaying(false)`, rrweb `checkoutEveryNms` for new captures, a test of `useVirtualDom: true`.
6. Per-frame `update()`: split by what changed, 60 Hz cap, stop the loop when paused and clean.
7. Polls: status poll answers 304 when unchanged, polls pause when the page is hidden.
8. Desktop: start the service in parallel with the status page and the browser check.

## Rules

- A restricted library never runs `git status` or other code that a repository can configure.
- Keep the host guard, inert asset serving, revision checks and the project lock.
- Cache headers must never show a stale project state as current.
- The set of failing tests must not grow. Baseline: 167 pass, 0 fail; typecheck clean.
