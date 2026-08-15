import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import {
  DEFAULT_DEMOHUNTER_CONFIG,
  DEFAULT_KOKORO_TTS_CONFIG,
  DEFAULT_RECORD_CONFIG,
  DEFAULT_TTS_CONFIG,
} from "../../../sdk/src/index.js";
import { doctorCommand } from "./doctor.js";

describe("doctorCommand", () => {
  test("prints passing checks as JSON", async () => {
    const log = mock(() => {});
    const launch = mock(async () => ({
      close: mock(async () => {}),
    }));

    await doctorCommand("/tmp/project", {
      checkCommand: mock(async () => {}),
      fetch: mock(async () => new Response("ok", { status: 200 })) as never,
      loadConfig: async () => makeLoadedConfig("/tmp/project"),
      log,
      playwright: {
        chromium: { launch } as never,
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      },
    });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((check) => check.name)).toContain("config");
    expect(parsed.checks.map((check) => check.name)).toContain("ffmpeg");
    expect(parsed.checks.map((check) => check.name)).toContain("ffprobe");
    expect(parsed.checks.map((check) => check.name)).toContain("baseURL");
  });

  test("warns without failing when the installed Playwright is older than 1.61", async () => {
    const log = mock(() => {});

    await doctorCommand("/tmp/project", {
      checkCommand: mock(async () => {}),
      fetch: mock(async () => new Response("ok", { status: 200 })) as never,
      getPlaywrightVersion: () => "1.59.1",
      loadConfig: async () => makeLoadedConfig("/tmp/project"),
      log,
      playwright: {
        chromium: { launch: mock(async () => ({ close: mock(async () => {}) })) } as never,
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      },
    });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const playwrightVersion = parsed.checks.find((check) => check.name === "playwright version");

    expect(parsed.ok).toBe(true);
    expect(playwrightVersion?.status).toBe("warn");
    expect(playwrightVersion?.message).toContain("1.61");
  });

  test("passes the Playwright version check when 1.61 or newer is installed", async () => {
    const log = mock(() => {});

    await doctorCommand("/tmp/project", {
      checkCommand: mock(async () => {}),
      fetch: mock(async () => new Response("ok", { status: 200 })) as never,
      getPlaywrightVersion: () => "1.61.0",
      loadConfig: async () => makeLoadedConfig("/tmp/project"),
      log,
      playwright: {
        chromium: { launch: mock(async () => ({ close: mock(async () => {}) })) } as never,
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      },
    });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    const playwrightVersion = parsed.checks.find((check) => check.name === "playwright version");

    expect(playwrightVersion?.status).toBe("pass");
  });

  test("throws after printing JSON when a required check fails", async () => {
    const log = mock(() => {});

    await expect(
      doctorCommand("/tmp/project", {
        checkCommand: mock(async (command) => {
          if (command === "ffmpeg") {
            throw new Error("missing ffmpeg");
          }
        }),
        fetch: mock(async () => new Response("ok", { status: 200 })) as never,
        loadConfig: async () => makeLoadedConfig("/tmp/project"),
        log,
        playwright: {
          chromium: {
            launch: mock(async () => ({
              close: mock(async () => {}),
            })),
          } as never,
          firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
          webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        },
      }),
    ).rejects.toThrow("Doctor found failing checks.");

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const ffmpeg = parsed.checks.find((check) => check.name === "ffmpeg");

    expect(parsed.ok).toBe(false);
    expect(ffmpeg?.status).toBe("fail");
    expect(ffmpeg?.message).toBe("missing ffmpeg");
  });

  test("reports an actionable missing Kokoro executable without an irrelevant OpenAI warning", async () => {
    const log = mock(() => {});

    await expect(doctorCommand("/tmp/project", {
      ...passingDoctorDependencies(),
      accessPath: mock(async () => {}),
      checkCommand: mock(async (command) => {
        if (command === "which") throw new Error("not found");
      }),
      loadConfig: async () => makeKokoroLoadedConfig("/tmp/project", {
        runtime: "command",
        executable: "kokoro",
        modelPath: "/models/kokoro.onnx",
        voicesPath: "/models/voices.bin",
      }),
      log,
    })).rejects.toThrow("Doctor found failing checks.");

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      checks: Array<{ name: string; message: string }>;
    };
    expect(parsed.checks.find((check) => check.name === "kokoro executable")?.message)
      .toContain("kokoro executable not found");
    expect(parsed.checks.some((check) => check.name === "OPENAI_API_KEY")).toBe(false);
  });

  test("accepts model and voices identity from a self-identifying command adapter", async () => {
    const log = mock(() => {});

    await doctorCommand("/tmp/project", {
      ...passingDoctorDependencies(),
      accessPath: mock(async () => {}),
      probeKokoroWorker: mock(async () => readyIdentity()),
      loadConfig: async () => makeKokoroLoadedConfig("/tmp/project", {
        runtime: "command",
        executable: "kokoro",
      }),
      log,
    });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      checks: Array<{ name: string; message: string }>;
    };
    expect(parsed.checks.find((check) => check.name === "kokoro model")?.message).toContain("external command protocol");
    expect(parsed.checks.find((check) => check.name === "kokoro voices")?.message).toContain("external command protocol");
  });

  test("uses a bounded no-synthesis protocol probe for a valid Kokoro selection", async () => {
    const log = mock(() => {});
    const probeKokoroWorker = mock(async () => readyIdentity());
    const accessPath = mock(async () => {});

    await doctorCommand("/tmp/project", {
      ...passingDoctorDependencies(),
      accessPath,
      loadConfig: async () => makeKokoroLoadedConfig("/tmp/project", {
        runtime: "command",
        executable: "kokoro",
        args: ["--literal=$(never-executed)"],
        modelPath: "models/kokoro.onnx",
        voicesPath: "models/voices.bin",
      }),
      log,
      probeKokoroWorker,
    });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((check) => check.name === "kokoro protocol/version/language capability")?.status).toBe("pass");
    expect(probeKokoroWorker).toHaveBeenCalledWith(expect.objectContaining({
      executable: "kokoro",
      args: ["--literal=$(never-executed)"],
      modelPath: "/tmp/project/models/kokoro.onnx",
      voicesPath: "/tmp/project/models/voices.bin",
    }));
    expect(accessPath).toHaveBeenCalledWith("/tmp/project/models/kokoro.onnx", expect.any(Number));
    expect(accessPath).toHaveBeenCalledWith("/tmp/project/models/voices.bin", expect.any(Number));
  });

  test("fails when the worker advertises different assets than the configured files", async () => {
    const log = mock(() => {});
    await expect(doctorCommand("/tmp/project", {
      ...passingDoctorDependencies(),
      accessPath: mock(async () => {}),
      loadConfig: async () => makeKokoroLoadedConfig("/tmp/project", {
        runtime: "command",
        executable: "kokoro",
        modelPath: "models/kokoro.onnx",
        voicesPath: "models/voices.bin",
      }),
      log,
      probeKokoroWorker: mock(async () => ({ ...readyIdentity(), modelSha256: "f".repeat(64) })),
    })).rejects.toThrow("Doctor found failing checks.");

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const handshake = parsed.checks.find((check) => check.name === "kokoro protocol/version/language capability");
    expect(handshake?.status).toBe("fail");
    expect(handshake?.message).toContain("does not match the configured model and voices files");
  });
});

function passingDoctorDependencies() {
  return {
    checkCommand: mock(async () => {}),
    fetch: mock(async () => new Response("ok", { status: 200 })) as never,
    getPlaywrightVersion: () => "1.61.0",
    hashKokoroAsset: mock(async (assetPath: string) => assetPath.includes("voices") ? "b".repeat(64) : "a".repeat(64)),
    statPath: mock(async () => ({ isFile: () => true })) as never,
    playwright: {
      chromium: { launch: mock(async () => ({ close: mock(async () => {}) })) } as never,
      firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
    },
  };
}

function readyIdentity() {
  return {
    protocol: 1 as const,
    op: "ready" as const,
    backendVersion: "fixture-1",
    modelSha256: "a".repeat(64),
    voicesSha256: "b".repeat(64),
  };
}

function makeLoadedConfig(cwd: string) {
  return {
    projectRoot: cwd,
    configPath: path.join(cwd, "demohunter.config.ts"),
    config: {
      baseURL: "http://localhost:3000",
      outputDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.outputDir),
      cacheDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.cacheDir),
      browser: DEFAULT_DEMOHUNTER_CONFIG.browser,
      viewport: DEFAULT_DEMOHUNTER_CONFIG.viewport,
      holdPaddingMs: DEFAULT_DEMOHUNTER_CONFIG.holdPaddingMs,
      record: DEFAULT_RECORD_CONFIG,
      tts: DEFAULT_TTS_CONFIG,
    },
  };
}

function makeKokoroLoadedConfig(
  cwd: string,
  options: {
    runtime: "command";
    executable: string;
    args?: readonly string[];
    modelPath?: string;
    voicesPath?: string;
  },
) {
  return {
    ...makeLoadedConfig(cwd),
    config: {
      ...makeLoadedConfig(cwd).config,
      providers: { tts: [{ name: "kokoro" as const, options }] },
      tts: DEFAULT_KOKORO_TTS_CONFIG,
    },
  };
}
