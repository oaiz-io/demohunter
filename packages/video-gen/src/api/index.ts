import { runVideoGenerationPipeline, type OrchestratorDependencies } from "../pipeline/orchestrator.js";
import type { GenerateVideoOptions, GenerateVideoResult } from "../pipeline/types.js";

export async function generateVideo(
  options: GenerateVideoOptions,
  dependencies?: OrchestratorDependencies,
): Promise<GenerateVideoResult> {
  return runVideoGenerationPipeline(options, dependencies);
}

export type { GenerateVideoOptions, GenerateVideoResult };
