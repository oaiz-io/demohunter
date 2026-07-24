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
  isFirst: boolean;
  hasCodeBlock: boolean;
  slideSelector: string;
  activeSelector: string;
  headingSelector: string;
  codeSelector: string;
  nextSelector: string;
};

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
    await page.locator(${jsonString(input.instructions[0]?.activeSelector ?? '[data-slide-index="0"][data-active="true"]')}).waitFor();
  },
  async run({ page, chapter, step, narrate, narrateWhile, assertVisible, click }) {
${steps}
  },
});
`;
}

function renderStep(instruction: TourInstructionSource): string {
  const navigation = instruction.isFirst
    ? ""
    : `      await click(page.locator(${jsonString(instruction.nextSelector)}));
`;

  const narration = instruction.hasCodeBlock
    ? `      await narrateWhile(${jsonString(instruction.narration)}, async () => {
        await assertVisible(page.locator(${jsonString(instruction.codeSelector)}));
      });`
    : `      await narrate(${jsonString(instruction.narration)});`;

  return `    await chapter(${jsonString(instruction.heading)}, { id: ${jsonString(instruction.slideId)} });

    await step(${jsonString(instruction.heading)}, async () => {
${navigation}      await page.locator(${jsonString(instruction.activeSelector)}).waitFor();
      await assertVisible(page.locator(${jsonString(instruction.headingSelector)}));
${narration}
    });`;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}
