# DemoHunter Tour Authoring

## Authoring Contract

Every tour must default export `defineTour({ ... })` from `demohunter`.

Required fields:

- `id: string`
- `title: string`
- `run(context)`

Optional lifecycle hooks:

- `setup({ page, config, goto })`
- `beforeRecord({ page, config, goto })`
- `teardown({ page, config, goto })`

Lifecycle order:

- `setup` runs before each pass.
- `beforeRecord` runs after `setup` and before the recorded portion of full generation.
- `run` is the first authored hook included in the final screencast.
- `teardown` runs after `run`.

## Run Context

The current SDK exposes these helpers on `run(...)`:

- `page`
- `config`
- `goto(pathOrUrl, options?)`
- `chapter(title, options?)`
- `step(title, fn)`
- `narrate(text, options?)`
- `narrateWhile(text, async ({ sleep, typeText }) => { ... }, options?)`
- `waitForStable(options?)`
- `highlight(locator, options?)`
- `snapshot(options?)`
- `assertVisible(locator, options?)`
- `click(locator, options?)`

Useful option details:

- `chapter(..., { id?: string })`
- `narrate(..., { voice?, model?, format?, instructions?, language?, voiceSettings?, cacheKeyHint? })`
- `narrateWhile(..., { voice?, model?, format?, instructions?, language?, voiceSettings?, cacheKeyHint? })`
- `sleep(ms)` inside `narrateWhile(...)` waits inside the narration window
- `typeText(locator, text, { replace?, pace?, seed?, timeoutMs? })` inside `narrateWhile(...)` types visible text incrementally
- `waitForStable(..., { state?, timeoutMs? })`
- `highlight(..., { name?, paddingPx?, style?, durationMs? })`
- `snapshot(..., { name? })`
- `assertVisible(..., { timeoutMs? })`
- `click(..., { position?, motion?: "smooth" | "instant", timeoutMs? })`

## Editing Rules

- Preserve normal Playwright code. Use `page.goto`, locator actions, and `waitFor` calls directly.
- Relative `page.goto("/path")` resolves against `demohunter.config.ts` `baseURL`. Use `goto("/path")` when you want DemoHunter's explicit baseURL resolver.
- Do not invent repo-wide helpers like `login()`, `bootstrapApp()`, `agentContext()`, or cloud-specific wrappers unless they already exist in user code.
- Keep selectors stable and user-facing when possible: headings, labels, buttons, and explicit test ids beat brittle CSS traversal.
- Keep chapters and step titles tied to visible product states.
- Keep narration concise and specific to what the viewer can observe.
- Use `narrate(...)` when the viewer should absorb a static state.
- Use `narrateWhile(...)` when narration should bridge navigation, clicking, typing, waits, generation, highlights, or other visible motion.
- Use `sleep(ms)` inside `narrateWhile(...)` when a UI action should happen at a specific moment in the voiceover.
- Use `typeText(...)` inside `narrateWhile(...)` when typed text should be visible; keep Playwright `.fill(...)` for setup, beforeRecord, or other non-visible prep.
- Use `beforeRecord` for login, fixture creation, or navigation that should happen before the final video starts.
- Only add `setup` or `teardown` when the flow genuinely needs shared preparation or cleanup.

## Config Awareness

Inspect `demohunter.config.ts` before editing:

- `baseURL` tells you which app entrypoint the tour expects.
- `outputDir` and `cacheDir` affect where generated artifacts land.
- `holdPaddingMs`, `record`, and `tts` can explain timing or narration behavior.
- `record.cursor` controls the smooth SVG cursor (`false` or mode, shape, color, timing, arc, and ripple options). Legacy `record.showCursor` and `record.showClickRipple` remain accepted. `record.highlightStyle` (`"ring"` | `"spotlight"`, default `"ring"`) sets the default `highlight()` style.
- `record.cookieBanners` is disabled by default and can reject, accept, or hide recognized vendor banners before authored `beforeRecord` runs.
- `record.container` selects MP4/WebM; legacy `record.format` remains accepted. `output.formats` requests standard, square, responsive mobile, or GIF distribution variants.
- Set `record.showActions: false` for polished videos when Playwright action labels or locator text would distract from the product UI.
- `tts.provider` is provider-neutral. Built-ins are `openai`, `elevenlabs`, and opt-in local `kokoro`; OpenAI remains the default. ElevenLabs receives `tts.language` as `language_code`; OpenAI receives it through voice instructions.
- ElevenLabs voices are configured by voice ID and optional `voiceSettings`.
- Kokoro requires `providers.tts: [kokoro(...)]` plus `tts: kokoroTTS(...)`. It supports `en-US`, `en-GB`, `es`, `fr`, `hi`, `it`, `ja`, `pt-BR`, and `zh`, and always produces WAV at 24 kHz. A custom command adapter may omit asset paths only when its protocol ready message supplies model/voices SHA-256 identities and a backend version. Do not download its separately owned runtime, model, or voices.

Treat config as an input to the tour. Do not duplicate config values inside the tour unless the repo already does that intentionally.

## Authoring Pattern

1. Inspect the target page and existing selectors.
2. Choose one small user-visible flow.
3. Add a chapter for the flow.
4. Wrap each visible state change in `step(...)`.
5. Call `narrate(...)` after the UI state is ready and should stay static for a beat.
6. Use `narrateWhile(...)` when narration should continue while the UI moves.
7. Add timed `sleep(ms)` calls inside `narrateWhile(...)` to choreograph clicks, typing, highlights, or waits to narration phrases.
8. Add `snapshot(...)` only when a saved visual checkpoint adds value.

## Narration Timing Pattern

Use `narrateWhile(...)` for transitions and visible motion:

```ts
await narrateWhile("Now we open the workflow builder and switch to the right mode.", async ({ sleep }) => {
  await goto("/chat?new=true");
  await sleep(1200);
  await page.getByTestId("agent-menu-button").click();
  await page.getByTestId("mode-option-builder").click();
});
```

Use `typeText(...)` for visible text entry:

```ts
await narrateWhile("Now we enter the customer name and pick the matching account.", async ({ sleep, typeText }) => {
  await page.getByRole("button", { name: "New invoice" }).click();
  await sleep(700);
  await typeText(page.getByLabel("Customer"), "Acme Corporation", {
    replace: true,
    pace: "natural",
  });
});
```

Keep normal DemoHunter helpers inside the wrapped action when they describe visible UI states:

```ts
await narrateWhile("Here is the generated workflow. Notice the schedule and output field.", async ({ sleep }) => {
  await sleep(700);
  await highlight(page.getByText("Daily Digest"));
  await sleep(1200);
  await highlight(page.getByText("readyMessage"));
});
```

## Highlight Visuals

`highlight(locator, options?)` renders on the recorded video during the replay pass (Pass 2). It is
a presentation-only effect: it never changes the emitted timeline, so strict replay stays intact.

- `style: "ring"` (default) draws a clean outline ring around the element without showing locator/testid text.
- `style: "spotlight"` dims the rest of the page and cuts out the target.
- `paddingPx` expands the ring offset or the spotlight cutout.
- `durationMs` controls how long the highlight stays visible at replay time (default `800`). The
  hold delays the next authored call on the video only — it does not add timeline events.
- The default style comes from `record.highlightStyle` in `demohunter.config.ts`; a per-call
  `style` overrides it.

```ts
await highlight(page.getByRole("heading", { name: "Hello DemoHunter!" }), { style: "ring" });
await highlight(page.getByRole("status"), { style: "spotlight", paddingPx: 12, durationMs: 1200 });
```

## Visual Effects Showcase Pattern

When a tour is meant to demonstrate DemoHunter's recording effects, make the effects obvious and
keep the product UI clean.

Recommended config:

```ts
export default defineConfig({
  baseURL: "http://127.0.0.1:3200",
  record: {
    showActions: false,
    cursor: { mode: "smooth", shape: "pointer", color: "#3b82f6", ripple: true },
  },
});
```

Authoring guidance:

- Say which effect is being shown in narration: ring highlight, injected cursor, click ripple, or spotlight.
- Use longer highlight holds for demos, typically `durationMs: 3000` to `4000`.
- Avoid Playwright action annotations for showcase videos; they can reveal selector text and distract from the UI.
- Prefer `click(locator)` for visible interactions so cursor motion completes before the trusted click in both passes.
- Keep these gestures inside `narrateWhile(...)` so the voiceover explains the visual motion while it happens.

Example sequence:

```ts
await narrateWhile("The blue ring is a Pass 2-only highlight added to the video.", async () => {
  await highlight(page.getByRole("heading", { name: "Hello DemoHunter!" }), {
    durationMs: 4000,
    paddingPx: 10,
    style: "ring",
  });
});

await narrateWhile("The cursor moves naturally, clicks with a ripple, then the result is spotlighted.", async () => {
  const button = page.getByRole("button", { name: "Show the finale" });
  await click(button);

  const result = page.getByRole("status");
  await result.waitFor();
  await highlight(result, { durationMs: 4000, paddingPx: 12, style: "spotlight" });
});
```

## Template

Start from [../assets/tour.template.ts](../assets/tour.template.ts) when creating a new tour file.
