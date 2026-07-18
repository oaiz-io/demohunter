import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const entrypointContractTimeoutMs = 20_000;

async function buildCli(): Promise<void> {
  const processResult = Bun.spawn({
    cmd: [process.execPath, "run", "--cwd", "packages/cli", "build"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "CLI build failed");
  }
}

describe("demohunter package entrypoint", () => {
  test("exposes natural typing timeline declarations to consumer tours", async () => {
    await buildCli();

    const declarationPath = path.join(repoRoot, "packages/cli/dist/index.d.ts");
    const declarations = await readFile(declarationPath, "utf8");

    expect(declarations).toContain("TypeTextPace");
    expect(declarations).toContain("TypeTextOptions");
    expect(declarations).toContain("DemoHunterTypeText");
    expect(declarations).toContain("DemoHunterNarrationTimeline");
    expect(declarations).toContain("DemoHunterNarrateWhileTimeline");
    expect(declarations).toContain("DemoHunterAuthorRunContext");
    expect(declarations).toContain("DemoHunterAuthorNarrateWhile");
    expect(declarations).toContain("typeText: DemoHunterTypeText");
    expect(declarations).toContain("HighlightStyle");
    expect(declarations).toContain("showCursor?: boolean");
    expect(declarations).toContain("showClickRipple?: boolean");
    expect(declarations).toContain("highlightStyle?: HighlightStyle");
    expect(declarations).toContain('style?: "ring" | "spotlight"');
    expect(declarations).toContain("durationMs?: number");
    expect(declarations).toContain("OutputFormatRequest");
    expect(declarations).toContain("OutputConfig");
    expect(declarations).toContain("GenerateOverrides");
    expect(declarations).toContain("DEFAULT_OUTPUT_CONFIG");
    expect(declarations).toContain("container: RecordFormat");
    expect(declarations).toContain("output: OutputConfig");
    expect(declarations).not.toContain('@demohunter/sdk');

    await typecheckConsumerTour();
  }, entrypointContractTimeoutMs);
});

async function typecheckConsumerTour(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "demohunter-cli-entrypoint-"));

  try {
    const fixturePath = path.join(tempDir, "consumer.tour.ts");
    const tsconfigPath = path.join(tempDir, "tsconfig.json");
    await writeFile(
      fixturePath,
      `import {
  defineTour,
  defineConfig,
  type DemoHunterNarrateWhile,
  type DemoHunterNarrationTimeline,
  type DemoHunterRunContext,
  type GenerateOverrides,
  type HighlightOptions,
  type OutputFormatRequest,
  type RecordConfig,
  type TypeTextOptions,
} from "demohunter";

const sleepOnlyTimeline: DemoHunterNarrationTimeline = {
  sleep: async () => undefined,
};

const legacyNarrateWhile: DemoHunterNarrateWhile = async (_text, fn) => fn(sleepOnlyTimeline);

const recordConfig: RecordConfig = {
  format: "mp4",
  showActions: false,
  showChapters: true,
  showCursor: false,
  showClickRipple: false,
  highlightStyle: "spotlight",
};

const outputFormat: OutputFormatRequest = {
  preset: "square",
};

const generateOverrides: GenerateOverrides = {
  cookieDismiss: false,
  cursor: false,
  outputFormats: [outputFormat],
};

const highlightOptions: HighlightOptions = {
  style: "ring",
  durationMs: 1600,
  paddingPx: 12,
};

export const config = defineConfig({
  baseURL: "http://localhost:3000",
  record: recordConfig,
  output: {
    formats: [outputFormat],
  },
});

export default defineTour({
  id: "consumer-natural-typing",
  title: "Consumer natural typing",
  async run({ page, narrateWhile, highlight }) {
    await narrateWhile("Enter the customer name.", async ({ sleep, typeText }) => {
      const options: TypeTextOptions = {
        pace: "natural",
        replace: true,
        seed: "consumer-natural-typing",
        timeoutMs: 1500,
      };

      await sleep(250);
      await typeText(page.getByLabel("Customer"), "Acme", options);
    });
    await highlight(page.getByLabel("Customer"), highlightOptions);
  },
});

const legacyRunContext = {
  config: {
    baseURL: "http://localhost:3000",
    browser: "chromium",
    cacheDir: ".demohunter/cache",
    holdPaddingMs: 300,
    outputDir: ".demohunter",
    record: {
      container: "mp4",
      format: "mp4",
      showActions: true,
      showChapters: true,
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
    },
    output: {
      formats: [],
    },
    tts: {
      format: "mp3",
      instructions: "Speak clearly.",
      model: "gpt-4o-mini-tts",
      provider: "openai",
      voice: "marin",
    },
    viewport: {
      height: 900,
      width: 1440,
    },
  },
  goto: async () => null,
  page: {} as DemoHunterRunContext["page"],
  chapter: async () => undefined,
  step: async (_title, fn) => {
    return fn();
  },
  narrate: async () => undefined,
  narrateWhile: legacyNarrateWhile,
  waitForStable: async () => undefined,
  highlight: async () => undefined,
  snapshot: async () => undefined,
  assertVisible: async () => undefined,
  click: async () => undefined,
} satisfies DemoHunterRunContext;

void legacyRunContext;
void generateOverrides;
`,
    );
    await writeFile(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            noEmit: true,
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ESNext"],
            types: ["node"],
            typeRoots: [path.join(repoRoot, "node_modules", "@types")],
            skipLibCheck: true,
            baseUrl: repoRoot,
            paths: {
              demohunter: ["packages/cli/dist/index.d.ts"],
            },
          },
          files: [fixturePath],
        },
        null,
        2,
      )}\n`,
    );

    const processResult = Bun.spawn({
      cmd: [process.execPath, "x", "tsc", "-p", tsconfigPath],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(stderr || stdout || "Consumer fixture typecheck failed.");
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}
