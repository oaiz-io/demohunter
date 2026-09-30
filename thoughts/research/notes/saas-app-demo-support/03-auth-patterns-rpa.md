# 03 - Browser-automation auth patterns, anti-detection, and RPA precedent

Research date: 2026-09-30. Budget: 8 web fetches/searches. Items marked **UNVERIFIED** were not confirmed against a primary source in this session (recalled from prior knowledge or secondary sources only).

## 0. Current DemoHunter baseline (from repo, for context)

- `packages/generator-playwright/src/generate.ts` calls `browserType.launch()` with no options (bundled browser, default headless), then pass 1 and pass 2 each call `browser.newContext({ baseURL, viewport })`. No `storageState`, no persistent context, no `channel`.
- `packages/generator-playwright/src/record/screencast.ts` already uses Playwright's **public** `page.screencast.start({ path, size })` / `showActions()` / `stop()` API (see 1.6), not raw CDP `Page.startScreencast`.
- Implication: adding `storageState` to both `newContext()` calls is the smallest possible auth change. Both passes would get the same logged-in cookies/localStorage/(optionally) IndexedDB.

## 1. Playwright auth primitives

Source: https://playwright.dev/docs/auth

### 1.1 storageState save/load and the setup-project pattern
- Save: `await page.context().storageState({ path: authFile });`
- Load per project (config):
  ```js
  { name: 'chromium', use: { storageState: 'playwright/.auth/user.json' }, dependencies: ['setup'] }
  ```
- Load per context: `const context = await browser.newContext({ storageState: 'playwright/.auth/admin.json' });`
- The "setup project" pattern: an `auth.setup.ts` test logs in once and writes the state file; other projects declare `dependencies: ['setup']` and consume it.
- Coverage statement: "Reusing authenticated state covers cookies, local storage, IndexedDB..." (IndexedDB requires the opt-in option, see 1.3).

### 1.2 Secrets warning
- Exact quote: "The browser state file may contain sensitive cookies and headers that could be used to impersonate you or your test account. We strongly discourage checking them into private or public repositories."
- The docs recommend a `playwright/.auth` directory and adding it to `.gitignore` (the gitignore snippet was referenced on the page; exact wording not captured by the fetch - treat the specific `.gitignore` line as **UNVERIFIED** wording, the recommendation itself is standard in the page).
- DemoHunter relevance: a state file is a bearer credential for the user's Notion/Slack/Gmail session. That conflicts in spirit with "DemoHunter does not store credentials" unless the file lives outside `.demohunter/` output, is gitignored, and is explicitly user-owned. It must never be emitted into the portable `.demohunter/` artifact.

### 1.3 sessionStorage and IndexedDB
- Exact quote: "Session storage is specific to a particular domain and is not persisted across page loads. Playwright does not provide API to persist session storage, but the following snippet can be used to save/load session storage." Workaround uses `page.evaluate(() => JSON.stringify(sessionStorage))` to save and `context.addInitScript(...)` to restore on the matching hostname.
- IndexedDB: Playwright **v1.51** release notes: "New option indexedDB for browserContext.storageState() allows to save and restore IndexedDB contents." (https://playwright.dev/docs/release-notes). Relevant for SPAs like Notion/Slack that cache heavily in IndexedDB (whether their *auth* depends on IndexedDB is **UNVERIFIED**; likely cookie-based).

### 1.4 launchPersistentContext caveats
- `browserType.launchPersistentContext(userDataDir, options)` uses a real on-disk profile (cookies, extensions, IndexedDB, service workers persist naturally).
- Browsers refuse multiple instances on the same user data dir; Playwright docs note this (**UNVERIFIED** exact wording this session; recalled: "Browsers do not allow launching multiple instances with the same User Data Directory"). For DemoHunter, this means the two passes could not run in parallel on one profile, and the user's running Chrome cannot share its profile.
- **Chrome 136+ blocks remote debugging on the default profile.** Primary source: https://developer.chrome.com/blog/remote-debugging-port - starting in Chrome 136, `--remote-debugging-port` / `--remote-debugging-pipe` "will no longer be respected if attempting to debug the default Chrome data directory" and must be accompanied by `--user-data-dir` pointing at a non-standard directory. Rationale: prevent attackers attaching to a real profile and exfiltrating cookies; a non-standard dir uses a different encryption key. Consequence: DemoHunter **cannot** just "reuse the user's everyday Chrome login". It needs a dedicated DemoHunter profile dir (e.g. `~/.demohunter/profiles/<name>`) where the user logs in once, headed.
  - Secondary confirmation: https://github.com/trycua/cua/issues/2916, https://github.com/SeleniumHQ/selenium/issues/16274.

### 1.5 channel: 'chrome' vs bundled Chromium; headless modes
- Playwright **v1.49** release notes (https://playwright.dev/docs/release-notes): breaking change - "chrome and msedge channels switch to new headless mode"; opting into `channel: 'chromium'` enables "the new headless mode", described as the real Chrome browser and more authentic. Default `chromium` headless uses the separate `chromium-headless-shell` build (old headless), which is easier to fingerprint.
- `channel: 'chrome'` uses the installed branded Google Chrome (proprietary codecs, real Chrome UA, Google-branded build) - generally better for Google sign-in and media-heavy apps, but requires Chrome installed on the machine.
- Recommendation for SaaS demos: headed or `channel: 'chrome'`/`'chromium'` new-headless, never headless-shell, for login flows.

### 1.6 Public screencast API (verified)
- Playwright **v1.59** added `page.screencast` (release notes list `screencast.start()`, `stop()`, `showActions()`, `hideActions()`, `showChapter()`, `showOverlay()`, `showOverlays()`, `hideOverlays()`; "video recording, real-time frame streaming, and overlay management").
- Class docs https://playwright.dev/docs/api/class-screencast : "Interface for capturing screencast frames from a page." Added in v1.59. `start(options?): Promise<Disposable>` with options `path`, `onFrame` (JPEG `{ data, timestamp, viewportWidth, viewportHeight }`), `size` `{ width, height }`, `quality` (0-100). `stop(): Promise<void>`.
- Browser support (Chromium-only vs all) and headless requirements are **not stated** on the class page - **UNVERIFIED**.
- The screencast is per-page and independent of how the context was created, so it should work the same with `newContext({ storageState })` or `launchPersistentContext` (**UNVERIFIED** in practice; no known restriction found).
- `recordVideo` on context options still exists (older API); not re-verified this session.

## 2. Automation detection

- Playwright/Chromium under automation sets `navigator.webdriver === true` and Playwright passes `--enable-automation` by default (issue reports: https://github.com/microsoft/playwright/issues/19420, https://github.com/executeautomation/mcp-playwright/issues/147, https://github.com/link-foundation/browser-commander/issues/101).
- Google sign-in shows "This browser or app may not be secure" for automated browsers (Google community thread: https://support.google.com/chrome/thread/224353947). Playwright issue #19420 is titled "Chrome Browser being tagged as 'insecure' by Google".
- Common community workarounds (secondary sources, not endorsed by Playwright or Google): `args: ['--disable-blink-features=AutomationControlled']`, `ignoreDefaultArgs: ['--enable-automation']`, init script to shadow `navigator.webdriver`, prefer branded `channel: 'chrome'`, headed login.
- Risk: these are evasion techniques against Google's security policy. Whether they work is fragile and changes without notice; Google's official position on circumventing this is **UNVERIFIED** here but it is a ToS/security gray area. Safer pattern: user logs in **manually** in a headed DemoHunter-owned profile (a human doing the sign-in), then DemoHunter reuses the session (storageState or persistent profile). Even so, Google may still flag the session later (**UNVERIFIED**).

## 3. Anti-detection projects (license + maintenance risk)

| Project | Repo | License | Engine | Maintenance / risk |
|---|---|---|---|---|
| Patchright | https://github.com/Kaliiiiiiiiii-Vinyzu/patchright | Apache-2.0 | Chromium only (no Firefox/WebKit) | ~4.7k stars, auto-deploys new versions tracking Playwright; "potential bugs may take several days to fix following Playwright codebase changes"; "Patchright passes most, but not all the Playwright tests." Patches Runtime.enable leak, disables Console API, adds `--disable-blink-features=AutomationControlled`, removes `--enable-automation`. npm package `patchright` (drop-in for `playwright`). Risk: medium - small maintainer team, lags upstream, and would break DemoHunter's `>=1.61` + `page.screencast` assumptions until patched builds catch up; console disabled impacts debug capture. |
| Camoufox | https://github.com/daijro/camoufox | MPL-2.0 (browser), MIT (Python and TS launchers) | Firefox fork, C++-level fingerprint spoofing | ~12.2k stars; README warning: "This project is under development. It may not be suitable for stable production use." Has Python and JS/TS packages with Playwright-compatible interface. Risk: high for DemoHunter - Firefox-based (Playwright's Firefox is a patched Juggler build; whether `page.screencast` works on Camoufox is **UNVERIFIED**), and maintainer history has had pauses (**UNVERIFIED** detail this session). |
| nodriver | https://github.com/ultrafunkamsterdam/nodriver | **UNVERIFIED**: believed AGPL-3.0 | Python-only, CDP-direct Chrome (successor to undetected-chromedriver) | Not Playwright; Python-only; not fetched this session. Risk: high - wrong language/runtime and (if AGPL) license-incompatible with shipping inside an MIT/Apache OSS TS CLI. |

Takeaway: bundling any of these into the OSS core is a product/legal liability (positions DemoHunter as an evasion tool) and a technical liability (lags Playwright). At most, document a user-supplied `browser` escape hatch; do not depend on them.

## 4. RPA precedent

- **UiPath** (**UNVERIFIED**, from prior knowledge; not fetched): browser automation requires the UiPath browser extension installed in Chrome/Edge; the Robot runs on a user machine (attended) or a VM (unattended); credentials stored as Orchestrator Assets (Credential type) or external credential stores (e.g. CyberArk, Azure Key Vault). Precedent: operate the user's *real* browser via an extension rather than a fresh automation-flagged context.
- **Power Automate Desktop** (**UNVERIFIED**, from prior knowledge; not fetched): requires the Power Automate browser extension for Chrome/Edge/Firefox; flows run on the user's Windows machine (attended, user signed in) or unattended on a machine/VM with stored Windows credentials; secrets via Azure Key Vault or sensitive-text variables. Same precedent: real browser + extension + existing user session.
- **Skyvern** (https://github.com/Skyvern-AI/skyvern): OSS under **AGPL-3.0**, with "anti-bot measures available in our managed cloud offering" excluded from OSS. Described as "a Playwright extension that adds AI-powered browser automation" with a "Playwright-compatible SDK". Credential handling via password manager integrations (Bitwarden, 1Password, LastPass); 2FA via "QR-based 2FA (e.g. Google Authenticator, Authy)" (TOTP), email-based, and SMS-based. Cloud version comes "bundled with anti-bot detection mechanisms, proxy network, and CAPTCHA solvers." Precedent: even an AI-agent automation company keeps anti-bot evasion out of its OSS core and in its paid cloud.

## 5. Implications for DemoHunter (research-level, not a decision)

1. Lowest-risk path: opt-in `storageState` (plus `indexedDB: true`) passed to both `newContext()` calls; state file created by a headed `demohunter login <profile>` step where a **human** signs in; file stored outside the repo/output by default, gitignored, never in `.demohunter/`.
2. Alternative: `launchPersistentContext` with a DemoHunter-owned profile dir (never the default Chrome profile - blocked since Chrome 136). Breaks the "fresh context per pass" model; passes must run sequentially and state mutated in pass 1 leaks into pass 2.
3. Prefer `channel: 'chrome'` (or new headless) for SaaS targets; bundled headless-shell is most likely to trip detection.
4. Do not ship stealth/evasion (patchright/Camoufox/nodriver) in the OSS core; Skyvern's split (evasion only in cloud) is a precedent worth noting.
5. Google (Gmail) is the hardest target because of the explicit automated-browser sign-in block; Notion/Slack detection behavior not researched here (**UNVERIFIED**).
