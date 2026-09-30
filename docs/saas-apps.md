# Signed-in apps: Notion, Slack, Gmail

DemoHunter can record a signed-in web app, such as Notion, Slack, Gmail, or your own app behind a sign-in page. You sign in once, by hand, and save the browser session to a file. DemoHunter loads that file into every pass.

DemoHunter never signs in for you, never sees or stores your password, and does not try to hide automation from the site.

## Read this first

- **Every pass is real.** `setup`, `beforeRecord`, `run`, and `teardown` run in both passes, and again for each responsive output format. A tour that sends a message sends it at least twice. `generate` prints the number of passes before it starts.
- **Use a demo workspace or a test account you own.** The video and poster show whatever the account shows: names, email addresses, avatars, and messages. DemoHunter does not mask page content.
- **The session file is a credential.** Anyone who has it can use the account until the session expires or is revoked. Keep it outside the repository and never share it.
- **Check the app's terms and your organization's rules.** See the [terms summary](#terms-summary) below.

## Create a session file

From your DemoHunter project, run `session capture` with the app's sign-in page:

```sh
npx demohunter session capture https://www.notion.so/login --out ../.demohunter-sessions/notion-demo.json
```

A browser window opens. Sign in the usual way, including SSO, emailed codes, and two-factor prompts. Dismiss onboarding tips you do not want in the video, then press Enter in the terminal. DemoHunter saves the session with owner-only permissions. Press Ctrl-C to cancel without saving.

- The command uses the `browser` and `launch` settings from `demohunter.config.ts`, always with a visible window.
- When `session.storageState` is configured, `--out` defaults to that path.
- It refuses to write inside `outputDir` or `cacheDir`, or to a path git would commit.

You can also create the file with Playwright directly. Sign in, then close the window to save:

```sh
npx playwright open --save-storage=../.demohunter-sessions/notion-demo.json https://www.notion.so/login
chmod 600 ../.demohunter-sessions/notion-demo.json
```

## Store it outside the repository

- Use a directory next to the project, such as `../.demohunter-sessions/`, or a directory in your home folder. If the file must live inside a repository, add it to `.gitignore`.
- DemoHunter rejects session paths inside `outputDir` or `cacheDir`, because `.demohunter/` output is meant to be shared.
- Keep one file per app and account.

## Load it

```ts
// demohunter.config.ts
export default {
  baseURL: "https://www.notion.so",
  session: { storageState: "../.demohunter-sessions/notion-demo.json" },
};
```

Relative paths resolve from the project root. The `DEMOHUNTER_STORAGE_STATE` environment variable overrides the config:

```sh
DEMOHUNTER_STORAGE_STATE=/secure/tmp/notion-demo.json npx demohunter generate demos/notion.tour.ts
```

The variable holds a path, not the file contents. In CI, write a secret to a temporary file and point the variable at it.

Each pass loads the same file into a fresh browser context, so both passes start signed in from the same state. The first navigation to `baseURL` is already signed in. DemoHunter never writes back to the file.

Before a long generation, check the file:

```sh
npx demohunter doctor
```

`doctor` reports whether the file exists and parses, whether git would commit it, and when the earliest cookie for your `baseURL` host expires. It never prints cookie names or values.

## Write the tour

- Check the signed-in state in `beforeRecord`, for example by waiting for a heading that only signed-in users see. An expired session then fails before any narration is synthesized.
- Do not type credentials or automate sign-in in a tour.
- Wait with `waitForStable({ state: "domcontentloaded" })` and a wait on a visible element. Apps that poll or keep connections open may never reach `networkidle`, the default.
- Use role, label, and placeholder selectors. Record them with `npx playwright codegen` in your demo workspace. Third-party apps change their interface without notice, so expect to update tours.
- Make `setup` and `teardown` safe to repeat. In `setup`, remove anything an earlier or crashed run left behind. In `teardown`, remove what the tour created. Otherwise Pass 2 sees what Pass 1 created.
- `teardown` runs after the recording stops, so cleanup never appears in the video. It still runs in every pass.
- Typed text must be the same in both passes, so you cannot make titles unique with timestamps. Rely on cleanup instead.
- Dismiss pop-ups and first-visit tips in `setup` with plain Playwright, or dismiss them once while capturing the session. `record.cookieBanners` handles recognized consent banners.
- Small layout changes between passes, such as a banner or an extra list row, no longer break replay through cursor timing. Replay still requires the same DemoHunter calls, in the same order, with the same arguments.

## Browser settings

```ts
export default {
  baseURL: "https://www.notion.so",
  session: { storageState: "../.demohunter-sessions/notion-demo.json" },
  launch: {
    locale: "en-US",
    timezoneId: "Europe/Stockholm",
  },
};
```

- `locale` and `timezoneId` keep labels such as "Today", date formats, and greetings the same in both passes and on every machine. Set them for live apps.
- `channel` selects a Chromium build: `"chrome"` or `"msedge"` for an installed branded browser (`npx playwright install chrome`), or `"chromium"` for Playwright's full Chromium in new headless mode. It requires `browser: "chromium"`.
- `headless: false` opens a visible browser window during generation, so it needs a display. The video is still the size of the viewport.

DemoHunter has no option for arbitrary browser flags and does not disguise automation.

## When the session expires

The usual symptom is a timeout in `beforeRecord` because the app shows its sign-in page. When a session is loaded, `generate` adds a hint to the error. Run `session capture` again to replace the file.

## Revoke a session

Deleting the file does not sign the session out. Sign out of the session in the app's security settings, for example with "log out of all devices", and then delete the file.

## Debug output

Failure debug output goes to `.demohunter/<tour-id>/debug/`. While a session is loaded, DemoHunter does not write `body.txt` (the page text) and removes query strings and fragments from URLs in `failure.json`. The screenshot still shows the account. Delete the `debug/` folder before you share `.demohunter/`.

## Notion

Notion is the easiest target. Anyone can create a free workspace just for demos.

1. Create a workspace for demos with one parent page, for example "Demo hub". Tours work under that page.
2. Capture a session from `https://www.notion.so/login` and set `baseURL` to `https://www.notion.so`.
3. In `setup`, remove pages left behind with the tour's page title. In `teardown`, move the page the tour created to the trash. Notion's [public API](https://developers.notion.com/guides/get-started/personal-access-tokens) can do both from your own code, with an integration token in your environment.

The selectors below are examples. Take the real ones from `npx playwright codegen` in your workspace.

```ts
import { defineTour } from "demohunter";

const HUB_URL = process.env.NOTION_DEMO_HUB_URL ?? "";
const TITLE = "Launch checklist";

export default defineTour({
  id: "notion-launch-checklist",
  title: "Create a launch checklist in Notion",
  async setup({ page }) {
    await removeDemoPagesTitled(TITLE);
    await page.goto(HUB_URL, { waitUntil: "domcontentloaded" });
  },
  async beforeRecord({ page }) {
    await page.getByRole("heading", { name: "Demo hub" }).waitFor({ timeout: 15_000 });
  },
  async run({ page, chapter, step, narrate, narrateWhile, click, waitForStable }) {
    await chapter("Create the page");

    await step("Add a page", async () => {
      await narrate("Everything for the launch lives under the demo hub.");
      await narrateWhile("Add a new page right here.", async () => {
        await click(page.getByRole("button", { name: "Add a page" }));
      });
    });

    await step("Name it", async () => {
      await narrateWhile("Give it a title the whole team will recognize.", async ({ typeText }) => {
        await typeText(page.getByPlaceholder("New page"), TITLE, { pace: "natural", seed: "title" });
      });
      await waitForStable({ state: "domcontentloaded" });
    });
  },
  async teardown() {
    await removeDemoPagesTitled(TITLE);
  },
});

async function removeDemoPagesTitled(title: string): Promise<void> {
  // Your code: archive child pages of the hub with this title through the
  // Notion API, using NOTION_TOKEN from the environment.
}
```

## Slack

Every Slack workspace belongs to an organization, and its owner sets the rules.

- Record in a workspace you own, in a private sandbox channel. Never post into a shared or work workspace without the owner's consent.
- Every sent message is real and notifies members, at least twice per generation. Prefer to show composing a message without sending it. If sending is the point, delete the message in `teardown`, if your workspace lets members delete their own messages.
- Capture a session from `https://app.slack.com` and use it as `baseURL`.
- Workspace policies such as SSO or session length can end the session early. Capture it again when it expires.

## Gmail

Gmail support is best effort.

- Google may block sign-in from browsers that it detects are "being controlled through software automation rather than a human" ([Google Account Help](https://support.google.com/accounts/answer/7675428)). That can include the window that `session capture` or `playwright open` opens, even though you type the password yourself.
- Use a test Google account only, never a personal or work account. Inbox content is personal data.
- A reasonable setup is an installed Chrome in a visible window for both capture and generation: run `npx playwright install chrome` and set `launch: { channel: "chrome", headless: false }`. This is ordinary browser configuration, not a way around Google's checks, and it may still be refused.
- If Google refuses the sign-in, or challenges or ends the reused session, stop there. DemoHunter does not support working around Google's checks, and doing so can breach Google's terms.
- Compose and show drafts, then discard them in `teardown`. If sending is essential, send only to a second test account you own.

## Terms summary

This is a summary, not legal advice. Terms change, so read the current versions.

| Provider | What to know |
| --- | --- |
| Google | The [Google Terms of Service](https://policies.google.com/terms) prohibit "bypassing our systems". Google may block sign-in from automated browsers ([Google Account Help](https://support.google.com/accounts/answer/7675428)). Google Workspace administrators can add their own rules. |
| Slack | Slack's [acceptable use policy](https://slack.com/acceptable-use-policy) is now the Salesforce policy. The workspace owner controls access and integrations, and members must follow the owner's policies ([user terms](https://slack.com/terms-of-service/user)). Ask the owner before you automate a workspace you do not own. |
| Notion | Notion's [Personal Use Terms](https://www.notion.so/Personal-Use-Terms-of-Service-00e4e5d0f2b9411cbee6493f15779500) prohibit robots and other automated means that access the service to monitor, extract, copy, or collect information. Recording content you create in your own workspace is not data collection, but the clause is broad. Team and Enterprise workspaces also have their own agreements. |

DemoHunter supports only this kind of use: you run it on your own machine, against an account you control, with a session you created yourself. It has no hosted sign-in and does not store sessions.

## What DemoHunter does not do

- Sign in for you, type passwords, or read one-time codes.
- Store or upload session files. Only `session capture` writes one, to the path you choose.
- Disguise automation, change the browser fingerprint, or pass arbitrary browser flags.
- Mask account content in the video.
