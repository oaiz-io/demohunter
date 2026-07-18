import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { NarrationProviderPlugin, NarrationRequest } from "@demohunter/tts-core";

import {
  resolveKokoroAssetIdentity,
  resolveKokoroRuntimeIdentity,
  verifyKokoroAssets,
  type KokoroAssetIdentity,
  type KokoroRuntimeIdentity,
} from "./identity-sidecar.js";
import { KOKORO_PROTOCOL_IDENTITY } from "./protocol.js";
import { sealWaveFile } from "./wave.js";
import { KokoroWorkerClient } from "./worker-client.js";

export const KOKORO_LANGUAGES = ["en-us", "en-gb", "es", "fr", "hi", "it", "ja", "pt-br", "zh"] as const;
export type KokoroLanguage = typeof KOKORO_LANGUAGES[number];

export type KokoroPluginOptions = {
  runtime: "command";
  executable: string;
  args?: readonly string[];
  modelPath?: string;
  voicesPath?: string;
  modelVersion?: string;
  backendVersion?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

type PreparedIdentity = KokoroAssetIdentity & {
  key: string;
  modelPath?: string;
  voicesPath?: string;
  backendVersion: string;
};

export function kokoro(options: KokoroPluginOptions): NarrationProviderPlugin {
  if (options.runtime !== "command") throw new Error("Kokoro runtime must be 'command'.");
  const configuredVersion = options.backendVersion ?? options.modelVersion;
  const clientOptions = { ...options, expectedBackendVersion: configuredVersion };
  let client = new KokoroWorkerClient(clientOptions);
  let activeIdentityKey: string | undefined;
  let synthesisTail: Promise<void> = Promise.resolve();
  const identities = new Map<string, PreparedIdentity>();

  return {
    name: "kokoro",
    capabilities: {
      offlineSynthesis: true,
      languages: KOKORO_LANGUAGES,
      outputFormats: ["wav"],
      sampleRates: [24000],
      instructions: "unsupported",
    },
    async prepareRequest(request, context) {
      if (request.format !== "wav") throw new Error("Kokoro output format must be wav.");
      if (request.sampleRate !== 24000) throw new Error("Kokoro sample rate must be 24000 Hz.");
      if (request.instructions.trim() !== "") throw new Error("Kokoro does not support narration instructions.");
      const language = normalizeKokoroLanguage(request.language);
      const speed = normalizeSpeed(request.providerOptions?.speed);
      const modelPath = optionalRuntimeString(options.modelPath ?? request.providerOptions?.modelPath, "modelPath");
      const voicesPath = optionalRuntimeString(options.voicesPath ?? request.providerOptions?.voicesPath, "voicesPath");
      if ((modelPath === undefined) !== (voicesPath === undefined)) {
        throw new Error("Kokoro modelPath and voicesPath must either both be configured or both be omitted for a self-identifying command adapter.");
      }
      const expectedVersion = optionalRuntimeString(
        options.backendVersion ?? options.modelVersion ?? request.providerOptions?.modelVersion,
        "modelVersion",
      );
      const runtimeLocator = JSON.stringify([options.executable, [...(options.args ?? [])], options.cwd ?? ""]);
      let runtimeIdentity: KokoroRuntimeIdentity;
      try {
        const ready = await client.discoverIdentity(context.signal);
        runtimeIdentity = await resolveKokoroRuntimeIdentity({
          cacheDir: context.cacheDir,
          runtimeLocator,
          protocolIdentity: KOKORO_PROTOCOL_IDENTITY,
          expectedBackendVersion: expectedVersion,
          advertised: ready,
        });
      } catch (error) {
        if (!isExecutableNotFound(error)) throw error;
        runtimeIdentity = await resolveKokoroRuntimeIdentity({
          cacheDir: context.cacheDir,
          runtimeLocator,
          protocolIdentity: KOKORO_PROTOCOL_IDENTITY,
          expectedBackendVersion: expectedVersion,
        });
      }
      let identity: KokoroAssetIdentity;
      if (modelPath !== undefined && voicesPath !== undefined) {
        identity = await resolveKokoroAssetIdentity({
          cacheDir: context.cacheDir,
          modelPath,
          voicesPath,
          backendVersion: runtimeIdentity.backendVersion,
          protocolIdentity: KOKORO_PROTOCOL_IDENTITY,
        });
        if (identity.modelSha256 !== runtimeIdentity.modelSha256 || identity.voicesSha256 !== runtimeIdentity.voicesSha256) {
          await client.close().catch(() => undefined);
          client = new KokoroWorkerClient(clientOptions);
          const restarted = await client.discoverIdentity(context.signal);
          runtimeIdentity = await resolveKokoroRuntimeIdentity({
            cacheDir: context.cacheDir,
            runtimeLocator,
            protocolIdentity: KOKORO_PROTOCOL_IDENTITY,
            expectedBackendVersion: expectedVersion,
            advertised: restarted,
          });
          identity = await resolveKokoroAssetIdentity({
            cacheDir: context.cacheDir,
            modelPath,
            voicesPath,
            backendVersion: runtimeIdentity.backendVersion,
            protocolIdentity: KOKORO_PROTOCOL_IDENTITY,
          });
          if (identity.modelSha256 !== runtimeIdentity.modelSha256 || identity.voicesSha256 !== runtimeIdentity.voicesSha256) {
            throw new Error("Kokoro worker identity does not match the configured model and voices files.");
          }
        }
      } else {
        identity = {
          modelSha256: runtimeIdentity.modelSha256,
          voicesSha256: runtimeIdentity.voicesSha256,
          backendVersionSha256: sha256(runtimeIdentity.backendVersion),
          protocolSha256: sha256(KOKORO_PROTOCOL_IDENTITY),
          freshlyVerified: true,
        };
      }
      const portableIdentity = {
        modelSha256: identity.modelSha256,
        voicesSha256: identity.voicesSha256,
        backendVersionSha256: identity.backendVersionSha256,
        protocolSha256: identity.protocolSha256,
      };
      const key = identityKey(portableIdentity);
      identities.set(key, {
        ...identity,
        key,
        ...(modelPath === undefined ? {} : { modelPath }),
        ...(voicesPath === undefined ? {} : { voicesPath }),
        backendVersion: runtimeIdentity.backendVersion,
      });
      activeIdentityKey = key;
      return {
        ...request,
        language,
        format: "wav",
        sampleRate: 24000,
        instructions: "",
        providerOptions: { kokoro: portableIdentity, speed },
      };
    },
    async synthesize(request, context) {
      const portable = readPortableIdentity(request);
      const key = identityKey(portable);
      const identity = identities.get(key);
      if (identity === undefined) throw new Error("Kokoro request was not prepared by this provider instance.");
      const run = async () => {
        if (activeIdentityKey !== key) {
          await client.close().catch(() => undefined);
          client = new KokoroWorkerClient(clientOptions);
          activeIdentityKey = key;
        }
        const ready = await client.discoverIdentity(context.signal);
        if (ready.backendVersion !== identity.backendVersion
          || ready.modelSha256 !== identity.modelSha256
          || ready.voicesSha256 !== identity.voicesSha256) {
          throw new Error("Kokoro worker identity changed after narration preparation; retry to refresh the cache identity.");
        }
        if (identity.modelPath !== undefined && identity.voicesPath !== undefined) {
          await verifyKokoroAssets({ cacheDir: context.cacheDir, modelPath: identity.modelPath, voicesPath: identity.voicesPath, backendVersion: identity.backendVersion, protocolIdentity: KOKORO_PROTOCOL_IDENTITY }, identity);
        }
        context.signal.throwIfAborted();
        const stagingParent = join(resolve(context.cacheDir), ".kokoro", "staging");
        await mkdir(stagingParent, { recursive: true });
        const stagingRoot = await mkdtemp(join(stagingParent, "request-"));
        const outputPath = join(stagingRoot, "worker.wav");
        const sealedPath = join(stagingRoot, `${randomUUID()}.sealed.wav`);
        let returned = false;
        try {
          const response = await client.synthesize({
          text: request.text,
          voice: request.voice,
          language: normalizeKokoroLanguage(request.language),
          speed: normalizeSpeed(request.providerOptions?.speed),
          format: "wav",
          sampleRate: 24000,
          outputPath,
        }, context.signal);
          if (response.path !== outputPath) throw new Error("Kokoro worker returned a path outside the assigned staging output.");
          if (response.format !== "wav" || response.sampleRate !== 24000) throw new Error("Kokoro worker must report WAV at 24,000 Hz.");
          context.signal.throwIfAborted();
          if (identity.modelPath !== undefined && identity.voicesPath !== undefined) {
            await verifyKokoroAssets({ cacheDir: context.cacheDir, modelPath: identity.modelPath, voicesPath: identity.voicesPath, backendVersion: identity.backendVersion, protocolIdentity: KOKORO_PROTOCOL_IDENTITY }, identity);
          }
          await sealWaveFile(outputPath, sealedPath);
          context.signal.throwIfAborted();
          returned = true;
          let finalized = false;
          return {
          request,
          metadata: metadataFor(request),
          output: {
            kind: "file" as const,
            path: sealedPath,
            async finalize() {
              if (finalized) return;
              finalized = true;
              await rm(stagingRoot, { recursive: true, force: true });
            },
          },
          };
        } finally {
          if (!returned) await rm(stagingRoot, { recursive: true, force: true });
        }
      };
      const result = synthesisTail.then(run, run);
      synthesisTail = result.then(() => undefined, () => undefined);
      return result;
    },
    close: async () => {
      await synthesisTail;
      await client.close();
    },
  };
}

export const createKokoroNarrationProviderPlugin = kokoro;

function normalizeKokoroLanguage(language: string | undefined): KokoroLanguage {
  const normalized = language?.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === undefined || normalized === "") throw new Error(`Kokoro language is required. Supported values: ${KOKORO_LANGUAGES.join(", ")}.`);
  if (!(KOKORO_LANGUAGES as readonly string[]).includes(normalized)) throw new Error(`Kokoro does not support language ${JSON.stringify(language)}. Supported values: ${KOKORO_LANGUAGES.join(", ")}.`);
  return normalized as KokoroLanguage;
}

function normalizeSpeed(value: unknown): number {
  const speed = value === undefined ? 1 : value;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0 || speed > 4) throw new Error("Kokoro speed must be a finite number greater than 0 and at most 4.");
  return speed;
}

function optionalRuntimeString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Kokoro ${name} must be provided as a non-empty string.`);
  return value;
}

function isExecutableNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Kokoro executable not found");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readPortableIdentity(request: NarrationRequest): Record<string, string> {
  const value = request.providerOptions?.kokoro;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Kokoro request is missing portable asset identity.");
  const identity = value as Record<string, unknown>;
  for (const name of ["modelSha256", "voicesSha256", "backendVersionSha256", "protocolSha256"]) {
    if (typeof identity[name] !== "string" || !/^[a-f0-9]{64}$/.test(identity[name])) throw new Error("Kokoro request contains invalid portable asset identity.");
  }
  return identity as Record<string, string>;
}

function identityKey(identity: Record<string, string>): string {
  return createHash("sha256").update([
    identity.modelSha256,
    identity.voicesSha256,
    identity.backendVersionSha256,
    identity.protocolSha256,
  ].join(":"), "utf8").digest("hex");
}

function metadataFor(request: NarrationRequest) {
  const { provider, model, voice, format, sampleRate, language, providerOptions } = request;
  return { provider, model, voice, format, sampleRate, ...(language === undefined ? {} : { language }), ...(providerOptions === undefined ? {} : { providerOptions }) };
}
