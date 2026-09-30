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

## Part 3 — Design proposal

### Standing constraints (from the owner; not relitigated)

- OSS stays local-first with no hosted dependency.
- DemoHunter never stores credentials. Session material is user-provided and user-managed, following the TTS key boundary (`AGENTS.md:14`).
- No built-in auth abstraction that captures or manages passwords.
- `.demohunter/` stays portable (`AGENTS.md:15`).
- The two-pass deterministic replay remains the engine and is leveraged, not bypassed.

These constraints, together with the v1 requirement that "auth, session, and app bootstrap logic" stay in normal Playwright code (`.planning/milestones/v1.0-REQUIREMENTS.md:39`), set the design goal. **DemoHunter should load a session the user already has. It should not sign in.** Loading a Playwright storage-state file is a browser-context option, not an auth abstraction. It is the same primitive `@playwright/test` exposes as `use: { storageState }` ([playwright.dev/docs/auth](https://playwright.dev/docs/auth)). The proposal below needs one small documentation adjustment. `docs/phase_1_oss_core.md:13` and `:200` should say that DemoHunter *accepts* a Playwright storage-state path but does not *create or manage* sessions. The spirit of "no auth abstraction" is unchanged.

### 3.1 Mechanism 1 — session file as config and context plumbing (core; recommended)

**Shape.**

```ts
// packages/sdk/src/config.ts (sketch)
export type SessionConfig = {
  /**
   * Path to a Playwright storage-state JSON file that the user created and owns
   * (for example with `npx playwright open --save-storage=<file> <url>`).
   * Relative paths resolve from the project root. DemoHunter only reads it.
   */
  storageState: string;
};

export type DemoHunterUserConfig = {
  // ...existing fields
  session?: SessionConfig;
};

export type ResolvedSessionConfig = {
  /** Absolute path. Never written to output, manifest, captions, or debug artifacts. */
  storageState: string;
  source: "config" | "env";
};

export type ResolvedDemoHunterConfig = {
  // ...existing fields
  session?: ResolvedSessionConfig;
};
```

```ts
// demohunter.config.ts (user)
export default {
  baseURL: "https://www.notion.so",
  session: { storageState: "../.demohunter-sessions/notion-demo.json" },
};
```

**Environment override.** Set `DEMOHUNTER_STORAGE_STATE=/abs/path.json`. When present, it wins over `session.storageState`, and it enables a session without any config change. That serves CI, where a secret is materialized to a temporary file, and keeps the path out of the committed config when the user prefers. It is a path, not file contents, so the environment never carries the credential itself. This mirrors the TTS boundary: DemoHunter reads user-provided material from a location the user controls.

**Why `session` and not `auth`.** DemoHunter does not authenticate. The name should say what the feature does: it starts both passes with a user-supplied browser session. `auth: { kind: "storageState" }` implies a family of auth kinds (password, OAuth, TOTP) that the constraints rule out. If another session source is ever justified, such as a profile directory (Part 3.2), it can become a sibling field under `session`.

**Plumbing.**

| Point | Change |
| --- | --- |
| `generate.ts:135-138` (Pass 1 context) | `browser.newContext({ baseURL, viewport, ...(config.session ? { storageState: config.session.storageState } : {}) })` |
| `generate.ts:174-177` (Pass 2 context) | Same options, loaded from the **same file**, not from Pass 1's end state |
| `smoke-generate.ts:91` | Same, so the smoke path and full generation agree |
| Responsive variants (`generate.ts:324-336`) | No change needed. The variant call spreads `config`, so `session` propagates |
| `collect-timeline.ts:67`, `replay-timeline.ts:94` | No change. The first `goto(baseURL)` is now authenticated because the context already carries cookies |

**Both passes load the same file.** Both passes then start from byte-identical client state, which is what the strict matcher assumes (Part 1.2). Carrying Pass 1's end state forward would import whatever the app wrote during Pass 1, such as a last-visited page or dismissed tips, and make Pass 2 differ from Pass 1.

**Known caveat: refresh-token rotation.** If a provider rotates a session cookie on use and revokes the previous value, Pass 2 loading the original file would be signed out. Whether Notion, Slack or Google do this for web sessions is **UNVERIFIED**. The design handles it only if it is observed: add `session.passTwo: "same-file" | "carry-forward"`. `carry-forward` would call `passOneContext.storageState()` in memory before `generate.ts:171` and pass the object to Pass 2, never writing it to disk. It stays out of the first slice.

**Validation in `load-config.ts`** (next to `validateAuthoredRecordConfig`, `packages/cli/src/config/load-config.ts:36-37`):

- `session` must be an object with a non-empty string `storageState`.
- The path resolves against `projectRoot`, like `outputDir` and `cacheDir` (`load-config.ts:41-42`).
- **Reject** a path inside `outputDir` or `cacheDir`. Session files must never be inside the portable tree.
- Existence and parse checks run at `generate` time, not at config load, because `cache` commands also load config and do not need the file.

**Guardrails in the CLI** (all read-only with respect to the session file):

- **`demohunter doctor`** gains a `session` check alongside the existing checks (`packages/cli/src/commands/doctor.ts:137-158`):
  - the file exists and parses as `{ cookies: [], origins: [] }`;
  - it is not inside `outputDir` or `cacheDir`;
  - when inside a git work tree, it is ignored (via `git check-ignore`; warn if not);
  - cookies whose domain matches the `baseURL` host are present, and not all expired. It reports the earliest non-session expiry as a date, never the cookie names or values.
- **`demohunter generate`** prints one notice before Pass 1 when a session is active: which source (`config` or `env`), and how many passes will run against the live account (`2 × (1 + responsive presets)`). The count makes the side-effect multiplication visible (Part 1.6).
- **Error hints** in `improveGenerateError` (`packages/cli/src/commands/generate.ts:211`). When a session is active and a pass fails during `setup` or `beforeRecord`, add: "If the page shown in debug output is a sign-in page, the session file has expired or was revoked. Recreate it and retry." The debug capture already records the failing URL and title (`failure-artifacts.ts:88-99`).
- **Debug capture under a session.** When `config.session` is set, `attachDebugCapture` (`generate.ts:153-156`, `:214-217`) should:
  - skip `body.txt`;
  - strip query strings and fragments from failed-request URLs and from the page URL in `failure.json`;
  - keep the screenshot, because it is the most useful single artifact and stays on the user's disk.

  The docs should say plainly that the screenshot shows account content.

**Auth-file lifecycle and UX.**

| Stage | How | DemoHunter's role |
| --- | --- | --- |
| Create | The user signs in once, by hand, in a headed browser: `npx playwright open --save-storage=<file> <sign-in URL>` works today (Part 2.3), or `demohunter session capture` later (Part 3.1a). 2FA, emailed codes and SSO all happen in that window, done by the human. | None in slice 1. It documents the command and recommends a location outside the repo (for example a sibling `.demohunter-sessions/` or a user config directory), with owner-only permissions. |
| Use | `session.storageState` or `DEMOHUNTER_STORAGE_STATE`. Loaded into every pass's fresh context. | Read-only load |
| Check | `demohunter doctor` | Reports existence, ignore status and expiry window |
| Refresh | Re-run the create step. DemoHunter never writes back to the file in slice 1. | Hint on failure |
| Expire | The first pass fails in `setup` or `beforeRecord`, before any TTS spend (Part 1.1). | Actionable hint |
| Revoke | The user signs the session out from the provider's "active sessions" or "log out of all devices" settings, then deletes the file. | Documented, including that deleting the file alone does **not** revoke the server-side session |

**Mechanism 1a — `demohunter session capture` (follow-on; recommended).** A thin wrapper so users don't need to know Playwright's CLI:

```sh
demohunter session capture --url https://www.notion.so/login --out ../.demohunter-sessions/notion-demo.json
```

It launches a **headed** browser, using `launch.channel` from Part 3.3 when configured, and navigates to `--url`. It waits until the user presses Enter in the terminal, then writes `context.storageState({ path, indexedDB: true })` with mode `0600`. It refuses `--out` paths inside `outputDir`, `cacheDir`, or a non-ignored location in the repo. DemoHunter never sees the password: it is typed into the browser, just as with `playwright open`. This is a device-flow-style handoff, the local equivalent of Operator's takeover or Browserbase's manual-MFA contexts (Part 2.1). It is still not "log in for you".

**Alternative considered: an `authBeforeRecord`-style lifecycle hook.** Rejected. The only thing such a hook could add over existing `setup` and `beforeRecord` is running before context creation. That is exactly what a context option already provides, and a hook invites credential-typing code into tours. `beforeRecord` stays the place to *verify* signed-in state, for example by waiting for a signed-in-only control, not to create it.

### 3.2 Mechanism 2 — persistent context or profile directory (evaluated; not recommended now)

`launchPersistentContext(userDataDir)` returns a context bound to an on-disk profile.

**Against:**

- **It breaks the clean-context-per-pass property.** One profile shared by both passes means Pass 1's client-side mutations (local storage, IndexedDB, service-worker caches, dismissed tips) are present in Pass 2. Pass 2 then differs from Pass 1, which is the opposite of what replay needs.
- **Structure.** The generator's lifecycle would change from one `launch()` plus two `newContext()` calls to two persistent launches. Responsive variants would multiply profile launches. A profile cannot be opened twice concurrently.
- **The user's everyday profile is off-limits anyway.** Chrome 136 and later refuse remote debugging on the default data directory ([Chrome for Developers](https://developer.chrome.com/blog/remote-debugging-port)). The user would still create a DemoHunter-specific profile, which gives no convenience gain over a storage-state file.
- **Credential-at-rest footprint.** A profile directory holds far more than a session: history, other sites' cookies, cached pages.

**For:**

- Service workers, cache storage and other profile state that storage-state omits.
- Possibly a more natural fingerprint for Google (**UNVERIFIED**).

**Refinement if it is ever needed:** `session.profileDir`, copied into a temporary directory for **each** pass and discarded afterwards. That keeps both passes identical and never mutates the user's profile. Whether a copied Chromium profile keeps its cookies readable across OS keychain encryption is **UNVERIFIED** and must be tested per platform before this is proposed. Revisit only if storage-state demonstrably fails for a target app.

### 3.3 Mechanism 3 — launch posture and anti-detection (document; small config slice; no evasion)

**Configuration to add (follow-on slice).** These are ordinary Playwright launch and context options, not evasion:

```ts
export type LaunchConfig = {
  /** Chromium distribution: "chrome" | "msedge" | "chromium" (new headless). Chromium only. */
  channel?: "chrome" | "msedge" | "chromium";
  /** Default true, as today. false opens a visible window. */
  headless?: boolean;
};

export type DemoHunterUserConfig = {
  // ...
  launch?: LaunchConfig;
  /** Pinned per context so date labels and formats match across passes and machines. */
  locale?: string;
  timezoneId?: string;
};
```

- `launch` is applied at `generate.ts:113`, `smoke-generate.ts:84` and `doctor.ts:138`. `locale` and `timezoneId` go into both `newContext` calls. Validation: `channel` only with `browser: "chromium"`. `locale` and `timezoneId` are strings, and Playwright validates their values.
- `headless: false` must be validated with `page.screencast` before it is documented (**UNVERIFIED**). The viewport-sized screencast (`screencast.ts:37-40`) should be unaffected by window chrome, but that needs proof.

**What DemoHunter should not do:**

- No arbitrary `launch.args` passthrough in the first slice. That is the path to `--disable-blink-features=AutomationControlled` and similar flags; see Q2.
- No stealth dependencies (patchright, Camoufox, nodriver; Part 2.3).
- No `navigator.webdriver` shadowing in the recording-effects init script.
- No automated Google sign-in, ever.

**Risk register for detection:**

| Target | Expected behaviour with session reuse | Residual risk | Mitigation |
| --- | --- | --- | --- |
| Notion | No known automated-browser block (**UNVERIFIED**) | "New device" notices; the broad anti-robot clause (Part 1.5) | Dedicated demo workspace, low volume |
| Slack | No known block (**UNVERIFIED**) | Workspace admin session policies, SSO re-auth | Workspace owned by the user; re-capture on expiry |
| Gmail | Sign-in itself blocked in automated browsers ([answer/7675428](https://support.google.com/accounts/answer/7675428)); reused sessions *may* be challenged (**UNVERIFIED**) | Account lock or challenge; "bypassing our systems" | Test account only; session created in a headed Playwright window where Google permits it, otherwise mark unsupported; never evasion |

**Recording mechanism.** No change. `page.screencast` is protocol-side, not page-observable (Part 1.4). Moving to context `recordVideo` would neither reduce nor increase detection. The only page-observable DemoHunter artifact is the Pass 2 recording-effects runtime (`install-recording-effects.ts:17`), and it is needed for the cursor and highlights.

### 3.4 Mechanism 4 — authoring affordances for live SaaS

**4a. Replay strictness.** A generic `record.replayStrictness: "strict" | "tolerant"` is **rejected**. Replay does more than police determinism. The collected entry index is how Pass 2 finds each narration's audio duration and places it on the video timeline (`generate.ts:237-248`, `replay-timeline.ts:187-189`, `:205-224`). "Tolerating" an extra or missing event would misalign narration with action, and that is worse than failing.

What **is** worth doing is narrow: **treat `click.durationMs` as advisory** during matching. Compare click events with `durationMs` excluded and animate with Pass 2's own measured duration. This is safe because:

- nothing else consumes the collected click duration;
- narration timestamps come from Pass 2's clock (`generate.ts:243-248`);
- `narrateWhile` waits based on Pass 2's real elapsed time (`replay-timeline.ts:289-292`).

It removes the one layout-sensitive mismatch (Part 1.2) and helps local apps too: a font loading late shifts a button by a few pixels. It should ship as a separate slice with tests covering durations inside and outside the 560–1680 px band, and should become default behaviour, not a flag, once proven.

**4b. Popups and first-visit UI.** No new mechanism. Document the patterns:

- dismiss tips in `setup` with plain Playwright;
- create the session file *after* dismissing onboarding once, so the dismissal persists in local storage or on the server;
- enable `record.cookieBanners` when the landing page shows consent banners (`authoring.md:79`).

Add a SaaS section to the skill reference recommending `waitForStable({ state: "domcontentloaded" })` plus a locator wait instead of the `networkidle` default (Part 1.2).

**4c. Side-effect safety.** DemoHunter cannot know which request "sends" a message, so a generic dry-run mode is **rejected**. The guardrails are the pass-count notice (Part 3.1), a teardown that stays off camera (4d), and documented per-app recipes:

| App | Visible action | Safe default |
| --- | --- | --- |
| Notion | Create a page | Create under one dedicated parent page in a demo workspace. `setup` deletes any leftover pages with the tour's title (off camera, both passes). `teardown` moves the created page to trash. Seeding and cleanup may use Notion's public API from author code. |
| Slack | Send a message | Post only to a private sandbox channel in a user-owned demo workspace. Prefer to demo composing, and stop before sending, unless sending is the point. Delete the sent message in `teardown` if workspace settings allow members to delete their own messages (**UNVERIFIED** default). Never post in a shared workspace. |
| Gmail | Compose an email | Do not send. Compose, show, then discard the draft in `teardown`. If sending is essential, send to a second test account the user owns. |

Advanced authors can block a send endpoint with `page.route(...)` in `setup`, but how each app's UI reacts to a failed send is unpredictable. The docs should mention it without recommending it.

**4d. Keep `teardown` off camera (small generator change; recommended).** Today `teardown` runs while the screencast is still running (Part 1.3). Add an `onAfterRun` callback to `replayTimeline` that fires after `run` resolves and before `teardown`. `generate.ts` then stops the screencast there instead of after `replayTimeline` returns (`generate.ts:276-280`). This is a general improvement — cleanup should never be recorded — and it matters specifically for live-account cleanup. Pass 1 is unaffected.

**4e. Redaction and masking.** Deferred. A `record.mask: string[]` (selectors blurred by the Pass 2 init script) is technically simple, but has real limits:

- it only masks what the author thought to list;
- masked content can leak through transitions, autocomplete popups and the tab title;
- it would give a false sense of safety for Gmail.

The primary control is **demo data in a demo account**, documented prominently. Narration and captions contain only author-written text (`generator-types.ts:39-43`), never page text, so the transcript side is already safe. Revisit masking after the first real-SaaS users report needs.

### 3.5 Mechanism 5 — manifest and output provenance (evaluated; no change now)

The generator writes manifest v1 (`write-generation-output.ts:105-178`). v2 exists as a schema but is not yet written (`packages/manifest/src/schema.ts:157-165`). Recording "recorded against a live third-party app with a session" would help a future Cloud label or gate content, but it has two problems:

- **Anything identifying is sensitive:** the session path, a hash of the file (a correlatable fingerprint), cookie names, account email, workspace name, and even the `baseURL` host for private preview environments.
- **Cloud ingestion does not need it yet.** Mode 1, hosted output, is the Cloud's first product (`docs/phase_2_cloud_offering.md:67-77`). Mode 3, cloud generation, is explicitly later, and even then targets "reachable preview/staging environments", not third-party SaaS (`docs/phase_2_cloud_offering.md:77-79`).

**Recommendation:** no manifest change in these slices. When v2 becomes the written format, consider at most `capture: { sessionLoaded: boolean }`, and document permanently that paths, hashes, hosts and account identifiers are excluded. Separately, consider moving `debug/` out of the portable per-tour directory when manifest v2 lands, so `.demohunter/<tour>/` holds only manifest-listed artifacts.

### 3.6 Recommended set and touch list

**Recommended:** 3.1 (session plumbing and guardrails), 3.4d (teardown off camera), 3.3 (launch posture config), 3.1a (`session capture`), and 3.4a (advisory click duration). Documentation covers 3.4b, 3.4c and 3.4e.

**Rejected or deferred:**

- generic tolerant replay (3.4a) and a DemoHunter dry-run mode (3.4c) — rejected;
- persistent profile (3.2), masking (3.4e) and manifest provenance (3.5) — deferred;
- stealth tooling, arbitrary launch-args passthrough and automated sign-in — rejected.

| Package / file | Change | Slice |
| --- | --- | --- |
| `packages/sdk/src/config.ts` | `SessionConfig`, `ResolvedSessionConfig`; `session?` on user and resolved config | 1 |
| `packages/sdk/src/index.ts` | Export the new types | 1 |
| `packages/sdk/src/config.test.ts` | Type-level and default tests | 1 |
| `packages/cli/src/config/load-config.ts` (+ test) | Validate `session`; env override `DEMOHUNTER_STORAGE_STATE`; resolve path; reject paths inside `outputDir`/`cacheDir` | 1 |
| `packages/generator-playwright/src/generate.ts` (+ test) | `storageState` in both `newContext` calls; session-aware debug-capture options; pass-count progress event | 1 |
| `packages/generator-playwright/src/smoke-generate.ts` (+ test) | `storageState` in its context | 1 |
| `packages/generator-playwright/src/debug/failure-artifacts.ts` (+ test) | `redact` option: skip `body.txt`, strip URL queries | 1 |
| `packages/cli/src/commands/doctor.ts` (+ test) | `session` check | 1 |
| `packages/cli/src/commands/generate.ts` (+ test) | Session notice; expired-session hint in `improveGenerateError` | 1 |
| `tests/e2e/` | Local fixture server that gates a page behind a cookie; tour passes only with a session file; asserts no session path in any output file | 1 |
| `docs/saas-apps.md` (new), `docs/getting-started.md`, `docs/troubleshooting.md`, `README.md` | SaaS guide: session creation, storage location, per-app recipes, terms summary, Gmail caveat | 1 |
| `docs/phase_1_oss_core.md:13`, `:200` | "Accepts a Playwright storage-state path; does not create or manage sessions" | 1 |
| `packages/cli/skills/demohunter/SKILL.md:21`, `references/authoring.md:60-68` | Agent guidance: use `session` config, never type credentials in tours, idempotent setup and teardown, `domcontentloaded` waits on SaaS | 1 |
| `packages/generator-playwright/src/execute/replay-timeline.ts`, `generate.ts` | `onAfterRun`; stop screencast before `teardown` | 2 |
| `packages/sdk/src/config.ts`, `load-config.ts`, `generate.ts`, `smoke-generate.ts`, `doctor.ts` | `launch.channel`, `launch.headless`, `locale`, `timezoneId` | 3 |
| `packages/cli/src/bin/demohunter.ts:88-114`, new `packages/cli/src/commands/session.ts` | `demohunter session capture` | 4 |
| `packages/generator-playwright/src/execute/replay-timeline.ts` (+ test) | Click `durationMs` excluded from matching | 5 |

### 3.7 Worked example: a Notion page-create tour, end to end

This example assumes slices 1 and 2. The selectors are **illustrative**. Notion's accessible names were not verified against the live UI in this research and must be taken from `npx playwright codegen` in the demo workspace.

**One-time setup, by the user:**

1. Create a free Notion workspace for demos and a parent page "Demo hub". Optionally create an internal integration and share "Demo hub" with it for API cleanup ([developers.notion.com](https://developers.notion.com/guides/get-started/personal-access-tokens)).
2. Create the session by hand:

   ```sh
   npx playwright open --save-storage=../.demohunter-sessions/notion-demo.json https://www.notion.so/login
   # sign in in the window (email code / password / SSO / 2FA), dismiss onboarding, close the window
   chmod 600 ../.demohunter-sessions/notion-demo.json
   ```

3. Configure DemoHunter:

   ```ts
   // demohunter.config.ts
   export default {
     baseURL: "https://www.notion.so",
     session: { storageState: "../.demohunter-sessions/notion-demo.json" },
     viewport: { width: 1440, height: 900 },
     record: { showActions: false },
   };
   ```

4. Run `demohunter doctor`. The `session` check passes: the file exists, is outside the repo, and has cookies for `notion.so` expiring on a future date.

**The tour:**

```ts
// demos/notion-launch-checklist.tour.ts
import { defineTour } from "demohunter";

const HUB_URL = process.env.NOTION_DEMO_HUB_URL ?? "";
const TITLE = "Launch checklist";

export default defineTour({
  id: "notion-launch-checklist",
  title: "Create a launch checklist in Notion",

  async setup({ page }) {
    // Off camera, both passes: remove leftovers from an earlier crashed run so
    // the sidebar looks the same in Pass 1 and Pass 2. User code; may call the
    // Notion public API with the user's own integration token.
    await removeDemoPagesTitled(TITLE);
    await page.goto(HUB_URL, { waitUntil: "domcontentloaded" });
  },

  async beforeRecord({ page }) {
    // Proves the session is valid before any narration or recording.
    await page.getByRole("heading", { name: "Demo hub" }).waitFor({ timeout: 15_000 });
  },

  async run({ page, chapter, step, narrate, narrateWhile, click, waitForStable }) {
    await chapter("Create the page", { id: "create" });

    await step("Add a sub-page", async () => {
      await narrate("Everything for the launch lives under the demo hub.");
      await narrateWhile("Add a new page right here.", async () => {
        await click(page.getByRole("button", { name: "Add a page" })); // illustrative
      });
    });

    await step("Name it", async () => {
      await narrateWhile("Give it a title the whole team will recognise.", async ({ typeText }) => {
        await typeText(page.getByPlaceholder("New page"), TITLE, { pace: "natural", seed: "title" });
      });
      await waitForStable({ state: "domcontentloaded" });
    });

    await chapter("Share it", { id: "share" });
    await step("Open sharing", async () => {
      await narrateWhile("One click opens sharing for the whole workspace.", async () => {
        await click(page.getByRole("button", { name: "Share" }));
      });
    });
  },

  async teardown() {
    // After slice 2 this runs after the screencast has stopped.
    await removeDemoPagesTitled(TITLE);
  },
});

async function removeDemoPagesTitled(title: string): Promise<void> {
  // User-owned helper: archive child pages of the hub whose title matches,
  // via the Notion public API and NOTION_TOKEN from the environment.
}
```

**Generation:**

```text
$ demohunter generate demos/notion-launch-checklist.tour.ts
session: loading user storage state (config) into 2 passes against https://www.notion.so
         live-account actions in this tour will run 2 times
Collecting timeline for notion-launch-checklist
Resolving narration 1 … 5            (cached after the first run; offline reruns need no TTS key)
Recording replay for notion-launch-checklist
Wrote .demohunter/notion-launch-checklist/video.mp4
```

What makes this robust:

- both passes start signed in with identical client state;
- the page is created and removed in each pass, so the sidebar is the same at each click;
- the one click whose position could shift (the "Share" button after the title renders) no longer fails replay after slice 5;
- nothing session-related reaches `.demohunter/`.

When the session expires, Pass 1 fails at the `beforeRecord` heading wait, before any TTS request. The CLI hint says to recreate the session file.

## Part 4 — Verdict and the draft-PR proposal

### 4.1 What works today with zero code changes

**Public, signed-out pages of any SaaS app work now.** The repository's own demo records github.com (`demohunter.config.ts:2`, `demos/demohunter-github.tour.ts`).

**Signed-in apps work today too, through author code.** `setup` runs in both passes before `beforeRecord` and receives the page (`collect-timeline.ts:72`, `replay-timeline.ts:99`, `runtime-types.ts:64-68`). `page.context()` is a full Playwright `BrowserContext`. So a tour can load a storage-state file the user created with `npx playwright open --save-storage=...`:

```ts
import { readFile } from "node:fs/promises";
import { defineTour } from "demohunter";

export default defineTour({
  id: "notion-today",
  title: "Notion, signed in, no DemoHunter changes",
  async setup({ page }) {
    const state = JSON.parse(await readFile(process.env.NOTION_STATE_FILE ?? "", "utf8"));
    await page.context().addCookies(state.cookies);
    // localStorage from state.origins would need page.evaluate per origin; rarely needed for sign-in.
    await page.goto("https://www.notion.so/", { waitUntil: "domcontentloaded" });
  },
  async beforeRecord({ page }) {
    await page.getByRole("heading", { name: "Demo hub" }).waitFor(); // illustrative
  },
  async run(/* ... */) {},
});
```

This complies with the existing guidance: plain Playwright in user code, no invented `login()` (`authoring.md:60`). Its limits are why slice 1 is still worth doing:

- the first `goto(baseURL)` in each pass is unauthenticated, because it happens before `setup` (`collect-timeline.ts:67`);
- localStorage and IndexedDB restore is manual;
- nothing warns about the session file's location or expiry;
- debug capture writes page text;
- every author re-implements the same lines.

**Signing in inside `beforeRecord` with credentials from the environment works only for accounts with no 2FA, no emailed code, no CAPTCHA and no automated-browser block.** It happens `2 × (1 + responsive presets)` times per generation. It is not viable for Google. It is not recommended anywhere, because it puts passwords in the environment of a tool that promises not to handle them.

| Target | Today, zero code | With slices 1–2 | With slices 3–5 | Genuinely hard |
| --- | --- | --- | --- | --- |
| Notion (own demo workspace) | Works via `addCookies` in `setup`; replay can fail on click-distance drift | Clean: config-level session, guardrails, off-camera cleanup | Robust to layout drift; `session capture` UX | Broad anti-robot clause (Part 1.5); UI renames rot selectors |
| Slack (own demo workspace) | Same as Notion | Same as Notion; every send is real, twice or more | Same | Admin SSO/session policies in someone else's workspace; posting to real people |
| Gmail (test account) | Sign-in in a Playwright window likely blocked; session reuse from such a window may be impossible | Works only if a session can be created without tripping the block (**UNVERIFIED**) | `channel: "chrome"` + headed capture improves the odds (**UNVERIFIED**) | Google's explicit automated-sign-in block and "bypassing our systems" clause; inbox PII |
| Workspace or enterprise accounts (any app) | Technically the same | Technically the same | Same | Organizational policy, not DemoHunter, decides; the docs must say so |

**Verdict.** DemoHunter can record narrated demos of real signed-in SaaS apps. For Notion and Slack in workspaces the user owns, the gap to a good experience is small and entirely inside the product boundary: load a user-owned session file into both passes, keep cleanup off camera, tolerate click-distance drift, and document the live-account hazards. Gmail is the honest exception. It is possible only with a test account and a session Google agrees to issue. It must not be pursued with evasion, and it should be documented as best effort. "Log into Google for you" as a product feature, local or hosted, is out of scope under the current constraints and the current Google terms.

### 4.2 Draft PR proposal

**Draft PR A: this research (deliverable of this run).**

- **Worktree / branch:** `/workspace/demohunter-saas-research`, branch `research/saas-app-demos`, cut from `main` @ `2fe22b4`.
- **Title:** `docs: research — narrated demos of real SaaS apps (Notion, Slack, Gmail)`
- **Contains:** only `thoughts/research/saas-app-demo-support.md`. No code, no config, no docs outside `thoughts/`.
- **Why docs-only:** slice 1 amends a documented non-goal ("Must not provide auth/session/bootstrap abstractions", `docs/phase_1_oss_core.md:200`) and depends on the owner's answer to Q1. That decision should be reviewable on its own, without code attached.
- **Body outline:**
  - the decision paragraph;
  - the verdict table from Part 4.1;
  - the slice plan below;
  - Q1 and Q2;
  - a note that no session files, cookies or real-account screenshots were produced or committed.
- **Acceptance:** the owner approves or amends the boundary (Q1), the slice split, and the launch-args position (Q2). The PR then merges as a research record, like `thoughts/research/tts-stitching-tone-consistency.md`.

**Follow-on implementation PRs.** Each gets its own worktree from `main` after PR A is accepted, and each is independently shippable:

| # | Branch | Title | Depends on |
| --- | --- | --- | --- |
| 1 | `feat/session-storage-state` | `feat: load a user-owned Playwright session into both passes` | PR A (Q1) |
| 2 | `feat/record-excludes-teardown` | `feat: stop recording before teardown` | — (independent; helps SaaS cleanup) |
| 3 | `feat/browser-launch-options` | `feat: launch.channel, launch.headless, locale and timezone` | — |
| 4 | `feat/session-capture-command` | `feat: demohunter session capture` | 1, 3 |
| 5 | `feat/advisory-click-duration` | `fix: match click events without layout-derived duration` | — |

Slices 2, 3 and 5 are general improvements that also benefit local apps, so they can land in any order. Slice 1 is the only one that changes the product boundary.

**Interaction with open work.**

- **Slice 1 is not only for third-party SaaS.** The same `session.storageState` serves the more common case of a user's own staging or preview app behind a sign-in wall. Today that case uses the same `beforeRecord` login pattern and has the same double-sign-in problem.
- **PR #23 (DemoHunter Review)** compiles its walkthrough into an in-memory tour and hands it to the existing Playwright pipeline (per the PR description). A context-level session option would reach it without extra plumbing, but PR #23 does not need one: its target is a locally rendered review site.
- **PR #19 (Kokoro TTS and provider registry)** also edits `packages/sdk/src/config.ts` and `load-config.ts`. The changes are additive and independent, but whichever merges second must rebase the config types and validation.
- **PR #20 (video-generation-agent concept)** is where agent-assisted *authoring* of SaaS tours belongs (Part 2.5), not the generator.

**Slice 1 acceptance criteria:**

1. With no `session` and no `DEMOHUNTER_STORAGE_STATE`, generation output is unchanged and all existing tests pass without modification.
2. With a session, both `newContext` calls in `generate.ts`, and the context in `smoke-generate.ts`, receive `storageState` from the same resolved path. Unit tests assert the options on both calls and for a responsive variant.
3. `load-config` rejects non-object `session`, empty paths, and paths inside `outputDir` or `cacheDir`. It resolves relative paths from the project root. The environment variable overrides config.
4. An end-to-end test uses a local fixture server whose page requires a cookie. The tour fails with an actionable session hint without the file and succeeds with it.
5. The same test greps every file under the tour's output directory, including `manifest.json`, captions, chapters and any `debug/` artifacts produced by a forced failure, and asserts that neither the session path nor any cookie value appears.
6. Under a session, failure debug capture writes no `body.txt` and strips URL queries.
7. `demohunter doctor` reports existence, parse, ignore status and cookie expiry for the configured file, without printing cookie names or values.
8. `generate` prints the session source and the live pass count before Pass 1.
9. Documentation ships with it: `docs/saas-apps.md` (session creation, storage location, per-app recipes, the terms summary from Part 1.5 with links, the Gmail caveat), the updated `phase_1_oss_core.md` wording, and updated skill guidance (`SKILL.md:21`, `references/authoring.md:60-68`).
10. Manual validation by a maintainer: the Notion worked example (Part 3.7) generates successfully three times in a row against a demo workspace. The PR records the outcome in text only; no session files or real-account media are committed.

### 4.3 Validation plan for the UNVERIFIED items

Before slice 1 leaves draft, a maintainer should run a small manual matrix and record results in the PR body. This settles the claims this document could not verify from sources:

| Question | Method |
| --- | --- |
| Does a storage-state session load and stay valid for Notion, Slack and a Gmail test account? | Create via `playwright open --save-storage`, then generate twice, a day apart |
| Does any provider rotate cookies so that Pass 2 is signed out? | Inspect Pass 2 failures; diff cookie values before and after Pass 1 in memory only |
| Does Google permit sign-in in a Playwright-launched window with `--channel chrome`, headed? | One manual attempt on a test account; stop at the first block, and do not retry with evasion |
| Do replays drift on `click.durationMs` in practice? | Five consecutive generations of the Notion example, counting `ReplayTimelineError` reasons |
| Does `page.screencast` behave identically in headed mode? | Compare frame size and duration for the same tour, headed and headless |
| Exact Notion terms wording | Read `app.notion.com` Personal Use Terms in a browser and replace the search-snippet quote in Part 1.5 |

### 4.4 Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Account challenge, lock or suspension (especially Google) | Medium for Gmail; low for Notion and Slack (**UNVERIFIED**) | High for the user | Test and demo accounts only; no evasion; docs say so first |
| Session file committed or leaked (git, CI logs, shared drives) | Medium | High (bearer credential) | Refuse paths inside the output tree; `git check-ignore` warning; path-only environment variable; docs and `0600` guidance; never printed |
| Real side effects multiplied per pass (duplicate messages, pages, emails) | High without guidance | Medium to high (real colleagues) | Pass-count notice; recipes; off-camera teardown; demo workspaces |
| Personal data in video, poster or debug output | High on real accounts | High | Demo-data guidance; debug redaction under a session; no page text in narration |
| Selector rot as vendors change UI | High over time | Medium (regeneration fails) | Role and label selectors; `doctor`-style dry run of the tour's `beforeRecord` could follow |
| Refresh-token rotation signs Pass 2 out | Unknown | Medium | Validation matrix; in-memory `carry-forward` option only if observed |
| Boundary creep, from `session capture` to "log in for me" to a hosted session vault | Medium over time | High (terms, security, credential custody) | Q1 fixed in writing; `session capture` never types into the page |
| Support load ("Gmail doesn't work") | Medium | Low to medium | Gmail documented as best effort with the reason |
| Terms wording changes | Low to medium | Medium | The docs link to the primary pages rather than paraphrasing them as permission |

### 4.5 Open questions for the owner

**Q1. Is a user-managed session file the permanent boundary, or is productized sign-in in scope?**
*Context:* The recommendation keeps DemoHunter to loading a session the user created by hand. A productized "connect your Google, Slack or Notion account" flow, local or in Cloud, would mean DemoHunter or OAIZ holding bearer credentials for third-party accounts (against `AGENTS.md:14`). It would also mean automating Google sign-in, which Google blocks and its terms frame as bypassing.
*Options:*
- (a) User-managed session file only, in OSS and Cloud.
- (b) User-managed in OSS; Cloud may later host sessions for specific providers after a separate legal and security review.
- (c) Productize sign-in helpers, including Google.

*Default if unanswered:* (a). Slice 1 proceeds on that basis, and the docs state it.

**Q2. May users pass arbitrary Chromium launch arguments?**
*Context:* A `launch.args` passthrough would let users add `--disable-blink-features=AutomationControlled`. Playwright's own MCP tooling appends that flag for Chromium by default (Part 1.4). It is also the first step from configuration toward evasion, and DemoHunter documentation would be implicated.
*Options:*
- (a) No passthrough; only `channel` and `headless`.
- (b) Passthrough documented as the user's responsibility, with no DemoHunter defaults.
- (c) Apply the MCP-style default.

*Default if unanswered:* (a).

## Bottom line

DemoHunter is closer to "computer use through tour files" than it looks. The two-pass engine does not compare page content, so live SaaS data does not by itself break replay. Playwright already provides a human-in-the-loop way to create a session file, and a tour can load one today in `setup`. What is missing is small and fits the product's boundaries:

- a `session.storageState` option loaded into both fresh contexts, with doctor, CLI and debug-output guardrails;
- stopping the recording before `teardown`;
- launch-channel and locale options;
- a `session capture` convenience command;
- ignoring the layout-derived click duration during replay matching.

The hard parts are not engineering. Every pass performs real actions, real accounts contain real people's data, and Google does not want automated browsers signing in. The answer to all three is to record against demo workspaces and test accounts that the user owns, with sessions the user creates, on the user's machine. Draft PR A carries this research and the boundary decision. Implementation follows in five independent slices, starting with `feat/session-storage-state` once Q1 is answered.
