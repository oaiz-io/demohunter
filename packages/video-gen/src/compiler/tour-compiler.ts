import { defineTour } from "@demohunter/sdk";
import type { DemoHunterTour } from "@demohunter/sdk";

import type { ContentSpec } from "../content/schema.js";
import type { CompiledTour, CompileTourInput } from "../pipeline/types.js";
import { VideoGenError } from "../pipeline/errors.js";
import { isValidTourId } from "../util/slug.js";
import {
  lessonSectionSelector,
  sectionCodeBlockSelector,
  sectionHeadingSelector,
} from "./selectors.js";
import { renderTourModuleSource, type TourInstructionSource } from "./templates/tour.template.js";

export const SCROLL_SETTLE_MS = 720;

export type TourInstruction = TourInstructionSource;

export function compileTourInstructions(spec: ContentSpec, tourId: string): TourInstruction[] {
  if (!isValidTourId(tourId)) {
    throw new VideoGenError("COMPILE_FAILED", `Invalid tour id: ${tourId}`);
  }

  return spec.slides.map((slide) => {
    const hasCodeBlock = slide.body.some((element) => element.type === "code_block");
    return {
      slideId: slide.id,
      heading: slide.heading,
      narration: slide.narration,
      hasCodeBlock,
      sectionSelector: lessonSectionSelector(slide.id),
      headingSelector: sectionHeadingSelector(slide.id),
      codeSelector: sectionCodeBlockSelector(slide.id),
    };
  });
}

export function compileTour(input: CompileTourInput): CompiledTour {
  try {
    const instructions = compileTourInstructions(input.spec, input.tourId);
    const moduleSource = renderTourModuleSource({
      tourId: input.tourId,
      title: input.spec.title,
      instructions,
    });
    const tour = buildInMemoryTour({
      tourId: input.tourId,
      title: input.spec.title,
      instructions,
    });

    return {
      tourId: input.tourId,
      moduleSource,
      tour,
    };
  } catch (error) {
    if (error instanceof VideoGenError) {
      throw error;
    }
    throw new VideoGenError(
      "COMPILE_FAILED",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

export function buildInMemoryTour(input: {
  tourId: string;
  title: string;
  instructions: TourInstruction[];
}): DemoHunterTour {
  const instructions = input.instructions;

  return defineTour({
    id: input.tourId,
    title: input.title,
    async beforeRecord({ goto, page }) {
      await goto("/");
      const first = instructions[0];
      if (first !== undefined) {
        await page.locator(first.sectionSelector).waitFor();
      }
    },
    async run({ page, chapter, step, narrateWhile, assertVisible }) {
      for (const instruction of instructions) {
        await chapter(instruction.heading, { id: instruction.slideId });
        await step(instruction.heading, async () => {
          const section = page.locator(instruction.sectionSelector);
          await section.waitFor();
          await narrateWhile(instruction.narration, async () => {
            await section.evaluate((element) => {
              for (const candidate of document.querySelectorAll("[data-section-id]")) {
                candidate.setAttribute("data-current", candidate === element ? "true" : "false");
              }
              element.setAttribute("data-reveal-state", "visible");
              element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
            });
            await page.waitForTimeout(SCROLL_SETTLE_MS);
            await assertVisible(page.locator(instruction.headingSelector));
            if (instruction.hasCodeBlock) {
              await assertVisible(page.locator(instruction.codeSelector));
            }
          });
        });
      }
    },
  });
}
