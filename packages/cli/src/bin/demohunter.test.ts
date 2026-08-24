import { describe, expect, mock, test } from "bun:test";

import { isExecutedAsEntrypoint, parseReviewArgs, runCli } from "./demohunter.js";

function buildStubs(overrides: Partial<Parameters<typeof runCli>[2]> = {}): Parameters<typeof runCli>[2] {
  return {
    cacheCommand: mock(async () => {}),
    doctorCommand: mock(async () => {}),
    initCommand: mock(async () => {}),
    generateCommand: mock(async () => {}),
    addSkillCommand: mock(async () => {}),
    reviewInitCommand: mock(async () => {}),
    reviewGenerateCommand: mock(async () => {}),
    reviewServeCommand: mock(async () => {}),
    reviewVerifyCommand: mock(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("runCli", () => {
  test("dispatches init with the force flag", async () => {
    const stubs = buildStubs();

    await runCli(["init", "--force"], "/tmp/demo", stubs);

    expect(stubs.initCommand).toHaveBeenCalledWith("/tmp/demo", { force: true });
    expect(stubs.cacheCommand).not.toHaveBeenCalled();
    expect(stubs.generateCommand).not.toHaveBeenCalled();
    expect(stubs.doctorCommand).not.toHaveBeenCalled();
    expect(stubs.addSkillCommand).not.toHaveBeenCalled();
  });

  test("dispatches generate with the requested tour path", async () => {
    const stubs = buildStubs();

    await runCli(["generate", "demos/sample.tour.ts"], "/tmp/demo", stubs);

    expect(stubs.generateCommand).toHaveBeenCalledWith("/tmp/demo", "demos/sample.tour.ts", {});
  });

  test("dispatches generate with dry-run validation", async () => {
    const stubs = buildStubs();

    await runCli(["generate", "demos/sample.tour.ts", "--dry-run"], "/tmp/demo", stubs);

    expect(stubs.generateCommand).toHaveBeenCalledWith("/tmp/demo", "demos/sample.tour.ts", { dryRun: true });
  });

  test("dispatches generate with flow-only validation", async () => {
    const stubs = buildStubs();

    await runCli(["generate", "demos/sample.tour.ts", "--flow-only"], "/tmp/demo", stubs);

    expect(stubs.generateCommand).toHaveBeenCalledWith("/tmp/demo", "demos/sample.tour.ts", { flowOnly: true });
  });

  test("dispatches generate with cookie dismissal overrides", async () => {
    const stubs = buildStubs();

    await runCli([
      "generate",
      "demos/sample.tour.ts",
      "--cookie-dismiss=reject",
    ], "/tmp/demo", stubs);

    expect(stubs.generateCommand).toHaveBeenCalledWith("/tmp/demo", "demos/sample.tour.ts", {
      cookieDismiss: "reject",
    });
  });

  test("supports disabling cookie dismissal for one run", async () => {
    const stubs = buildStubs();

    await runCli([
      "generate",
      "--no-cookie-dismiss",
      "demos/sample.tour.ts",
    ], "/tmp/demo", stubs);

    expect(stubs.generateCommand).toHaveBeenCalledWith("/tmp/demo", "demos/sample.tour.ts", {
      cookieDismiss: false,
    });
  });

  test("rejects conflicting cookie dismissal flags", async () => {
    await expect(runCli([
      "generate",
      "demos/sample.tour.ts",
      "--cookie-dismiss",
      "accept",
      "--no-cookie-dismiss",
    ], "/tmp/demo", buildStubs())).rejects.toThrow(
      "Use only one of --cookie-dismiss or --no-cookie-dismiss",
    );
  });

  test.each(["none", "highlight", "smooth", "ripple"] as const)(
    "dispatches the %s cursor preset",
    async (cursor) => {
      const stubs = buildStubs();

      await runCli([
        "generate",
        "demos/sample.tour.ts",
        `--cursor=${cursor}`,
      ], "/tmp/demo", stubs);

      expect(stubs.generateCommand).toHaveBeenCalledWith("/tmp/demo", "demos/sample.tour.ts", {
        cursor,
      });
    },
  );

  test("rejects invalid cursor presets", async () => {
    await expect(runCli([
      "generate",
      "demos/sample.tour.ts",
      "--cursor",
      "teleport",
    ], "/tmp/demo", buildStubs())).rejects.toThrow(
      "Invalid --cursor value: teleport",
    );
  });

  test("dispatches repeatable social formats with a GIF duration", async () => {
    const stubs = buildStubs();

    await runCli([
      "generate",
      "demos/sample.tour.ts",
      "--format", "standard",
      "--format=square",
      "--format", "gif",
      "--duration", "12.5",
    ], "/tmp/demo", stubs);

    expect(stubs.generateCommand).toHaveBeenCalledWith("/tmp/demo", "demos/sample.tour.ts", {
      formats: [
        { preset: "standard" },
        { preset: "square" },
        { preset: "gif", durationMs: 12_500 },
      ],
    });
  });

  test("rejects duplicate formats and GIF durations without GIF output", async () => {
    await expect(runCli([
      "generate", "demos/sample.tour.ts", "--format", "square", "--format=square",
    ], "/tmp/demo", buildStubs())).rejects.toThrow("--format square may only be provided once");

    await expect(runCli([
      "generate", "demos/sample.tour.ts", "--format", "standard", "--duration", "12",
    ], "/tmp/demo", buildStubs())).rejects.toThrow("only be used together with --format gif");

    await expect(runCli([
      "generate", "demos/sample.tour.ts", "--format", "gif", "--duration", "16",
    ], "/tmp/demo", buildStubs())).rejects.toThrow("0.001 to 15");

    await expect(runCli([
      "generate", "demos/sample.tour.ts", "--format", "gif", "--duration", "0.0004",
    ], "/tmp/demo", buildStubs())).rejects.toThrow("0.001 to 15");
  });

  test("dispatches doctor", async () => {
    const stubs = buildStubs();

    await runCli(["doctor"], "/tmp/demo", stubs);

    expect(stubs.doctorCommand).toHaveBeenCalledWith("/tmp/demo");
  });

  test("dispatches cache subcommands with the requested action", async () => {
    const stubs = buildStubs();

    await runCli(["cache", "prune"], "/tmp/demo", stubs);

    expect(stubs.cacheCommand).toHaveBeenCalledWith("/tmp/demo", { action: "prune" });
  });

  test("dispatches add-skill with the requested target", async () => {
    const stubs = buildStubs();

    await runCli(["add-skill", "--target", "claude"], "/tmp/demo", stubs);

    expect(stubs.addSkillCommand).toHaveBeenCalledWith("/tmp/demo", { targets: ["claude"] });
  });

  test("dispatches add-skill to both targets when --target is omitted", async () => {
    const stubs = buildStubs();

    await runCli(["add-skill"], "/tmp/demo", stubs);

    expect(stubs.addSkillCommand).toHaveBeenCalledWith("/tmp/demo", { targets: ["claude", "codex"] });
  });

  test("expands --target both into every supported target", async () => {
    const stubs = buildStubs();

    await runCli(["add-skill", "--target=both"], "/tmp/demo", stubs);

    expect(stubs.addSkillCommand).toHaveBeenCalledWith("/tmp/demo", { targets: ["claude", "codex"] });
  });

  test("throws a usage error when generate is missing the tour path", async () => {
    await expect(runCli(["generate"], "/tmp/demo", buildStubs())).rejects.toThrow(
      "Usage: demohunter generate <tour-file> [--dry-run|--flow-only]",
    );
  });

  test("throws a usage error when cache is missing the action", async () => {
    await expect(runCli(["cache"], "/tmp/demo", buildStubs())).rejects.toThrow(
      "Usage: demohunter cache <list|prune|clear>",
    );
  });

  test("throws on unknown commands with a hint to --help", async () => {
    await expect(runCli(["ship-it"], "/tmp/demo", buildStubs())).rejects.toThrow(
      'Unknown command: ship-it. Run "demohunter --help" to see available commands.',
    );
  });

  test("prints help text when called with --help", async () => {
    const stubs = buildStubs();
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (message: unknown) => {
      logged.push(String(message));
    };

    try {
      await runCli(["--help"], "/tmp/demo", stubs);
    } finally {
      console.log = originalLog;
    }

    expect(logged.join("\n")).toContain("demohunter <command>");
    expect(stubs.initCommand).not.toHaveBeenCalled();
  });

  test("prints help text when called with no arguments", async () => {
    const stubs = buildStubs();
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (message: unknown) => {
      logged.push(String(message));
    };

    try {
      await runCli([], "/tmp/demo", stubs);
    } finally {
      console.log = originalLog;
    }

    expect(logged.join("\n")).toContain("demohunter <command>");
  });

  test("prints a version when called with --version", async () => {
    const stubs = buildStubs();
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (message: unknown) => {
      logged.push(String(message));
    };

    try {
      await runCli(["--version"], "/tmp/demo", stubs);
    } finally {
      console.log = originalLog;
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("treats the workspace .bin symlink as the same entrypoint as the real dist file", () => {
    const realBinPath = "/repo/packages/cli/dist/bin/demohunter.js";
    const symlinkBinPath = "/repo/examples/nextjs-demo/node_modules/.bin/demohunter";

    expect(
      isExecutedAsEntrypoint(
        symlinkBinPath,
        `file://${realBinPath}`,
        (filePath) => (filePath === symlinkBinPath ? realBinPath : filePath),
      ),
    ).toBe(true);
  });
});

describe("runCli review", () => {
  test("dispatches review init with the requested base", async () => {
    const stubs = buildStubs();

    await runCli(["review", "init", "--base", "main"], "/tmp/demo", stubs);

    expect(stubs.reviewInitCommand).toHaveBeenCalledWith("/tmp/demo", {
      baseRef: "main",
      force: false,
    });
  });

  test("dispatches review generate with every flag", async () => {
    const stubs = buildStubs();

    await runCli(
      [
        "review",
        "generate",
        "reviews/pr.review.ts",
        "--base",
        "main",
        "--head",
        "HEAD",
        "--run-verification",
        "--allow-dirty",
        "--no-video",
      ],
      "/tmp/demo",
      stubs,
    );

    expect(stubs.reviewGenerateCommand).toHaveBeenCalledWith("/tmp/demo", "reviews/pr.review.ts", {
      baseRef: "main",
      headRef: "HEAD",
      runVerification: true,
      allowDirty: true,
      skipVideo: true,
    });
  });

  test("dispatches review serve and review verify", async () => {
    const stubs = buildStubs();

    await runCli(["review", "serve", "pr-22-review", "--open", "--port=4321"], "/tmp/demo", stubs);
    await runCli(["review", "verify", "pr-22-review", "--strict"], "/tmp/demo", stubs);

    expect(stubs.reviewServeCommand).toHaveBeenCalledWith("/tmp/demo", "pr-22-review", {
      open: true,
      port: 4321,
    });
    expect(stubs.reviewVerifyCommand).toHaveBeenCalledWith("/tmp/demo", "pr-22-review", {
      strict: true,
    });
  });

  test("rejects an unknown review action", async () => {
    await expect(runCli(["review", "publish"], "/tmp/demo", buildStubs())).rejects.toThrow(
      "Usage: demohunter review <init|generate|serve|verify>",
    );
  });
});

describe("parseReviewArgs", () => {
  test("defaults the base to main and head to the repository HEAD", () => {
    expect(parseReviewArgs("generate", ["reviews/pr.review.ts"]).generate).toEqual({
      baseRef: "main",
      runVerification: false,
      allowDirty: false,
      skipVideo: false,
    });
  });

  test("accepts both --flag value and --flag=value", () => {
    expect(parseReviewArgs("init", ["--base=release/1.x"]).init?.baseRef).toBe("release/1.x");
    expect(parseReviewArgs("init", ["--base", "release/1.x"]).init?.baseRef).toBe("release/1.x");
  });

  test("rejects an unknown flag rather than silently ignoring it", () => {
    // A dropped --base would produce a confident artifact for the wrong range.
    expect(() => parseReviewArgs("generate", ["reviews/pr.review.ts", "--bass", "main"])).toThrow(
      'Unknown "review generate" flag: --bass',
    );
  });

  test("rejects a flag that belongs to another review action", () => {
    expect(() => parseReviewArgs("verify", ["pr-22-review", "--base", "main"])).toThrow(
      'Unknown "review verify" flag: --base',
    );
  });

  test("rejects a missing or repeated flag value", () => {
    expect(() => parseReviewArgs("generate", ["reviews/pr.review.ts", "--base"])).toThrow(
      "--base requires a value",
    );
    expect(() =>
      parseReviewArgs("generate", ["reviews/pr.review.ts", "--base", "main", "--base", "dev"]),
    ).toThrow("--base may only be provided once");
    expect(() => parseReviewArgs("generate", ["reviews/pr.review.ts", "--base", "--head"])).toThrow(
      "--base requires a value",
    );
  });

  test("rejects a value attached to a boolean flag", () => {
    expect(() => parseReviewArgs("verify", ["pr-22-review", "--strict=yes"])).toThrow(
      "--strict does not take a value",
    );
  });

  test("requires a target for generate, serve, and verify", () => {
    expect(() => parseReviewArgs("generate", [])).toThrow(
      "Usage: demohunter review generate <review-file>",
    );
    expect(() => parseReviewArgs("serve", [])).toThrow(
      "Usage: demohunter review serve <review-dir-or-id>",
    );
    expect(() => parseReviewArgs("verify", [])).toThrow(
      "Usage: demohunter review verify <review-dir-or-id>",
    );
  });

  test("rejects more than one positional argument", () => {
    expect(() => parseReviewArgs("verify", ["a", "b"])).toThrow(
      "Usage: demohunter review <init|generate|serve|verify>",
    );
  });

  test("accepts the scaffold path positionally or with --out, but not both", () => {
    expect(parseReviewArgs("init", ["docs/pr.review.ts"]).init?.outputPath).toBe("docs/pr.review.ts");
    expect(parseReviewArgs("init", ["--out", "docs/pr.review.ts"]).init?.outputPath).toBe(
      "docs/pr.review.ts",
    );
    expect(() => parseReviewArgs("init", ["a.ts", "--out", "b.ts"])).toThrow(
      "either positionally or with --out",
    );
  });

  test("validates the serve port", () => {
    expect(parseReviewArgs("serve", ["pr-22-review", "--port", "0"]).serve?.port).toBe(0);
    expect(() => parseReviewArgs("serve", ["pr-22-review", "--port", "70000"])).toThrow(
      "--port requires an integer from 0 to 65535",
    );
    expect(() => parseReviewArgs("serve", ["pr-22-review", "--port", "http"])).toThrow(
      "--port requires an integer from 0 to 65535",
    );
  });
});
