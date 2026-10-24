import { access } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_DEMOHUNTER_CONFIG,
  DEFAULT_COOKIE_BANNER_CONFIG,
  DEFAULT_CURSOR_CONFIG,
  DEFAULT_ELEVENLABS_TTS_CONFIG,
  DEFAULT_OUTPUT_CONFIG,
  DEFAULT_RECORD_CONFIG,
  DEFAULT_TTS_CONFIG,
  resolveOutputFormatRequests,
} from "@demohunter/sdk";
import type {
  CookieBannerConfig,
  DemoHunterUserConfig,
  ResolvedDemoHunterConfig,
} from "@demohunter/sdk";

import { loadAuthoredModule } from "../utils/load-authored-module.js";

export type LoadedConfig = {
  projectRoot: string;
  configPath: string;
  config: ResolvedDemoHunterConfig;
};

export const STORAGE_STATE_ENV = "DEMOHUNTER_STORAGE_STATE";

export async function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const projectRoot = path.resolve(cwd);
  const configPath = path.join(projectRoot, "demohunter.config.ts");

  await assertConfigExists(configPath, projectRoot);

  const configModule = await loadAuthoredModule(configPath);
  const authoredConfig = readDefaultExport(configModule.default);
  validateAuthoredRecordConfig(authoredConfig.record);
  validateAuthoredOutputConfig(authoredConfig.output);
  validateAuthoredSessionConfig(authoredConfig.session);
  validateAuthoredLaunchConfig(authoredConfig.launch, authoredConfig.browser ?? DEFAULT_DEMOHUNTER_CONFIG.browser);

  const outputDir = resolveProjectPath(projectRoot, authoredConfig.outputDir ?? DEFAULT_DEMOHUNTER_CONFIG.outputDir);
  const cacheDir = resolveProjectPath(projectRoot, authoredConfig.cacheDir ?? DEFAULT_DEMOHUNTER_CONFIG.cacheDir);
  const session = resolveSessionConfig(projectRoot, authoredConfig.session, env, { outputDir, cacheDir });

  const config: ResolvedDemoHunterConfig = {
    baseURL: authoredConfig.baseURL,
    outputDir,
    cacheDir,
    browser: authoredConfig.browser ?? DEFAULT_DEMOHUNTER_CONFIG.browser,
    viewport: authoredConfig.viewport ?? DEFAULT_DEMOHUNTER_CONFIG.viewport,
    holdPaddingMs: authoredConfig.holdPaddingMs ?? DEFAULT_DEMOHUNTER_CONFIG.holdPaddingMs,
    record: {
      ...DEFAULT_RECORD_CONFIG,
      ...authoredConfig.record,
      container: authoredConfig.record?.container
        ?? authoredConfig.record?.format
        ?? DEFAULT_RECORD_CONFIG.container,
      format: authoredConfig.record?.container
        ?? authoredConfig.record?.format
        ?? DEFAULT_RECORD_CONFIG.container,
      cookieBanners: resolveCookieBannerConfig(authoredConfig.record?.cookieBanners),
      cursor: resolveCursorConfig(authoredConfig.record),
    },
    output: {
      formats: resolveOutputFormatRequests(authoredConfig.output?.formats ?? DEFAULT_OUTPUT_CONFIG.formats),
    },
    tts: resolveTTSConfig(authoredConfig.tts),
    ...(session === undefined ? {} : { session }),
    ...(authoredConfig.launch === undefined ? {} : { launch: { ...authoredConfig.launch } }),
  };

  return {
    projectRoot,
    configPath,
    config,
  };
}

function validateAuthoredSessionConfig(session: DemoHunterUserConfig["session"]): void {
  if (session === undefined) {
    return;
  }
  if (!isRecordObject(session)) {
    throw new Error("session must be an object with a storageState path");
  }
  if (typeof session.storageState !== "string" || session.storageState.trim().length === 0) {
    throw new Error("session.storageState must be a non-empty path to a Playwright storage-state file");
  }
  assertNoHomeShorthand(session.storageState, "session.storageState");
}

// Node does not expand "~", so "~/sessions/app.json" would resolve to a
// directory literally named "~" inside the project.
export function assertNoHomeShorthand(authoredPath: string, name: string): void {
  if (authoredPath.startsWith("~")) {
    throw new Error(
      `${name} starts with "~", which DemoHunter does not expand. Use an absolute path or a path relative to the project root.`,
    );
  }
}

const LAUNCH_OPTIONS = ["channel", "headless", "locale", "timezoneId"] as const;

function validateAuthoredLaunchConfig(
  launch: DemoHunterUserConfig["launch"],
  browser: ResolvedDemoHunterConfig["browser"],
): void {
  if (launch === undefined) {
    return;
  }
  if (!isRecordObject(launch)) {
    throw new Error("launch must be an object");
  }

  // Arbitrary browser arguments are intentionally unsupported.
  for (const key of Object.keys(launch)) {
    if (!(LAUNCH_OPTIONS as readonly string[]).includes(key)) {
      throw new Error(`Unsupported launch option: ${key}. Expected one of ${LAUNCH_OPTIONS.join(", ")}.`);
    }
  }
  for (const field of ["channel", "locale", "timezoneId"] as const) {
    const value = launch[field];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`launch.${field} must be a non-empty string`);
    }
  }
  if (launch.headless !== undefined && typeof launch.headless !== "boolean") {
    throw new Error("launch.headless must be a boolean");
  }
  if (launch.channel !== undefined && browser !== "chromium") {
    throw new Error(`launch.channel requires browser "chromium"; the configured browser is "${browser}"`);
  }
}

function resolveSessionConfig(
  projectRoot: string,
  authoredSession: DemoHunterUserConfig["session"],
  env: NodeJS.ProcessEnv,
  portableDirs: { outputDir: string; cacheDir: string },
): ResolvedDemoHunterConfig["session"] {
  const envPath = env[STORAGE_STATE_ENV]?.trim();
  if (envPath) {
    assertNoHomeShorthand(envPath, STORAGE_STATE_ENV);
  }
  const session: ResolvedDemoHunterConfig["session"] = envPath
    ? { storageState: resolveProjectPath(projectRoot, envPath), source: "env" }
    : authoredSession === undefined
      ? undefined
      : { storageState: resolveProjectPath(projectRoot, authoredSession.storageState), source: "config" };

  if (session === undefined) {
    return undefined;
  }

  // Generated output is meant to be shared; a storage-state file is a bearer credential.
  for (const [name, directory] of Object.entries(portableDirs)) {
    if (isPathInside(session.storageState, directory)) {
      throw new Error(
        `${session.source === "env" ? STORAGE_STATE_ENV : "session.storageState"} must not point inside ${name} (${directory}). Keep the session file outside generated output, for example in ../.demohunter-sessions/.`,
      );
    }
  }

  return session;
}

export function isPathInside(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);

  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateAuthoredRecordConfig(record: DemoHunterUserConfig["record"]): void {
  if (record === undefined) {
    return;
  }
  if (!isRecordObject(record)) {
    throw new Error("record must be an object");
  }

  for (const [field, value] of [
    ["container", record.container],
    ["format", record.format],
  ] as const) {
    if (value !== undefined && value !== "mp4" && value !== "webm") {
      throw new Error(`record.${field} must be either mp4 or webm`);
    }
  }

  for (const [field, value] of [
    ["showActions", record.showActions],
    ["showChapters", record.showChapters],
    ["showCursor", record.showCursor],
    ["showClickRipple", record.showClickRipple],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`record.${field} must be a boolean`);
    }
  }

  if (
    record.highlightStyle !== undefined
    && record.highlightStyle !== "ring"
    && record.highlightStyle !== "spotlight"
  ) {
    throw new Error("record.highlightStyle must be either ring or spotlight");
  }

  if (
    record.cursor !== undefined
    && record.cursor !== false
    && !isRecordObject(record.cursor)
  ) {
    throw new Error("record.cursor must be false or an object");
  }
}

function validateAuthoredOutputConfig(output: DemoHunterUserConfig["output"]): void {
  if (output !== undefined && !isRecordObject(output)) {
    throw new Error("output must be an object");
  }
}

function resolveCookieBannerConfig(
  authoredConfig: Partial<CookieBannerConfig> | undefined,
): CookieBannerConfig {
  if (
    authoredConfig !== undefined
    && (typeof authoredConfig !== "object" || authoredConfig === null || Array.isArray(authoredConfig))
  ) {
    throw new Error("record.cookieBanners must be an object");
  }

  const enabled = authoredConfig?.enabled ?? DEFAULT_COOKIE_BANNER_CONFIG.enabled;
  const action = authoredConfig?.action ?? DEFAULT_COOKIE_BANNER_CONFIG.action;
  const timeoutMs = authoredConfig?.timeoutMs ?? DEFAULT_COOKIE_BANNER_CONFIG.timeoutMs;
  const additionalSelectors = authoredConfig?.additionalSelectors
    ?? DEFAULT_COOKIE_BANNER_CONFIG.additionalSelectors;

  if (typeof enabled !== "boolean") {
    throw new Error("record.cookieBanners.enabled must be a boolean");
  }
  if (action !== "reject" && action !== "accept" && action !== "hide") {
    throw new Error(
      `Invalid record.cookieBanners.action: ${String(action)}. Expected reject, accept, or hide.`,
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("record.cookieBanners.timeoutMs must be a non-negative finite number");
  }
  if (
    !Array.isArray(additionalSelectors)
    || !additionalSelectors.every(
      (selector): selector is string => typeof selector === "string" && selector.trim().length > 0,
    )
  ) {
    throw new Error("record.cookieBanners.additionalSelectors must contain only non-empty strings");
  }

  return {
    enabled,
    action,
    timeoutMs,
    additionalSelectors: [...additionalSelectors],
  };
}

function resolveCursorConfig(
  record: DemoHunterUserConfig["record"],
): ResolvedDemoHunterConfig["record"]["cursor"] {
  if (record?.cursor === false) {
    return false;
  }

  // Preserve the legacy ability to hide the custom cursor while retaining an
  // independently configured click ripple. An explicit cursor:false uses the
  // new semantics and disables the entire cursor system.
  if (record?.cursor === undefined && record?.showCursor === false) {
    return undefined;
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
  if (cursor.mode !== "highlight" && cursor.mode !== "smooth") {
    throw new Error("record.cursor.mode must be either highlight or smooth");
  }
  if (cursor.shape !== "dot" && cursor.shape !== "pointer") {
    throw new Error("record.cursor.shape must be either dot or pointer");
  }
  if (typeof cursor.color !== "string" || cursor.color.trim().length === 0) {
    throw new Error("record.cursor.color must be a non-empty string");
  }
  if (typeof cursor.ripple !== "boolean") {
    throw new Error("record.cursor.ripple must be a boolean");
  }
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

function isRecordObject(value: unknown): boolean {
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
