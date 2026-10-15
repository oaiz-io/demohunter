import { defineTour } from "demohunter";

const docsUrl = "https://oaiz.io/docs";

export default defineTour({
  id: "oaiz-docs",
  title: "OAIZ documentation tour",
  async beforeRecord({ page }) {
    await page.goto(docsUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: "From a sentence to a workflow" })
      .waitFor();
  },
  async run({ page, chapter, step, narrateWhile, waitForStable, snapshot }) {
    const openDocsPage = async (href: string, heading: string) => {
      await page.locator(`a[href="${href}"]:visible`).first().click();
      await waitForStable({ state: "domcontentloaded", timeoutMs: 10_000 });
      await page
        .getByRole("heading", { name: heading, exact: true })
        .first()
        .waitFor();
    };

    await chapter("Start here", { id: "start-here" });

    await step("Introduce Chat to workflow", async () => {
      await narrateWhile(
        "This is the OAIZ documentation. It starts with the main idea: describe the work in Chat, and OAIZ plans the workflow and adds the jobs.",
        async ({ sleep }) => {
          await sleep(1200);
          await page.mouse.wheel(0, 480);
          await sleep(900);
        },
      );
      await snapshot({ name: "chat-to-workflow" });
    });

    await step("Show how it works", async () => {
      await narrateWhile(
        "You review each new job, keep or reject the changes, and test the draft with an example event before anything runs live.",
        async ({ sleep }) => {
          await page
            .getByRole("heading", { name: "How it works" })
            .scrollIntoViewIfNeeded();
          await sleep(1400);
        },
      );
    });

    await chapter("Concepts", { id: "concepts" });

    await step("Open the overview", async () => {
      await narrateWhile(
        "The overview explains the concepts. A job waits for an event, runs an action, and can publish a new event that starts the next job.",
        async ({ sleep }) => {
          await openDocsPage("/docs/overview", "OAIZ documentation");
          await sleep(900);
          await page.mouse.wheel(0, 560);
          await sleep(900);
        },
      );
      await snapshot({ name: "overview-concepts" });
    });

    await step("Open the quickstart", async () => {
      await narrateWhile(
        "The quickstart builds a first workflow in eight steps. It summarizes a customer message, tests it, and then promotes it to live.",
        async ({ sleep }) => {
          await openDocsPage(
            "/docs/quickstart",
            "Build, test, and run your first workflow",
          );
          await sleep(900);
          await page.mouse.wheel(0, 640);
          await sleep(1000);
        },
      );
      await snapshot({ name: "quickstart-steps" });
    });

    await step("Explain workflow states", async () => {
      await narrateWhile(
        "A workflow is a draft, live, or paused. You edit and test the draft, and only the live version reacts to real events.",
        async ({ sleep }) => {
          await openDocsPage("/docs/workflows", "Workflows");
          await sleep(700);
          await page
            .getByRole("heading", { name: "Draft, live, and paused" })
            .scrollIntoViewIfNeeded();
          await sleep(1200);
        },
      );
    });

    await chapter("Build blocks", { id: "build-blocks" });

    await step("List the actions", async () => {
      await narrateWhile(
        "Actions are the work that a job does: model calls and agents, code, schedules, human approval, databases, webhooks, and integration actions.",
        async ({ sleep }) => {
          await openDocsPage("/docs/actions", "Actions");
          await sleep(900);
          await page.mouse.wheel(0, 520);
          await sleep(1000);
        },
      );
      await snapshot({ name: "actions" });
    });

    await step("Show the integrations", async () => {
      await narrateWhile(
        "Integrations connect accounts such as Gmail, Google Calendar, and Google Drive, with their actions and the events that they publish.",
        async ({ sleep }) => {
          await openDocsPage("/docs/integrations", "Integrations");
          await sleep(900);
          await page.mouse.wheel(0, 420);
          await sleep(1000);
        },
      );
      await snapshot({ name: "integrations" });
    });
  },
});
