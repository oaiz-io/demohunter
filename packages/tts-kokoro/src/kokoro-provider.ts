import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { NarrationProviderPlugin, NarrationRequest } from "@demohunter/tts-core";

import { resolveKokoroAssetIdentity, verifyKokoroAssets, type KokoroAssetIdentity } from "./identity-sidecar.js";
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

type PreparedIdentity = KokoroAssetIdentity & { key: string; modelPath: string; voicesPath: string; backendVersion: string };

export function kokoro(options: KokoroPluginOptions): NarrationProviderPlugin {
  if (options.runtime !== "command") throw new Error("Kokoro runtime must be 'command'.");
  const client = new KokoroWorkerClient({ ...options, expectedBackendVersion: options.backendVersion });
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
      const modelPath = readRuntimeString(options.modelPath ?? request.providerOptions?.modelPath, "modelPath");
      const voicesPath = readRuntimeString(options.voicesPath ?? request.providerOptions?.voicesPath, "voicesPath");
      const backendVersion = readRuntimeString(options.backendVersion ?? options.modelVersion ?? request.providerOptions?.modelVersion ?? "kokoro-onnx", "modelVersion");
      const identity = await resolveKokoroAssetIdentity({
        cacheDir: context.cacheDir,
        modelPath,
        voicesPath,
        backendVersion,
        protocolIdentity: KOKORO_PROTOCOL_IDENTITY,
      });
      const portableIdentity = {
        modelSha256: identity.modelSha256,
        voicesSha256: identity.voicesSha256,
        backendVersionSha256: identity.backendVersionSha256,
        protocolSha256: identity.protocolSha256,
      };
      const key = identityKey(portableIdentity);
      identities.set(key, { ...identity, key, modelPath, voicesPath, backendVersion });
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
      await verifyKokoroAssets({ cacheDir: context.cacheDir, modelPath: identity.modelPath, voicesPath: identity.voicesPath, backendVersion: identity.backendVersion, protocolIdentity: KOKORO_PROTOCOL_IDENTITY }, identity);
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
        await sealWaveFile(outputPath, sealedPath);
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
    },
    close: async () => client.close(),
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

function readRuntimeString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Kokoro ${name} must be provided as a non-empty string.`);
  return value;
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
