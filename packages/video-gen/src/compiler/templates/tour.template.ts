export function escapeTypeScriptString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll('"', '\\"');
}

export type TourInstructionSource = {
  slideId: string;
  heading: string;
  narration: string;
  hasCodeBlock: boolean;
  sectionSelector: string;
  headingSelector: string;
  codeSelector: string;
};

const SCROLL_SETTLE_MS = 720;

export function renderTourModuleSource(input: {
  tourId: string;
  title: string;
  instructions: TourInstructionSource[];
}): string {
  const steps = input.instructions.map((instruction) => renderStep(instruction)).join("\n\n");

  return `import { defineTour } from "@demohunter/sdk";

export default defineTour({
  id: "${escapeTypeScriptString(input.tourId)}",
  title: "${escapeTypeScriptString(input.title)}",
  async beforeRecord({ goto, page }) {
    await goto("/");
    await page.locator(${jsonString(input.instructions[0]?.sectionSelector ?? '[data-section-index="0"]')}).waitFor();
  },
  async run({ page, chapter, step, narrateWhile, assertVisible }) {
${steps}
  },
});
`;
}

function renderStep(instruction: TourInstructionSource): string {
  const codeAssertion = instruction.hasCodeBlock
    ? `
        await assertVisible(page.locator(${jsonString(instruction.codeSelector)}));`
    : "";

  return `    await chapter(${jsonString(instruction.heading)}, { id: ${jsonString(instruction.slideId)} });

    await step(${jsonString(instruction.heading)}, async () => {
      const section = page.locator(${jsonString(instruction.sectionSelector)});
      await section.waitFor();
      await narrateWhile(${jsonString(instruction.narration)}, async () => {
        await section.evaluate((element) => {
          for (const candidate of document.querySelectorAll("[data-section-id]")) {
            candidate.setAttribute("data-current", candidate === element ? "true" : "false");
          }
          element.setAttribute("data-reveal-state", "visible");
          element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        });
        await page.waitForTimeout(${SCROLL_SETTLE_MS});
        await assertVisible(page.locator(${jsonString(instruction.headingSelector)}));${codeAssertion}
      });
    });`;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}
