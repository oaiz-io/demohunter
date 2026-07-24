import { defineTour } from "@demohunter/sdk";
import type { DemoHunterTour } from "@demohunter/sdk";

import type { ContentSpec, SlideSpec } from "../content/schema.js";
import type { CompiledTour, CompileTourInput } from "../pipeline/types.js";
import { VideoGenError } from "../pipeline/errors.js";
import { isValidTourId } from "../util/slug.js";
import {
  activeSlideSelector,
  nextNavSelector,
  slideCodeBlockSelector,
  slideHeadingSelector,
  slideSectionSelector,
} from "./selectors.js";
import { renderTourModuleSource, type TourInstructionSource } from "./templates/tour.template.js";

export type TourInstruction = TourInstructionSource & {
  transition: SlideSpec["transition"];
};

export function compileTourInstructions(spec: ContentSpec, tourId: string): TourInstruction[] {
  if (!isValidTourId(tourId)) {
    throw new VideoGenError("COMPILE_FAILED", `Invalid tour id: ${tourId}`);
  }

  return spec.slides.map((slide, index) => {
    const hasCodeBlock = slide.body.some((element) => element.type === "code_block");
    return {
      slideId: slide.id,
      heading: slide.heading,
      narration: slide.narration,
      transition: slide.transition,
      isFirst: index === 0,
      hasCodeBlock,
      slideSelector: slideSectionSelector(slide.id),
      activeSelector: activeSlideSelector(slide.id),
      headingSelector: slideHeadingSelector(slide.id),
      codeSelector: slideCodeBlockSelector(slide.id),
      nextSelector: nextNavSelector(),
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
        await page.locator(first.activeSelector).waitFor();
      }
    },
    async run({ page, chapter, step, narrate, narrateWhile, assertVisible, click }) {
      for (const instruction of instructions) {
        await chapter(instruction.heading, { id: instruction.slideId });
        await step(instruction.heading, async () => {
          if (!instruction.isFirst) {
            await click(page.locator(instruction.nextSelector));
          }
          await page.locator(instruction.activeSelector).waitFor();
          await assertVisible(page.locator(instruction.headingSelector));
          if (instruction.hasCodeBlock) {
            await narrateWhile(instruction.narration, async () => {
              await assertVisible(page.locator(instruction.codeSelector));
            });
          } else {
            await narrate(instruction.narration);
          }
        });
      }
    },
  });
}
