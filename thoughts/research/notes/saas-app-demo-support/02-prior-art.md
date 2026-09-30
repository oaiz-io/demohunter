# 02 - Prior art: authenticated third-party apps in agent tools and demo tools

Question: when agent/computer-use tools and demo-recording tools work inside real SaaS apps (Notion, Slack, Gmail) that need the user's own login, how do they handle it? Do any of them **record video** while acting with real credentials, and do any produce a **scripted, re-runnable, narrated video from code**?

Research budget: 8 web searches/fetches (2026-09-30). Anything not confirmed from a source fetched or searched in this session is marked **UNVERIFIED**.

## 1. Agent / computer-use tools

### OpenAI Operator / ChatGPT agent (CUA)
- Runs in a **remote (cloud) browser** hosted by OpenAI. For logins the user clicks **"Take over browser"**, types the credentials, then hands control back. According to OpenAI, during takeover "Operator does not collect or screenshot information entered by the user". The agent "will never type your password, store credentials, or invoke a password manager". https://openai.com/index/introducing-operator/ , https://help.openai.com/en/articles/11752874-chatgpt-agent
- Newer "cloud browser" docs describe a secure sign-in form. Credentials go straight to the remote browser, the model can't see them, and ChatGPT doesn't store them. OpenAI suggests clearing remote-browser data after sensitive sessions. https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt
- Recording: the user watches a live view or screenshots. **UNVERIFIED**: I found no documented video export of the session. Behavior on CAPTCHAs and sensitive sites is **UNVERIFIED** in this pass. From memory, the Operator launch post says the agent hands control back to the user for CAPTCHAs and logins, but I did not re-fetch that wording.
- Scripted and re-runnable? No. The agent is driven by a natural-language task and acts non-deterministically.

### Anthropic Claude computer use (API tool)
- The docs recommend "a dedicated virtual machine or container with minimal privileges". They also advise "avoiding giving the model access to sensitive data, such as account login information". https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- If login is needed, the docs say to pass the credentials in the prompt inside tags such as `<robot_credentials>`. They warn that "using computer use within applications that require login increases the risk of bad outcomes as a result of prompt injection". They recommend human confirmation for consequential actions such as accepting cookies, payments and terms of service. Classifiers scan screenshots for prompt injection. (same URL)
- Recording: the docs don't mention video recording. The reference implementation is a screenshot loop. Video capture is **UNVERIFIED / not documented**.
- **Claude for Chrome / Claude in Chrome** is a browser extension that acts inside the user's own logged-in Chrome, reusing existing sessions. **UNVERIFIED** in this pass (no source fetched, budget exhausted). Whether it records video is also **UNVERIFIED**.

### browser-use (github.com/browser-use/browser-use)
- Auth options, all documented at https://docs.browser-use.com/open-source/customize/browser/authentication :
  - Connect to the user's existing Chrome to "reuse your authenticated sessions - no need to handle logins, cookies, or 2FA". Chrome and the profile are auto-detected.
  - `storage_state` JSON for cookies and localStorage. It is loaded on start and saved periodically and on shutdown, so you can export once from an authenticated browser and reuse headless.
  - `user_data_dir` for a full persistent profile.
- Recording: `BrowserProfile(record_video_dir=...)` saves `.mp4`. There are also `record_video_size` and `record_video_framerate` (default 30). `Agent(generate_gif=True|path)` makes a GIF of agent actions. Video needs optional dependencies and is skipped **silently** if they are missing. https://docs.browser-use.com/open-source/customize/browser/all-parameters
- GitHub issues report that video/trace recording breaks in some setups, for example "record_video_dir and traces_dir do not work when using CDP" (#2447) and a regression in #2845. **This means recording while attached to the user's real Chrome over CDP has been unreliable.** https://github.com/browser-use/browser-use/issues/2447 , https://github.com/browser-use/browser-use/issues/2845
- Scripted and re-runnable? The run is driven by an LLM task, so it is not deterministic. Result: a raw screen video or GIF with no narration.

### Playwright MCP (github.com/microsoft/playwright-mcp)
- README flags (https://github.com/microsoft/playwright-mcp):
  - `--user-data-dir` sets the profile path. The default is a **persistent** profile that keeps logins between sessions.
  - `--isolated` keeps the profile in memory only.
  - `--storage-state` gives an initial storage state for isolated sessions.
  - `--extension` connects "to a running browser instance (Edge/Chrome only)" through the "Playwright Extension", i.e. the user's existing logged-in tabs. `--profile-dir-name` picks the profile.
  - `--cdp-endpoint` / `--cdp-header` attach over CDP.
  - `--save-session` saves the MCP session to the output directory.
- Recording: the current README lists `start-video` / `stop-video` **tools**. I could not confirm `--save-video` / `--save-trace` **CLI flags** in the current options table. They may have existed in earlier versions or been renamed (**UNVERIFIED**).
- Scripted and re-runnable? The LLM drives it through MCP. Underneath it is Playwright, so the recorded actions could in principle become code, but the MCP itself doesn't produce a re-runnable narrated video.

### Stagehand / Browserbase
- Browserbase **Contexts** persist cookies, tokens, localStorage and IndexedDB across sessions: log in once (including manual MFA), save the context, and reuse it. https://docs.browserbase.com/features/contexts , https://www.browserbase.com/templates/manual-mfa-with-contexts
- Every Browserbase session **records by default**: frames and tab switches, kept for 31 days, and streamable through the Session Replay API. https://www.browserbase.com/blog/session-replay
- The browser runs in the **cloud** (Browserbase infrastructure), so the user's SaaS session cookies live on a third party. Stagehand is code-first (`act/extract/observe` mixed with Playwright), so it is partly scripted. The replay is a debugging artifact with no narration. There are known storage-state issues in Stagehand v3 (https://github.com/browserbase/stagehand/issues/1250).

## 2. Demo-recording tools

- **Arcade**: a Chrome extension (any Chromium browser, not Safari) running in the **user's own browser**, where they are already logged in. "Record Interactive Demo" saves the page's **HTML at each step**. There is also a desktop app for screen recording. https://docs.arcade.software/kb/build/interactive-demo/record
- **Supademo**: a Chrome extension. A "Guided HTML Demo" makes a front-end clone of the app. Screenshot and video modes also exist. It runs in the user's own logged-in browser. https://docs.supademo.com/create/by-method/create-with-chrome-extension , https://docs.supademo.com/create/by-demo-type/guided-html-demos
- **Storylane**: a Chrome extension that records screenshot or HTML/CSS demos and captures clicks, typing and dragging. https://docs.storylane.io/recording-demos/recording-html-demos
- **Loom / Tella**: screen/camera recorders. A human is logged in and drives the app by hand. The output is video with the person's own voice. **UNVERIFIED** in this pass (not fetched), but this is their well-known core product.
- Common pattern: **login is never these tools' problem.** They piggyback on a human who is already signed in to their normal browser. Each capture is a manual, one-off take. To re-record after a UI change, the human redoes it by hand. HTML-capture tools also produce a snapshot clone, not a video. AI voiceover is marketed by some of these vendors (**UNVERIFIED** for each).

## 3. Comparison

| Tool | Where browser runs | How login is handled | Records video? | Scripted / re-runnable? |
|---|---|---|---|---|
| OpenAI Operator / ChatGPT agent | OpenAI remote cloud browser | User "takes over" and types creds, or uses the secure sign-in form; the model doesn't see them | Live view / screenshots; video export UNVERIFIED | No (NL task, non-deterministic) |
| Claude computer use (API) | Your VM/container (recommended sandbox) | Discouraged; if needed, creds go in the prompt (`<robot_credentials>`) with an injection warning | Not documented (screenshot loop) | No |
| Claude for Chrome | User's own Chrome (extension) | Reuses existing logged-in sessions (UNVERIFIED) | UNVERIFIED | No |
| browser-use | Local Chromium or the user's real Chrome via CDP | Real Chrome profile, `storage_state` JSON, or `user_data_dir` | Yes: `record_video_dir` (.mp4), `generate_gif`; flaky with CDP | No (LLM-driven) |
| Playwright MCP | Local browser; persistent/isolated profile, or the user's browser via `--extension` / CDP | Persistent profile, `--storage-state`, or existing tabs via the extension | `start/stop-video` tools; `--save-video` flag UNVERIFIED | Partly (Playwright underneath, but LLM-driven) |
| Stagehand + Browserbase | Browserbase cloud | Contexts persist cookies/tokens; manual MFA once | Yes, always-on session replay (31 days), debugging-grade | Partly (code + AI actions); no narration |
| Arcade | User's own Chrome (extension) / desktop app | Human already logged in | HTML step capture; desktop app screen video | No (manual take) |
| Supademo | User's own Chrome (extension) | Human already logged in | HTML clone / screenshots / video mode | No (manual take) |
| Storylane | User's own Chrome (extension) | Human already logged in | Screenshot / HTML capture | No (manual take) |
| Loom / Tella | User's desktop / browser | Human already logged in | Yes (screen recording) | No |

## 4. Whitespace

- **None of the surveyed tools** produces a **scripted, deterministic, re-runnable, narrated video from code against a logged-in third-party SaaS**.
  - Agent tools (Operator, Claude computer use, browser-use, Playwright MCP, Stagehand) can act while authenticated, and some record raw video. But they are LLM-driven and non-deterministic, and their recordings are debugging artifacts: no narration, no timing control, no re-take guarantee.
  - Demo tools (Arcade, Supademo, Storylane, Loom, Tella) produce polished demos in the user's logged-in browser, but every take is manual and can't be regenerated from code when the UI changes.
- Auth patterns worth adopting, as seen in the field:
  - **Storage-state files**: Playwright, browser-use, Playwright MCP.
  - **Persistent profile dirs**: browser-use `user_data_dir`, Playwright MCP default.
  - **Attach to the user's running browser**: Playwright MCP `--extension`, browser-use CDP. Browser-use issues show recording over CDP is fragile, which matters for DemoHunter's screencast pass.
  - **Human-in-the-loop login handoff**: Operator takeover, Browserbase manual-MFA contexts.
- Safety norms to carry over: Anthropic and OpenAI both keep credentials away from the model, isolate the browser, and require human confirmation for consequential actions. DemoHunter has no LLM in the action loop, which removes the prompt-injection vector. Credential and session-file hygiene still apply.
