import { describe, expect, mock, test } from "bun:test";

import { isExecutedAsEntrypoint, runCli } from "./demohunter.js";

function buildStubs(overrides: Partial<Parameters<typeof runCli>[2]> = {}): Parameters<typeof runCli>[2] {
  return {
    cacheCommand: mock(async () => {}),
    doctorCommand: mock(async () => {}),
    initCommand: mock(async () => {}),
    generateCommand: mock(async () => {}),
    addSkillCommand: mock(async () => {}),
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
