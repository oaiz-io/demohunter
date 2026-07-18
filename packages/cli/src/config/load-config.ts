import { access } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_DEMOHUNTER_CONFIG,
  DEFAULT_COOKIE_BANNER_CONFIG,
  DEFAULT_CURSOR_CONFIG,
  DEFAULT_ELEVENLABS_TTS_CONFIG,
  DEFAULT_RECORD_CONFIG,
  DEFAULT_TTS_CONFIG,
} from "@demohunter/sdk";
import type {
  DemoHunterUserConfig,
  ResolvedDemoHunterConfig,
} from "@demohunter/sdk";

import { loadAuthoredModule } from "../utils/load-authored-module.js";

export type LoadedConfig = {
  projectRoot: string;
  configPath: string;
  config: ResolvedDemoHunterConfig;
};

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const projectRoot = path.resolve(cwd);
  const configPath = path.join(projectRoot, "demohunter.config.ts");

  await assertConfigExists(configPath, projectRoot);

  const configModule = await loadAuthoredModule(configPath);
  const authoredConfig = readDefaultExport(configModule.default);

  const config: ResolvedDemoHunterConfig = {
    baseURL: authoredConfig.baseURL,
    outputDir: resolveProjectPath(projectRoot, authoredConfig.outputDir ?? DEFAULT_DEMOHUNTER_CONFIG.outputDir),
    cacheDir: resolveProjectPath(projectRoot, authoredConfig.cacheDir ?? DEFAULT_DEMOHUNTER_CONFIG.cacheDir),
    browser: authoredConfig.browser ?? DEFAULT_DEMOHUNTER_CONFIG.browser,
    viewport: authoredConfig.viewport ?? DEFAULT_DEMOHUNTER_CONFIG.viewport,
    holdPaddingMs: authoredConfig.holdPaddingMs ?? DEFAULT_DEMOHUNTER_CONFIG.holdPaddingMs,
    record: {
      ...DEFAULT_RECORD_CONFIG,
      ...authoredConfig.record,
      cookieBanners: {
        ...DEFAULT_COOKIE_BANNER_CONFIG,
        ...authoredConfig.record?.cookieBanners,
        additionalSelectors: [
          ...(authoredConfig.record?.cookieBanners?.additionalSelectors
            ?? DEFAULT_COOKIE_BANNER_CONFIG.additionalSelectors),
        ],
      },
      cursor: resolveCursorConfig(authoredConfig.record),
    },
    tts: resolveTTSConfig(authoredConfig.tts),
  };

  return {
    projectRoot,
    configPath,
    config,
  };
}

function resolveCursorConfig(
  record: DemoHunterUserConfig["record"],
): ResolvedDemoHunterConfig["record"]["cursor"] {
  if (record?.cursor === false || (record?.cursor === undefined && record?.showCursor === false)) {
    return false;
  }

  if (record?.cursor !== undefined) {
    return validateCursorConfig({
      ...DEFAULT_CURSOR_CONFIG,
      ...record.cursor,
    });
  }

  return validateCursorConfig({
    ...DEFAULT_CURSOR_CONFIG,
    ripple: record?.showClickRipple ?? DEFAULT_CURSOR_CONFIG.ripple,
  });
}

function validateCursorConfig(
  cursor: Exclude<ResolvedDemoHunterConfig["record"]["cursor"], false | undefined>,
): Exclude<ResolvedDemoHunterConfig["record"]["cursor"], false | undefined> {
  if (!Number.isFinite(cursor.sizePx) || cursor.sizePx <= 0) {
    throw new Error("record.cursor.sizePx must be a positive finite number");
  }
  if (!Number.isFinite(cursor.minDurationMs) || cursor.minDurationMs < 0) {
    throw new Error("record.cursor.minDurationMs must be a non-negative finite number");
  }
  if (!Number.isFinite(cursor.maxDurationMs) || cursor.maxDurationMs < cursor.minDurationMs) {
    throw new Error("record.cursor.maxDurationMs must be finite and at least minDurationMs");
  }
  if (!Number.isFinite(cursor.pixelsPerMs) || cursor.pixelsPerMs <= 0) {
    throw new Error("record.cursor.pixelsPerMs must be a positive finite number");
  }
  if (!Number.isFinite(cursor.arcHeightPx) || cursor.arcHeightPx < 0) {
    throw new Error("record.cursor.arcHeightPx must be a non-negative finite number");
  }

  return cursor;
}

async function assertConfigExists(configPath: string, cwd: string): Promise<void> {
  try {
    await access(configPath);
  } catch {
    throw new Error(`Could not find demohunter.config.ts in ${cwd}`);
  }
}

function readDefaultExport(config: unknown): DemoHunterUserConfig {
  if (!isPlainObject(config) || typeof config.baseURL !== "string") {
    throw new Error("demohunter.config.ts must default export an object with a string baseURL");
  }

  return config;
}

function isPlainObject(value: unknown): value is DemoHunterUserConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveProjectPath(projectRoot: string, authoredPath: string): string {
  if (path.isAbsolute(authoredPath)) {
    return authoredPath;
  }

  return path.resolve(projectRoot, authoredPath);
}

function resolveTTSConfig(authoredTTS: DemoHunterUserConfig["tts"]): ResolvedDemoHunterConfig["tts"] {
  if (authoredTTS?.provider === "elevenlabs") {
    return {
      ...DEFAULT_ELEVENLABS_TTS_CONFIG,
      ...authoredTTS,
    };
  }

  return {
    ...DEFAULT_TTS_CONFIG,
    ...authoredTTS,
    provider: "openai",
  };
}
