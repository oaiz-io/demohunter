# Phase 01 — Output Quality

## Goal

Three features that make generated demos visibly more professional and more shareable, delivered as one cohesive PR.

## Features

### 1. Cookie Banner Dismissal Automation

**What it does:** Before recording, attempts to dismiss known cookie consent banners so they don't obscure the demo UI.

**Architecture:**
- New file: packages/generator-playwright/src/middleware/cookie-banner-middleware.ts
- Config: record.cookieBanners: { enabled, action, timeoutMs, additionalSelectors }
- CLI: --cookie-dismiss reject|accept|hide / --no-cookie-dismiss
- Curated, versioned, vendor-scoped selectors (OneTrust, Cookiebot, etc.)
- Runs after tour.setup and before user's beforeRecord in both passes
- Wraps runtime.goto() so middleware runs after subsequent navigations
- In Pass 2, suppress cursor/ripple/activity recording around automatic consent clicks
- Default: disabled initially (ships off, user opts in)
- User escape hatch: custom beforeRecord runs after built-in middleware; --no-cookie-dismiss bypasses

**Edge cases:** Cross-origin iframes, closed shadow roots, delayed banners, CSP, detached locators, misleading unrelated Accept buttons, banners after navigation, backdrop cleanup.

### 2. Smooth Cursor Animations

**What it does:** Replace the existing 50ms linear CSS cursor transition with SVG bezier arcs and add a synchronized click() helper.

**Architecture:**
- Enhance: packages/generator-playwright/src/overlays/recording-effects-runtime.ts
- Config: record.cursor: false | { mode, shape, color, sizePx, minDurationMs, maxDurationMs, pixelsPerMs, arcHeightPx, ripple }
- CLI: --cursor none|highlight|smooth|ripple
- SVG cursor inline in serialized function (as current comments require)
- Duration based on distance: 400ms min, 1200ms max
- Retargeting: if new mousemove arrives mid-animation, start from current position
- runtime.click(locator) helper: deterministic in both passes, animation completes before actual click
- Tag cursor/ripple elements with data-demohunter-overlay for future pause detection
- Maintain backward compatibility with existing showCursor/showClickRipple config booleans

**Edge cases:** First move with no prior location, viewport boundaries, scroll during motion, navigation, iframe coordinates, overlapping clicks, reduced-motion CSS, touch/mobile viewport.

### 3. Social Media Output Formats

**What it does:** --format standard|square|mobile|gif for different distribution channels.

**Architecture:**
- New package: packages/media-ffmpeg — typed render plans, scale/pad/GIF/filter graph generation
- New package types: MediaRenderPlan, VideoTransform, AudioTransform, MediaRenderer
- Move behavior of mux-video.ts into media-ffmpeg; keep compatibility wrapper
- CLI: --format standard --format square --format gif --duration 12
- Config: output.formats: [{ preset, layout?, durationMs? }]
- Presets: standard (1920x1080), square (1080x1080), mobile (390x844 scaled to 1080x1920), GIF (derived from MP4, 15s max, 12-15fps, no audio)
- fit variants reuse one capture; responsive variants need own browser passes
- Manifest v2: discriminated union schema alongside manifest v1
- Multi-variant paths: default at root, additional under variants/<preset>/
- Atomic staging -> validate -> publish per variant; failure leaves others untouched
- Deprecate ambiguous record.format in favor of record.container during migration

**Edge cases:** Responsive navigation differences, browser viewport vs screencast size, letterbox color, odd dimensions, enormous GIFs, gradients, long demos, GIF duration > video duration, WebM combos, partial variant failure.

## Shared Foundation Work

- packages/media-ffmpeg — Extracted ffmpeg layer. Phase 2 features produce plans; only this package knows filter graph syntax.
- Manifest v2 — Variant-aware schema for multi-format and future multi-language output.
- Typed CLI override system — GenerateOverrides object, clear precedence order.

## Execution Strategy

Single Codex session. All three features share browser-runtime injection and the new media-ffmpeg/manifest-v2 infrastructure.

## Verification

- bun run typecheck — zero errors
- bun test — all existing tests pass, new tests cover all three features
- bun run build — successful build
- Cookie middleware: HTML fixture tests for OneTrust-like, Cookiebot-like, delayed, no-banner
- Cursor: deterministic rAF mock tests, visual integration with recorded frame samples
- Formats: ffmpeg integration probing dimensions, fps, pixel format, duration, GIF metadata
- Regression: existing tours generate identical output with all new features disabled
- E2E: demohunter generate demos/demohunter-github.tour.ts --format standard --format gif --cursor smooth --cookie-dismiss reject
