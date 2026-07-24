import { generateContentSpec } from "../content/generator.js";
import type { ContentSpec } from "../content/schema.js";
import { compileTour } from "../compiler/tour-compiler.js";
import { buildBridgeConfig, runDemoHunterBridge } from "../bridge/demohunter.js";
import { startStaticServer } from "../bridge/server.js";
import {
  assertNoWorkspaceCollision,
  cleanupWorkspaceIfRequested,
  createGenerationWorkspace,
  resolveGenerationPaths,
} from "../bridge/workspace.js";
import { renderLesson } from "../templates/engine.js";
import { VideoGenError } from "./errors.js";
import {
  assertPreflightOk,
  deriveTourId,
  runPreflight,
  validateGenerateOptions,
  type PreflightDependencies,
  type ValidatedGenerateOptions,
} from "./preflight.js";
import type {
  GenerateVideoOptions,
  GenerateVideoResult,
  VideoGenerationProgressEvent,
} from "./types.js";

export type OrchestratorDependencies = {
  generateContentSpec?: typeof generateContentSpec;
  renderLesson?: typeof renderLesson;
  compileTour?: typeof compileTour;
  createGenerationWorkspace?: typeof createGenerationWorkspace;
  startStaticServer?: typeof startStaticServer;
  runDemoHunterBridge?: typeof runDemoHunterBridge;
  runPreflight?: typeof runPreflight;
  cleanupWorkspaceIfRequested?: typeof cleanupWorkspaceIfRequested;
  preflightDependencies?: PreflightDependencies;
  cwd?: string;
};

export async function runVideoGenerationPipeline(
  options: GenerateVideoOptions,
  dependencies: OrchestratorDependencies = {},
): Promise<GenerateVideoResult> {
  const cwd = dependencies.cwd ?? process.cwd();
  const validated = validateGenerateOptions(options, cwd);
  const report = createReporter(validated.onProgress);

  throwIfAborted(validated.signal);
  report({ phase: "preflight", message: "Running local preflight checks" });
  const runPreflightFn = dependencies.runPreflight ?? runPreflight;
  const machinePreflight = await runPreflightFn(
    { options: validated, signal: validated.signal },
    dependencies.preflightDependencies,
  );
  assertPreflightOk(machinePreflight);

  throwIfAborted(validated.signal);
  report({ phase: "content", message: "Generating lesson content" });
  const generateContent = dependencies.generateContentSpec ?? generateContentSpec;
  let spec: ContentSpec;
  try {
    spec = await generateContent({
      prompt: validated.prompt,
      model: validated.model,
      signal: validated.signal,
    });
  } catch (error) {
    if (error instanceof VideoGenError) {
      throw error;
    }
    throw new VideoGenError(
      "CONTENT_FAILED",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const tourId = deriveTourId(spec.title);
  throwIfAborted(validated.signal);

  const collisionPreflight = await runPreflightFn(
    { options: validated, tourId, signal: validated.signal },
    dependencies.preflightDependencies,
  );
  assertPreflightOk(collisionPreflight);

  const workspace = resolveGenerationPaths({
    outputDir: validated.outputDir,
    tourId,
  });
  await assertNoWorkspaceCollision(workspace);

  throwIfAborted(validated.signal);
  report({ phase: "render", message: `Rendering ${validated.style} lesson site` });
  const render = dependencies.renderLesson ?? renderLesson;
  let site;
  try {
    site = render({ spec, style: validated.style });
  } catch (error) {
    throw new VideoGenError(
      "RENDER_FAILED",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  throwIfAborted(validated.signal);
  report({ phase: "compile", message: "Compiling DemoHunter tour" });
  const compile = dependencies.compileTour ?? compileTour;
  let compiled;
  try {
    compiled = compile({ spec, tourId });
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

  // Config source needs the eventual baseURL; write a placeholder then rewrite after server start
  // is awkward for atomic publish. Instead, allocate the server first after publishing a temporary
  // config is wrong per plan order. Plan order: stage → render → compile/write → publish → start server.
  // Config baseURL must match the server. We start the server after publish, so write config with a
  // deferred rewrite is not allowed. Solution: bind server port before publish by creating site files
  // in staging, start server from staging, then publish — but plan says publish then start server.
  // Practical approach matching DemoHunter: publish workspace with a config that will be regenerated
  // once the server URL is known, still before generateTour. We'll publish with a temporary baseURL
  // then atomically rewrite demohunter.config.ts after server start and before bridge invocation.
  const placeholderConfig = buildBridgeConfig({
    baseURL: "http://127.0.0.1:0",
    outputDir: workspace.outputDir,
    cacheDir: workspace.cacheDir,
  });

  const createWorkspace = dependencies.createGenerationWorkspace ?? createGenerationWorkspace;
  await createWorkspace({
    workspace,
    spec,
    site,
    compiled,
    configSource: placeholderConfig.configSource,
  });

  const startServer = dependencies.startStaticServer ?? startStaticServer;
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    throwIfAborted(validated.signal);
    report({ phase: "serve", message: "Starting local lesson server" });
    try {
      server = await startServer(workspace.siteDir);
    } catch (error) {
      throw new VideoGenError(
        "SERVER_FAILED",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const bridgeConfig = buildBridgeConfig({
      baseURL: server.baseURL,
      outputDir: workspace.outputDir,
      cacheDir: workspace.cacheDir,
    });
    const { writeFileAtomic } = await import("../util/fs.js");
    await writeFileAtomic(workspace.configPath, bridgeConfig.configSource);

    throwIfAborted(validated.signal);
    report({ phase: "record", message: "Recording narrated video with DemoHunter" });

    const bridge = dependencies.runDemoHunterBridge ?? runDemoHunterBridge;
    const recordingPromise = bridge({
      baseURL: server.baseURL,
      outputDir: workspace.outputDir,
      cacheDir: workspace.cacheDir,
      configPath: workspace.configPath,
      projectRoot: workspace.workspaceDir,
      tourPath: workspace.tourPath,
      tour: compiled.tour,
      onProgress: validated.onProgress,
    });

    const result = await awaitWithCancellation(recordingPromise, validated.signal);

    let workspacePreserved = true;
    if (validated.cleanup) {
      report({ phase: "cleanup", message: "Removing inspectable source workspace" });
      const cleanup = dependencies.cleanupWorkspaceIfRequested ?? cleanupWorkspaceIfRequested;
      workspacePreserved = await cleanup({ workspace, cleanup: true });
    }

    const generateResult: GenerateVideoResult = {
      id: tourId,
      title: spec.title,
      style: validated.style,
      workspaceDir: workspace.workspaceDir,
      contentSpecPath: workspace.contentSpecPath,
      siteDir: workspace.siteDir,
      tourPath: workspace.tourPath,
      configPath: workspace.configPath,
      outputDir: result.outputDir,
      videoPath: result.videoPath,
      captionsSrtPath: result.captionsSrtPath,
      captionsVttPath: result.captionsVttPath,
      chaptersPath: result.chaptersPath,
      workspacePreserved,
    };

    report({ phase: "complete", message: `Video ready at ${result.videoPath}` });
    return generateResult;
  } finally {
    if (server !== undefined) {
      await server.close().catch(() => undefined);
    }
  }
}

function createReporter(
  onProgress?: (event: VideoGenerationProgressEvent) => void,
): (event: VideoGenerationProgressEvent) => void {
  return (event) => {
    onProgress?.(event);
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new VideoGenError("INTERRUPTED", "Generation was cancelled.");
  }
}

async function awaitWithCancellation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    // Still wait for DemoHunter to unwind safely, then report interrupted.
    await promise.catch(() => undefined);
    throw new VideoGenError("INTERRUPTED", "Generation was cancelled during recording.");
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // Do not reject until the underlying generator settles.
      void promise.then(
        () => {
          reject(new VideoGenError("INTERRUPTED", "Generation was cancelled during recording."));
        },
        () => {
          reject(new VideoGenError("INTERRUPTED", "Generation was cancelled during recording."));
        },
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(new VideoGenError("INTERRUPTED", "Generation was cancelled during recording."));
          return;
        }
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(new VideoGenError("INTERRUPTED", "Generation was cancelled during recording."));
          return;
        }
        reject(error);
      },
    );
  });
}

export type { ValidatedGenerateOptions };
