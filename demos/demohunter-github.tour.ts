import { defineTour } from "demohunter";

const repositoryUrl = "https://github.com/oaiz-io/demohunter";
const exampleTourUrl = `${repositoryUrl}/blob/main/examples/vite-demo/demos/vite-demo.tour.ts`;
const cliAnchorUrl = `${repositoryUrl}#cli`;

export default defineTour({
  id: "demohunter-github",
  title: "DemoHunter GitHub overview",
  async beforeRecord({ page }) {
    await page.goto(repositoryUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "DemoHunter" }).first().waitFor();
  },
  async run({ page, chapter, step, narrateWhile, waitForStable, snapshot }) {
    await chapter("What it is", { id: "what-it-is" });

    await step("Introduce the README", async () => {
      await narrateWhile(
        "Demohunter helps you agents to programatically generate videos with narration",
        async ({ sleep }) => {
          await page.mouse.wheel(0, 520);
          await sleep(500);
        },
      );
      await snapshot({ name: "readme-intro" });
    });

    await step("Pitch the use cases", async () => {
      await narrateWhile(
        "Use it for docs, DevRel, release notes, and pull requests where the reviewer needs to see the flow, not just read about it.",
        async ({ sleep }) => {
          await page.mouse.wheel(0, 620);
          await sleep(500);
          await page.mouse.wheel(0, 620);
          await sleep(500);
        },
      );
    });

    await chapter("How it is written", { id: "how-it-is-written" });

    await step("Open the tour source", async () => {
      await narrateWhile(
        "A demo is just a dot tour dot ts file: chapters, steps, Playwright locators, and narration around real UI motion.",
        async ({ sleep }) => {
          await page.goto(exampleTourUrl, { waitUntil: "domcontentloaded" });
          await waitForStable({ state: "domcontentloaded", timeoutMs: 10_000 });
          await page.getByText("defineTour").first().waitFor();
          await sleep(200);
          await page.mouse.wheel(0, 520);
          await sleep(700);
        },
      );
      await snapshot({ name: "example-tour-source" });
    });

    await chapter("Generate it", { id: "generate-it" });

    await step("Show the CLI command", async () => {
      await narrateWhile(
        "Then run npx demohunter generate with the tour file. Always keep your documation videos up-to-date!",
        async ({ sleep }) => {
          await page.goto(cliAnchorUrl, { waitUntil: "domcontentloaded" });
          await waitForStable({ state: "domcontentloaded", timeoutMs: 10_000 });
          await page.getByText("npx demohunter generate <tour-file>").first().waitFor();
          await page.getByText("npx demohunter generate <tour-file>").first().scrollIntoViewIfNeeded();
          await sleep(1000);
        },
      );
      await snapshot({ name: "cli-command" });
    });
  },
});
