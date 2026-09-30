# Narrated demos of real SaaS applications: Notion, Slack, Gmail

**Research date:** 2026-09-30

**Scope:** Whether DemoHunter can sign in to real third-party web applications (Notion, Slack and Gmail are the named examples) and record narrated demos of real product use through ordinary `.tour.ts` files. The research covers the current two-pass generator on `main` @ `2fe22b4`, Playwright 1.61 behaviour, provider terms and sign-in policies, and prior art in agent, RPA and demo tooling. Repository claims cite `file:line`. Web claims cite primary URLs. Anything not checked against a primary source is marked **UNVERIFIED**.

**Decision:** Support real-SaaS demos by passing a user-owned Playwright session file into both passes, not by teaching DemoHunter to sign in. Add a small, optional `session.storageState` config (with an environment override) that both passes load into their fresh browser contexts. Add doctor and CLI guardrails around it, and write documentation that treats live accounts as a separate risk class: side effects happen once per pass, personal data can reach the output, and Google blocks automated sign-in. Launch options, a `session capture` helper and layout-tolerant click replay should follow as separate slices. Stealth or anti-detection tooling, stored passwords and a productized "log into Google for you" feature stay out of the OSS core.

## Executive summary

DemoHunter already records real third-party websites. The repository's own dogfood demo points at `https://github.com/oaiz-io/demohunter` (`demohunter.config.ts:2`, `demos/demohunter-github.tour.ts:10-13`). What it lacks for Notion, Slack and Gmail is a **signed-in** browser, and today that is left to the author on purpose. The v1 requirements say authors keep "auth, session, and app bootstrap logic in normal Playwright code" (`.planning/milestones/v1.0-REQUIREMENTS.md:39`). The authoring reference forbids invented helpers such as `login()` (`packages/cli/skills/demohunter/references/authoring.md:60`).

Five findings shape the answer:

1. **Each pass has its own fresh, cookie-less context, and nothing carries between them.** `generate.ts` calls `browser.newContext({ baseURL, viewport })` for Pass 1 (`packages/generator-playwright/src/generate.ts:135-138`), closes it (`:171`), and creates a second bare context for Pass 2 (`:174-177`). A login done in `beforeRecord` therefore has to happen twice per generation, plus twice more for every responsive output variant (`:324`). Interactive 2FA inside that flow is impractical.
2. **The auth problem is solvable without DemoHunter touching credentials.** Playwright already ships the pieces. `npx playwright open --save-storage=<file>` opens a headed browser, lets a human sign in, and writes a storage-state file. `browser.newContext({ storageState })` loads that file. Both exist in the Playwright 1.61 bundle the repo pins. A tour can even load cookies today, with zero DemoHunter changes, via `page.context().addCookies(...)` in `setup`. The core change is therefore ergonomics and safety, not a new capability.
3. **Replay determinism is looser than it looks, but live apps can still break it.** Replay compares only DemoHunter's own helper events with `isDeepStrictEqual` (`packages/generator-playwright/src/execute/replay-timeline.ts:172`). It never compares DOM, selectors or text on the page. The one layout-sensitive field is the smooth-cursor `click.durationMs`. It is derived from on-screen distance and changes whenever two consecutive click targets are between about 560 and 1680 px apart and the layout shifts between passes (`packages/generator-playwright/src/runtime/create-smoke-tour-runtime.ts:256-261`, `packages/sdk/src/config.ts:169-171`). Live apps also bring popups, drifting lists and never-idle networks, which surface as locator timeouts rather than as replay mismatches.
4. **Live accounts make every pass real.** `setup`, `beforeRecord`, `run` and `teardown` all execute in **both** passes (`packages/generator-playwright/src/execute/collect-timeline.ts:72-82`, `replay-timeline.ts:99-109`). A tour that sends a Slack message sends it at least twice per generation. Failure debug capture writes the page's body text and a full-page screenshot into the output directory (`packages/generator-playwright/src/debug/failure-artifacts.ts:75-111`), which for Gmail means inbox content.
5. **Providers differ sharply.** Google's help centre says it may block sign-in from browsers "being controlled through software automation rather than a human" ([Google Account Help](https://support.google.com/accounts/answer/7675428)), and its terms forbid "bypassing our systems" ([Google Terms](https://policies.google.com/terms)). Slack's acceptable-use policy (now the Salesforce policy) has no clause against a user automating their own web client, but every Slack workspace is organization-controlled. Notion's Personal Use Terms prohibit robots that access the service "to monitor, extract, copy or collect information" (quote verified only through a search snippet; see Part 1.5). The friendliest target is Notion in a dedicated demo workspace the user owns. The hardest is Gmail.

Prior art (Part 2) shows a clear gap. Agent tools (Operator, Claude computer use, browser-use, Playwright MCP, Browserbase) can act while signed in, and some record raw video, but their runs are model-driven and not repeatable. Demo tools (Arcade, Supademo, Storylane, Loom, Tella) produce polished output from a human's signed-in browser, but every take is manual. None produces a scripted, deterministic, re-runnable, narrated video from code against a signed-in SaaS app. DemoHunter can fill exactly that gap.

## Current DemoHunter architecture (as it bears on this question)

```text
demohunter generate demos/x.tour.ts
        |
        v
browserType.launch()                  (no options: default headless, bundled Chromium)
        |
        +-- Pass 1: newContext({ baseURL, viewport })     <- no cookies, no storage
        |      goto(baseURL) -> setup -> cookie middleware -> beforeRecord -> run -> teardown
        |      strict event list recorded; then TTS resolved/cached per narration
        |      context closed
        |
        +-- Pass 2: newContext({ baseURL, viewport })     <- again no cookies, no storage
        |      addInitScript(recording effects)
        |      goto(baseURL) -> setup -> cookie middleware -> beforeRecord
        |      -> startScreencast -> run (events matched 1:1) -> teardown
        |
        +-- per responsive variant: generateTour() again  (two more passes each)
        |
        v
mux video + narration -> .demohunter/<tour>/ (video, captions, chapters, audio, manifest)
```

Code anchors:

- Tour shape: `defineTour({ id, title, setup?, beforeRecord?, run, teardown? })` (`packages/sdk/src/tour.ts:14-25`).
- Lifecycle hooks receive only `{ config, goto, page }` (`packages/sdk/src/runtime-types.ts:64-68`). `run` also receives `chapter, step, narrate, narrateWhile, waitForStable, highlight, snapshot, assertVisible, click` (`runtime-types.ts:121-133`); `typeText` is exposed on the `narrateWhile` timeline (`:91-93`).
- Config: `baseURL, outputDir, cacheDir, browser, viewport, holdPaddingMs, record, output, tts` (`packages/sdk/src/config.ts:128-138`). `browser` is only a name (`chromium | firefox | webkit`, `config.ts:1`), defaulting to `chromium` (`config.ts:216`).
- Config loading and validation: `packages/cli/src/config/load-config.ts:28-67`.
- Orchestration: `packages/generator-playwright/src/generate.ts:93-409`.
- The simpler smoke path launches the same way (`packages/generator-playwright/src/smoke-generate.ts:84`, `:91`), and so does `demohunter doctor` (`packages/cli/src/commands/doctor.ts:138`).

A repository-wide search for `storageState`, `addCookies`, `launchPersistentContext`, `userDataDir`, `headless` and `credential` in TypeScript sources finds no auth or session plumbing. The only `headless` hits are two tests that call `chromium.launch({ headless: true })` (`packages/generator-playwright/src/middleware/cookie-banner-middleware.test.ts:15`, `packages/generator-playwright/src/overlays/recording-effects-control.test.ts:18`). The only credential handling is the TTS environment-key boundary in `AGENTS.md:14`.

## Part 1 — Anatomy: how the current pipeline constrains real-SaaS demos

### 1.1 Auth and session state across the two passes

**What happens today.** `generateTour` launches one browser with `browserType.launch()` and no options (`generate.ts:113`). Pass 1 gets `browser.newContext({ baseURL: config.baseURL, viewport: config.viewport })` (`generate.ts:135-138`). After collection, that context is closed (`generate.ts:171-172`). Pass 2 then gets a second context with the same two options (`generate.ts:174-177`). A new Playwright context starts with an empty cookie jar and empty storage, so nothing a user did in Pass 1 exists in Pass 2.

Both passes start the same way:

- `collect-timeline.ts:67` and `replay-timeline.ts:94` first call `page.goto(new URL(config.baseURL).href)`. That first navigation is **always unauthenticated** today. For `https://www.notion.so`, `https://app.slack.com` or `https://mail.google.com` it lands on a marketing page or a sign-in redirect.
- `setup` then runs (`collect-timeline.ts:72`, `replay-timeline.ts:99`), then cookie-banner middleware (`:73-74`, `:100-101`), then `beforeRecord` (`:75`, `:102`), then `onBeforeRun` (`:76`, `:103`), then `run` (`:77`, `:104`), and finally `teardown` in a `finally` block (`:82`, `:109`).

**Consequences for a login inside `beforeRecord`:**

- **At least two sign-ins per `generate`.** The count is 2 × (1 + number of responsive output presets). Each responsive preset calls `generateResponsiveVariant`, which re-enters `generateTour` with a new viewport (`generate.ts:311-338`). A config with `standard` and `mobile` responsive outputs therefore signs in six times.
- **Interactive 2FA is impractical.** The lifecycle has no pause-for-human point. DemoHunter's CLI does not prompt during generation, and the browser is headless by default (Part 1.4), so a human cannot type a code. Automating TOTP from a seed held in an environment variable is technically possible, but it has two problems. Servers commonly reject reuse of the same code within its window, and repeated fresh sign-ins trigger "new sign-in" security mail and risk-based challenges (**UNVERIFIED** per provider; this is general provider behaviour, not documented for these three).
- **Email magic-link and emailed-code sign-in, which Notion offers, cannot be completed inside a tour at all** without reading the mailbox (**UNVERIFIED** as the default Notion flow for a given account).

**Where session state would need to be injected.** There are two context-creation points, `generate.ts:135` and `generate.ts:174`, plus the smoke path at `smoke-generate.ts:91`. Loading the **same** user-supplied state into both contexts preserves the property the two-pass design relies on: both passes begin from the same client state. Capturing state at the end of Pass 1 and handing it to Pass 2 would also work mechanically. But Pass 2 would then start from a client state Pass 1 had already mutated, for example a last-visited-page entry in local storage. That is exactly the kind of drift replay cannot absorb (Part 1.2). See Part 3.1 for the refresh-token caveat that could force carry-forward for some providers.

**What authors can reach today.** `DemoHunterLifecycleContext` exposes `config`, `goto` and `page` (`runtime-types.ts:64-68`). `page.context()` is the full Playwright `BrowserContext`, so an author can already call `context.addCookies()` inside `setup` (see Part 4.1 for the zero-code recipe). There is no DemoHunter-level hook before context creation. That is why the initial `page.goto(baseURL)` cannot be authenticated without a config change.

**Timing between passes.** Narration synthesis happens after Pass 1's `run` and `teardown` complete (`collect-timeline.ts:94`, `buildCollectedTimeline` at `:97-140`). On a cold cache, the gap between Pass 1 sign-in and Pass 2 sign-in includes every uncached TTS request. It is short in absolute terms and not a realistic expiry window for the long-lived cookies these apps use. It does mean an **expired** session fails in Pass 1's `setup` or `beforeRecord`, before any TTS spend. That is the right place to fail.

### 1.2 Determinism versus live SaaS state

**What replay actually compares.** Every DemoHunter helper emits a `TourRuntimeEvent` (`packages/generator-playwright/src/execute/generator-types.ts:11-75`). The kinds are `chapter, step-start, step-end, narrate, type-text, narration-sleep, wait-for-stable, highlight, snapshot, assert-visible, click` (`generator-types.ts:11-23`). In Pass 2, each emitted event is compared with the next collected event:

- An event arriving after the collected list is exhausted throws `extra-event` (`replay-timeline.ts:159-168`).
- An event that is not `isDeepStrictEqual` to the expected one throws `mismatch` (`replay-timeline.ts:172-182`).
- If Pass 2 ends before the list is exhausted, `assertReplayComplete` throws `missing-event` (`replay-timeline.ts:120`, `:300-317`).

**What the events contain, and what they don't.** Events carry titles, narration text and options, typed text with its seeded delay list, wait states, timeouts and click options (`generator-types.ts:25-75`). They do **not** carry locators, selectors, element text, URLs, DOM snapshots or screenshots:

- `highlight` emits only `{ kind, chapterTitle, ...options }` (`create-smoke-tour-runtime.ts:190-198`).
- `assertVisible` emits only `{ kind, chapterTitle, timeoutMs }` (`:213-224`).
- Raw Playwright calls (`page.click`, `page.fill`, `locator.press`) emit nothing and are invisible to the matcher.

This matters for live SaaS. The page content can differ between passes — a different unread count, another row in a list, a new notification dot, a teammate's message — without any replay error, **as long as the same helpers run in the same order with the same arguments**.

**The layout-sensitive field: `click.durationMs`.** The DemoHunter `click` helper measures the target's bounding box. It computes the distance from the previous explicit cursor position and emits `durationMs = round(clamp(distance / pixelsPerMs, minDurationMs, maxDurationMs))` when smooth cursor mode is on (`create-smoke-tour-runtime.ts:225-271`). The defaults are `minDurationMs: 400`, `maxDurationMs: 1200` and `pixelsPerMs: 1.4` (`config.ts:164-174`). So any distance below 560 px clamps to 400 ms and any distance above 1680 px clamps to 1200 ms. Between those, **every pixel of layout drift between passes changes `durationMs` and fails replay with `mismatch`**. Typical triggers:

- a dismissible banner that appears in one pass and not the other ("Try the new sidebar", "Enable desktop notifications", trial or billing banners);
- an extra sidebar entry pushing targets down;
- Gmail's inbox gaining a row;
- A/B layout variants served to the same account.

Navigation resets the cursor origin (`create-smoke-tour-runtime.ts:78-82`, `:104-114`), so only clicks on the same document are affected. The field exists so that Pass 1 waits for motion that Pass 2 will render. It has no other role in the collected timeline: narration timestamps are taken from Pass 2's wall clock (`generate.ts:220-248`), and `narrateWhile` computes the remaining wait from Pass 2's real elapsed time (`replay-timeline.ts:289-292`).

**Failure modes that surface as timeouts, not mismatches:**

- **Popups and interstitials.** Onboarding tours, "what's new" modals, cookie or consent dialogs on first load of a fresh context, notification-permission prompts and session-reauth prompts. A fresh context per pass means first-visit UI can appear in **both** passes, or in only one if the provider remembers dismissal server-side. The cookie-banner middleware only knows vendor consent banners (`packages/generator-playwright/src/middleware/cookie-banner-middleware.ts`) and is off by default (`config.ts:157-162`).
- **Never-idle networks.** `waitForStable()` defaults to `waitForLoadState("networkidle")` (`create-smoke-tour-runtime.ts:178-189`). Playwright's own type docs mark `networkidle` as **DISCOURAGED** (`playwright-core@1.61.0/types/types.d.ts:3172`). Apps that poll or beacon continuously may never go idle, or may go idle at different times per pass (**UNVERIFIED** for these three apps specifically). SaaS tours should pass `{ state: "domcontentloaded" }` and wait on a user-facing locator, which the repo's own GitHub demo already does (`demos/demohunter-github.tour.ts:50-52`).
- **Server-side results of Pass 1.** If Pass 1 creates a Notion page titled "Q3 plan" and nothing deletes it, Pass 2 sees two "Q3 plan" entries. `getByRole(..., { name: "Q3 plan" })` then hits Playwright's strict-mode multiple-match error, or the sidebar shifts and the next click's `durationMs` changes. Part 1.6 covers this in detail.

**Selectors on SaaS apps.** The authoring reference asks for "stable and user-facing" selectors — headings, labels, buttons and explicit test ids (`authoring.md:61`). Third-party apps provide no test ids for their customers, and some use generated class names or dynamic ids. Role and label selectors (`getByRole`, `getByLabel`, `getByPlaceholder`) remain the right choice because accessibility names are the most stable public surface. They are not a contract, though: vendors rename buttons without notice. Real-SaaS tours are therefore **expected to rot** in a way local-app tours are not. The user does not control the release train, and there is no CI signal until the next generation fails.

### 1.3 Where the video actually starts

The screencast starts inside `onBeforeRun` in Pass 2 (`generate.ts:205-218`). `replayTimeline` calls `onBeforeRun` after `setup`, the cookie middleware and `beforeRecord` have completed, and immediately before `run` (`replay-timeline.ts:99-104`). Everything up to and including `beforeRecord` is therefore **off camera**, and the documentation's "before the final video starts" guidance is accurate (`authoring.md:22-23`, `:68`).

Three further facts matter for auth design:

- **`beforeRecord` is not Pass 2-only.** It runs in Pass 1 too (`collect-timeline.ts:75`). `wrapTourForRecording` does not touch `beforeRecord` at all. It only replaces `run` to add chapter overlays and highlight visuals (`generate.ts:539-605`). Every login placed in `beforeRecord` runs once per pass.
- **`teardown` runs after the screencast has started and before it stops.** `stopScreencast` is called after `replayTimeline` returns (`generate.ts:276-280`), and `replayTimeline` runs `teardown` in its `finally` (`replay-timeline.ts:107-114`). **Cleanup performed in `teardown` is recorded at the tail of the Pass 2 video.** A tour that deletes the page it created, or signs out, will show that on camera unless teardown is instantaneous. It should be; see Part 3.4.
- **Pass 2 has a page-observable difference from Pass 1.** `installRecordingEffects` adds an init script to the Pass 2 context only (`generate.ts:188-192`, `packages/generator-playwright/src/overlays/install-recording-effects.ts:17`). It defines `window.__demohunterEffects` and injects cursor and ripple DOM. A SaaS page could in principle observe it. None of the three apps is known to react to foreign DOM outside its editor roots (**UNVERIFIED**).

### 1.4 Bot and automation detection surface

**What DemoHunter launches today.** It calls `browserType.launch()` with no options (`generate.ts:113`). Playwright's `headless` option "Defaults to `true`" (`playwright-core@1.61.0/types/types.d.ts:16120-16124`). For Chromium without a `channel`, Playwright 1.61 resolves the executable to `chromium-headless-shell` when headless (`getExecutableName` in `playwright-core@1.61.0/lib/coreBundle.js`). That is the old headless build. Since Playwright 1.49, the real browser in "new headless" mode is only used with `channel: "chrome" | "msedge" | "chromium"` ([Playwright release notes, v1.49](https://playwright.dev/docs/release-notes)). DemoHunter has no config for `headless` or `channel`.

**Detection signals an automated Chromium exposes:**

- `navigator.webdriver === true`, caused by the `--enable-automation` default argument ([microsoft/playwright#19420](https://github.com/microsoft/playwright/issues/19420)).
- The headless-shell build and its user-agent and fingerprint differences (**UNVERIFIED** per app).
- A fresh profile with no history, extensions or fonts beyond the host's.
- Datacenter IPs when run in CI.
- New device and location signals on every sign-in, which is why sign-in-per-pass is worse than session reuse.

Notably, the Playwright 1.61 bundle's own browser-config resolution for its MCP/CLI tooling appends `--disable-blink-features=AutomationControlled` to Chromium launch args by default. The same bundle's persistent-context launcher passes `ignoreDefaultArgs: ["--enable-automation"]` (both observed in `playwright-core@1.61.0/lib/coreBundle.js`). Microsoft's own agent tooling therefore already softens the most obvious automation flag. That is a useful reference point for what counts as ordinary configuration rather than evasion.

**Google specifically.** Google says it may block sign-in from browsers that "Are being controlled through software automation rather than a human" and that are "embedded in a different application" ([support.google.com/accounts/answer/7675428](https://support.google.com/accounts/answer/7675428)). Users of Playwright report the resulting "This browser or app may not be secure" page ([microsoft/playwright#19420](https://github.com/microsoft/playwright/issues/19420)). This applies to a **human** typing credentials into a Playwright-launched window too, because the check is on the browser, not the typist. Reusing a session created in a normal browser avoids the sign-in check, but Google may still challenge or invalidate a session that suddenly appears in an automated browser (**UNVERIFIED**; no primary source found).

**Recording path and detection.** DemoHunter records with Playwright's public `page.screencast.start({ path, size })` API (`packages/generator-playwright/src/record/screencast.ts:37-40`), added in Playwright 1.59 ([class-screencast](https://playwright.dev/docs/api/class-screencast)). In Chromium, Playwright 1.61 implements it with the DevTools protocol command `Page.startScreencast` (observed in `coreBundle.js`). That runs over the same DevTools connection Playwright already uses for automation, and page JavaScript cannot observe it. Screencasting therefore adds **no** page-observable signal beyond automation itself. Native `recordVideo` on the context is the older alternative and would not change the detection picture. The page-observable additions come from DemoHunter's Pass 2 overlays (Part 1.3), not from the recording mechanism.

**What a SaaS-targeting launch would need**, in increasing order of intrusiveness:

1. **Session reuse instead of automated sign-in.** This removes the sign-in page, which is the most aggressively guarded surface, and removes new-device signals per pass.
2. **Real browser build:** `channel: "chrome"` (branded Chrome, new headless) or `channel: "chromium"`. Branded Chrome also carries proprietary codecs, which matters for apps that play media.
3. **Headed mode when needed.** This costs a visible window on the author's machine. Screencast behaviour in headed mode needs validation before being documented (**UNVERIFIED**).
4. **Locale and timezone pinned in context options,** so that "Today" and "Yesterday" labels, date formats and greetings match between passes and between machines.
5. **Not recommended for OSS:** evasion patches (patchright, Camoufox, nodriver) or fingerprint spoofing. See Part 2.3 and Part 3.3.

### 1.5 Terms of service and policy landscape

*Not legal advice. Quotes are verbatim from the cited pages unless marked otherwise.*

Two distinctions drive the analysis:

- **Personal account versus admin-managed account.** A personal Notion workspace or personal Google account is governed by the provider's terms alone. A Google Workspace account, a Slack workspace, or a Notion Team or Enterprise workspace is also governed by the customer organization, which can impose additional rules, disable integrations, and enforce SSO, 2FA and session policies.
- **User-driven local automation versus a productized feature.** A user who runs DemoHunter on their own machine, against their own session, a handful of times, at human pace, is in a different position from a product that signs users into third-party services, holds their sessions, or runs the automation on its servers.

#### Google (Gmail, Google Account, Workspace)

- **Automated access.** The terms prohibit "using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages (for example, robots.txt files that disallow crawling, training, or other activities)". They also prohibit "spamming, hacking, or bypassing our systems" ([policies.google.com/terms](https://policies.google.com/terms), fetched version effective 30 July 2026, Finland locale; other locales assumed identical, **UNVERIFIED**). The automated-means clause is scoped to crawling against machine-readable instructions, not to a user scripting their own inbox. "Bypassing our systems" is the live risk: anything that defeats the automated-browser sign-in block reads as bypassing.
- **Sign-in.** Google may block sign-in from automated browsers, as quoted in Part 1.4 ([answer/7675428](https://support.google.com/accounts/answer/7675428)). This is a **technical** block that applies whether or not the terms are read permissively.
- **Password-only access is over.** The Workspace admin article on less secure apps now redirects to "Transition from less secure apps to OAuth" ([knowledge.workspace.google.com](https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth); body and dates not fetched, **UNVERIFIED**). "Give DemoHunter your Google password" is neither supported by Google nor acceptable under DemoHunter's credential boundary. OAuth covers API access (the Gmail API), not driving the web UI.
- **Workspace accounts.** The terms say an organization's administrator "might require you to follow additional rules and may be able to access or disable your Google Account" ([policies.google.com/terms](https://policies.google.com/terms)). Admin session and context-aware-access controls could flag or block an automated browser (**UNVERIFIED**; admin docs not fetched).
- **Credentials.** The terms ask users to take "reasonable steps to keep your Google Account secure" (same URL). A storage-state file for a Google account is a bearer credential for that account, so keeping it off shared disks and out of git is part of that duty.

#### Slack

- **Structure.** "Slack is not available for consumer purposes, as Slack is intended for use by businesses and organizations" ([slack.com/acceptable-use-policy](https://slack.com/acceptable-use-policy), which now points to the [Salesforce Acceptable Use and External-Facing Services Policy](https://www.salesforce.com/en-us/wp-content/uploads/sites/4/documents/legal/Agreements/policies/ExternalFacing_Services_Policy.pdf), last updated 8 July 2025). There is effectively no personal Slack account. The workspace owner (the "Customer") sets the rules.
- **Customer control.** "Customer may provision or deprovision access to the Services, enable or disable third party integrations, manage permissions, retention and export settings". "All Authorized Users must comply with our Acceptable Use Policy and any applicable policies established by Customer" ([slack.com/terms-of-service/user](https://slack.com/terms-of-service/user), effective 17 February 2023).
- **Automated access.** The Salesforce policy text reviewed has **no clause against a user driving the Slack web client with browser automation**. Its scraping clause concerns using the services to scrape *third-party* web properties. Relevant limits are not to "interfere with the availability of the service for other users" and not to "perform significant load or security testing without first obtaining Salesforce's written consent" (same PDF). Slack's Customer Terms and API Terms were not reviewed; a "published interfaces only" clause there is possible (**UNVERIFIED**).
- **Practical reading.** Automating your own client in a workspace you own is clean. Doing it in an employer's workspace needs the owner's consent, and posting into real channels involves real colleagues.

#### Notion

- **Automated access.** Notion's Personal Use Terms of Service ([notion.so/Personal-Use-Terms-of-Service-…](https://www.notion.so/Personal-Use-Terms-of-Service-00e4e5d0f2b9411cbee6493f15779500)) prohibit using "any robot, spider, crawlers or other automatic device, process, software or queries that intercepts, 'mines,' scrapes or otherwise accesses the Service to monitor, extract, copy or collect information or data from or through the Service". This quote comes from a search-engine result for that page. The page itself is JavaScript-rendered and redirects to `app.notion.com`, and a direct fetch did not return its text, so treat the exact wording as **UNVERIFIED** until read in a browser. The clause targets monitoring and collecting data. A tour that creates a page in the user's own workspace and records it is not extracting data, but the text is broad enough ("otherwise accesses") that a strict reading covers any automated client.
- **Team and Enterprise workspaces** are governed by a separate agreement plus workspace-owner controls (SSO, member management), per Notion's [Enterprise security provisions](https://www.notion.com/help/guides/notion-enterprise-security-provisions) (not fetched, **UNVERIFIED** specifics).
- **Official alternative.** Notion has a public API with integration tokens ([developers.notion.com](https://developers.notion.com/guides/get-started/personal-access-tokens)). It suits **seeding** a demo workspace deterministically, but it cannot replace UI recording.

#### Friendliness ranking for "a user records a demo in their own account, locally"

| Rank | Provider | Why |
| --- | --- | --- |
| 1 | Notion | Anyone can own a free workspace dedicated to demos. No known automated-browser sign-in block. The public API makes seed and cleanup scriptable. The terms' anti-robot clause is broad, but its stated purpose is data collection. |
| 2 | Slack | The verified policy has no own-client automation ban. The constraints are organizational, so a demo workspace owned by the user is clean. Posting creates real messages and notifications. |
| 3 | Gmail | Technical automated-sign-in block. "Bypassing our systems" clause. Password-only access retired. Inbox content is intrinsically personal. The only viable pattern is reusing a session created by a human, with no evasion, on a test account. |

**Productized versus user-managed.** Everything above is tolerable when the user owns the session, the machine and the account. It stops being tolerable if DemoHunter, or a future DemoHunter Cloud, offers "connect your Google account", stores the resulting session, or runs the browser on OAIZ infrastructure. At that point DemoHunter holds bearer credentials for third-party accounts (contradicting `AGENTS.md:14`). Its automation of Google sign-in would be the "bypassing" the terms prohibit. And it would take on per-provider review obligations no local tool has. The boundary this research recommends is the one the TTS keys already follow: **the user holds the material, DemoHunter reads it from a path or environment variable they choose, and nothing is persisted or transmitted by DemoHunter.**

### 1.6 Side effects, privacy and output hygiene

These are not auth problems, but they appear the moment the target is a real account.

- **Every action runs once per pass.** `run` executes in Pass 1 (`collect-timeline.ts:77`) and Pass 2 (`replay-timeline.ts:104`), and again for every responsive variant (`generate.ts:324`). A tour that sends a Slack message posts it `2 × (1 + responsive presets)` times. A tour that creates a Notion page creates that many pages unless `teardown` removes them. `teardown` does run on success and failure in both passes (`collect-timeline.ts:80-87`, `replay-timeline.ts:107-114`). But a crash between create and teardown, or a teardown that fails its own locator, leaves debris that changes the next pass's layout (Part 1.2).
- **Typed text is fixed by the timeline.** `type-text` events include the literal text and the seeded delay list (`generator-types.ts:44-49`), so a tour cannot type a unique-per-pass title (for example with a timestamp) without failing replay. Idempotence has to come from cleanup, not from unique names.
- **Failure debug artifacts contain page content.** On a failed pass, `captureFailure` writes the following under `<outputDir>/<tour>/debug/<timestamp>-<phase>/` (`failure-artifacts.ts:75-79`):
  - `body.txt`, the page's `body` inner text (`:100-105`);
  - a full-page screenshot (`:109-111`);
  - `failure.json` with buffered console messages and failed request URLs (`:46-71`, `:117-133`).

  For Gmail this is inbox text. Failed request URLs from SaaS apps can carry identifiers in query strings (**UNVERIFIED** per app). The directory is inside the `.demohunter/` tree whose portability is a product promise (`AGENTS.md:15`). It is not referenced by the manifest, but it sits next to the output.
- **The video, captions and poster show whatever the account shows:** names, emails, avatars, other workspaces in the switcher, message previews, notification counts. Nothing in the pipeline masks content. `snapshot` is only an event marker (`create-smoke-tour-runtime.ts:199-212`), and the screencast API DemoHunter uses has no masking options ([class-screencast](https://playwright.dev/docs/api/class-screencast)).
- **The manifest records no provenance.** The v1 manifest the generator writes has `tour`, `playback`, `artifacts` and `timeline` only (`packages/generator-playwright/src/output/write-generation-output.ts:105-178`). The v2 schema adds variants but no source or target metadata (`packages/manifest/src/schema.ts:157-165`). Nothing session-related can leak into it today, and Part 3.5 argues it should stay that way.

### 1.7 Part 1 scorecard

| Concern | Status today | Severity for real SaaS |
| --- | --- | --- |
| Session in both passes | Not supported by config; possible from author code via `addCookies` in `setup` | High (blocking for 2FA accounts) |
| First navigation authenticated | Impossible; `goto(baseURL)` precedes all hooks | Low (a second `goto` fixes it) |
| Interactive or 2FA sign-in during generation | Impossible in practice | High (makes session reuse mandatory) |
| Replay vs. live content drift | Tolerated (DOM not compared) | Low |
| Replay vs. layout drift | `click.durationMs` mismatch in the 560–1680 px band | Medium |
| Popups, never-idle networks | Locator or idle timeouts | Medium |
| Automation detection | Headless shell, `--enable-automation`, no channel option | High for Google, unknown for Notion and Slack |
| Side effects repeated per pass | Always | High for Slack and Gmail sending, medium for Notion |
| PII in video and debug output | Unmasked; debug writes body text | High for Gmail |
| Terms | Tolerable for user-managed local use; hostile to productized Google sign-in | High only if productized |

## Part 2 — Landscape and prior art

### 2.1 Agent and computer-use tools

These tools act inside real, signed-in applications. They differ in where the browser runs, how sign-in is handled, and whether anything is recorded.

- **OpenAI Operator / ChatGPT agent.** Runs in an OpenAI-hosted remote browser. For sign-in the user clicks "Take over browser" and types credentials themselves. OpenAI states that during takeover "Operator does not collect or screenshot information entered by the user" ([introducing-operator](https://openai.com/index/introducing-operator/), [ChatGPT agent help](https://help.openai.com/en/articles/11752874-chatgpt-agent)). The newer cloud-browser docs describe a secure sign-in form whose contents the model cannot see and ChatGPT does not store ([cloud browser help](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt)). Output is a live view and screenshots. A session video export is not documented (**UNVERIFIED**). Runs are model-driven and not repeatable.
- **Anthropic Claude computer use (API tool).** The docs recommend "a dedicated virtual machine or container with minimal privileges" and "avoiding giving the model access to sensitive data, such as account login information". They warn that "using computer use within applications that require login increases the risk of bad outcomes as a result of prompt injection" ([computer-use tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)). The reference loop is screenshots, not video. The browser-extension product that acts in a user's own signed-in Chrome was not checked in this pass (**UNVERIFIED**).
- **browser-use.** Offers three sign-in routes ([authentication docs](https://docs.browser-use.com/open-source/customize/browser/authentication)): attach to the user's real Chrome to "reuse your authenticated sessions", load a `storage_state` JSON, or use a `user_data_dir` profile. It records MP4 through `record_video_dir` and GIFs through `generate_gif` ([all parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters)). Users report that recording breaks when attached over CDP to an existing browser ([browser-use#2447](https://github.com/browser-use/browser-use/issues/2447)). That is a warning for any "attach to my real Chrome and record" design. Runs are LLM-driven.
- **Playwright MCP.** Its default is a persistent profile that keeps logins between sessions. `--isolated` gives an in-memory profile, and `--storage-state` seeds that isolated profile. `--user-data-dir` picks a profile, and `--extension` attaches to the user's running Chrome or Edge ([microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)). It exposes start and stop video tools. The same Playwright 1.61 bundle appends `--disable-blink-features=AutomationControlled` for Chromium in this tooling's config path (Part 1.4). The model drives the actions; nothing turns them into a re-runnable narrated artifact.
- **Browserbase + Stagehand.** Cloud browsers. "Contexts" persist cookies, tokens, localStorage and IndexedDB across sessions, including after a one-time manual MFA sign-in ([contexts](https://docs.browserbase.com/features/contexts), [manual MFA template](https://www.browserbase.com/templates/manual-mfa-with-contexts)). Every session is recorded by default and kept for 31 days ([session replay](https://www.browserbase.com/blog/session-replay)), but the recording is a debugging replay with no narration or timing control. The user's SaaS session lives on a third party's infrastructure. That is exactly the custody model DemoHunter's OSS boundary rules out.

**Common pattern.** Every one of these tools keeps credentials away from the model and hands sign-in to a human: takeover, a secure form, a manually created context or profile, or attaching to a browser the human already signed into. None asks the automation to type a password into Google. DemoHunter should adopt the same division of labour. It is simpler for DemoHunter because no language model sits in the action loop, which removes the prompt-injection risk Anthropic and OpenAI warn about. Session-file hygiene still applies.

### 2.2 Demo-recording tools

- **Arcade** records in the user's own browser through a Chrome extension, capturing page HTML at each step. A desktop app records the screen ([Arcade record docs](https://docs.arcade.software/kb/build/interactive-demo/record)).
- **Supademo** uses a Chrome extension with HTML-clone, screenshot and video modes ([Supademo extension docs](https://docs.supademo.com/create/by-method/create-with-chrome-extension)).
- **Storylane** uses a Chrome extension that records screenshots or HTML/CSS captures of clicks and typing ([Storylane recording docs](https://docs.storylane.io/recording-demos/recording-html-demos)).
- **Loom and Tella** are screen and camera recorders driven by a human (**UNVERIFIED** in this pass; not fetched, but this is their core product).

Login is never these tools' problem: they ride on a human who is already signed in to their everyday browser. Every take is manual. When the SaaS UI changes, the human records again. HTML-capture products produce a clone, not a video of the live app.

### 2.3 Authentication patterns in browser automation

| Pattern | How it works | Fit for DemoHunter |
| --- | --- | --- |
| **Storage-state file** | `context.storageState({ path })` saves cookies and localStorage, plus IndexedDB with `indexedDB: true` (added in Playwright 1.51, [release notes](https://playwright.dev/docs/release-notes)). `browser.newContext({ storageState })` loads it. The `@playwright/test` "setup project" writes it once in `auth.setup.ts` and dependent projects load it ([playwright.dev/docs/auth](https://playwright.dev/docs/auth)). | **Best fit.** A fresh context per pass is preserved, and both passes load identical client state. The file is user-owned. Playwright warns: "The browser state file may contain sensitive cookies and headers that could be used to impersonate you or your test account. We strongly discourage checking them into private or public repositories." (same page). |
| **sessionStorage** | Not covered: "Playwright does not provide API to persist session storage". The docs give an `evaluate` + `addInitScript` workaround (same page). | Rarely needed for auth (**UNVERIFIED** for the three apps). Leave to author code. |
| **Headed capture with Playwright's CLI** | `npx playwright open --save-storage=<file> <url>` opens a browser, and the storage state is saved "at the end, for later use with --load-storage". A `--channel` option picks a branded build (both options present in `playwright-core@1.61.0/lib/coreBundle.js`). | **Works today** for creating the file, with no DemoHunter code. Google may refuse sign-in in this window (Part 1.4). |
| **Persistent context** | `launchPersistentContext(userDataDir)` uses a full on-disk profile (cookies, IndexedDB, service workers, history). Chrome 136 and later ignore `--remote-debugging-port/pipe` on the **default** Chrome data directory; a non-default `--user-data-dir` is required ([Chrome for Developers](https://developer.chrome.com/blog/remote-debugging-port)). | Poor default. It cannot reuse the user's everyday profile, and one profile shared by both passes means Pass 1 mutations leak into Pass 2 (Part 3.2). |
| **Attach to the user's running browser** | CDP endpoint or an extension (Playwright MCP `--extension`, browser-use CDP mode). | Reject. It conflicts with the Chrome 136 hardening above, recording over CDP is reported fragile ([browser-use#2447](https://github.com/browser-use/browser-use/issues/2447)), and it removes the clean-context guarantee. |
| **Environment-injected tokens** | The author reads a cookie value or token from `process.env` and calls `context.addCookies` in `setup`. | Works today from author code. Same boundary as TTS keys. Fragile against cookie attributes and multi-cookie sessions. |
| **OAuth / API tokens** | Official APIs (Notion integrations, the Slack Web API, the Gmail API via OAuth). | Right tool for **seeding and cleanup**, not for recording UI. Author code, not DemoHunter core. |
| **Human-in-the-loop handoff** | Operator takeover, Browserbase manual-MFA contexts. | The `session capture` helper in Part 3.1 is the local equivalent. |

**Anti-detection projects.** Their licences and maintenance status explain why the OSS core should not depend on them:

| Project | Licence | Engine | Risk for DemoHunter |
| --- | --- | --- | --- |
| [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) | Apache-2.0 | Chromium only; drop-in `playwright` replacement | Medium. It "passes most, but not all the Playwright tests", and fixes after upstream changes "may take several days". It would gate DemoHunter's `>=1.61` + `page.screencast` dependency on a third party's patch cadence. It also positions DemoHunter as an evasion tool. |
| [Camoufox](https://github.com/daijro/camoufox) | MPL-2.0 (browser), MIT (launchers) | Firefox fork with fingerprint spoofing | High. Its README says it "may not be suitable for stable production use". Whether `page.screencast` works on it is unknown (**UNVERIFIED**). |
| nodriver | AGPL-3.0 (**UNVERIFIED**) | Python, CDP-direct Chrome | High. Wrong runtime, and the likely licence conflicts with shipping in the MIT DemoHunter packages. |

A useful precedent: [Skyvern](https://github.com/Skyvern-AI/skyvern), an AGPL-3.0 open-source browser-agent project, keeps "anti-bot measures available in our managed cloud offering" out of its open-source code. Its cloud comes "bundled with anti-bot detection mechanisms, proxy network, and CAPTCHA solvers". Even an automation vendor keeps evasion out of its OSS core.

### 2.4 RPA precedent

- **UiPath** and **Power Automate Desktop** drive the user's **real** browser through a vendor extension. They run attended on the user's own machine, or unattended on a dedicated VM with stored machine credentials. Credentials live in a vault: Orchestrator credential assets or an external store for UiPath, Azure Key Vault or sensitive variables for Power Automate (**UNVERIFIED**; from vendor documentation knowledge, not fetched in this pass). Their answer to sign-in is "run where a human already signed in, or give the robot a machine identity". Neither translates to an OSS CLI that must not hold credentials.
- **Skyvern** integrates password managers (Bitwarden, 1Password, LastPass) and handles QR/TOTP, email and SMS 2FA ([Skyvern README](https://github.com/Skyvern-AI/skyvern)). That is credential custody, which DemoHunter's boundary explicitly excludes (`AGENTS.md:14`).

### 2.5 Comparison and the gap

| Tool | Where the browser runs | Sign-in | Records video | Scripted and re-runnable | Narrated |
| --- | --- | --- | --- | --- | --- |
| Operator / ChatGPT agent | OpenAI cloud | Human takeover or secure form | Live view, screenshots | No | No |
| Claude computer use | User's VM | Discouraged; human | Not documented | No | No |
| browser-use | Local or user's Chrome | Real profile, `storage_state`, `user_data_dir` | Yes (MP4, GIF) | No (LLM) | No |
| Playwright MCP | Local | Persistent profile, storage state, extension | Video tools | Partly (Playwright underneath, LLM on top) | No |
| Browserbase + Stagehand | Vendor cloud | Contexts, manual MFA once | Yes, debugging replay | Partly | No |
| Arcade / Supademo / Storylane | User's browser | Human already signed in | HTML, screenshots, some video | No (manual take) | Some add AI voiceover (**UNVERIFIED**) |
| Loom / Tella | User's desktop | Human already signed in | Yes | No | Human voice |
| UiPath / Power Automate | User machine or VM | Vault or machine identity | Not a product goal | Yes | No |
| **DemoHunter + session file** | **User's machine** | **Human signs in once; DemoHunter loads the file** | **Yes** | **Yes (code, deterministic replay)** | **Yes (cached TTS)** |

**The gap, stated precisely.** No surveyed tool produces a **scripted, deterministic, re-runnable, narrated video, from code in the user's repository, of a real signed-in third-party SaaS app, entirely on the user's machine, without the tool ever holding the user's password.** Agent tools lack determinism and narration. Demo tools lack code and re-runnability. RPA lacks narration and is built on credential custody. DemoHunter already has everything except the session file and the live-account guardrails. That is why the proposal in Part 3 is small.

"Computer use, almost, but through tour files" is the right description with one sharpening. The **authoring** can be agent-assisted: DemoHunter already ships an agent skill (`packages/cli/skills/demohunter/SKILL.md`), and an agent with Playwright MCP can explore Notion and draft the tour. The **recording** stays deterministic Playwright code. Keeping model-driven actions out of the recording pass is what makes the output reviewable, cacheable and re-generatable. It also avoids the prompt-injection exposure the computer-use vendors warn about.
