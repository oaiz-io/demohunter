export const KOKORO_PROTOCOL_VERSION = 1 as const;
export const KOKORO_PROTOCOL_IDENTITY = "demohunter-kokoro-jsonl-v1";
export const DEFAULT_MAX_JSONL_BYTES = 64 * 1024;

export type KokoroReadyMessage = {
  protocol: 1;
  op: "ready";
  backendVersion: string;
};

export type KokoroSynthesisRequest = {
  protocol: 1;
  id: string;
  op: "synthesize";
  text: string;
  voice: string;
  language: string;
  speed: number;
  format: "wav";
  sampleRate: 24000;
  outputPath: string;
};

export type KokoroShutdownRequest = {
  protocol: 1;
  id: string;
  op: "shutdown";
};

export type KokoroResponse =
  | {
      protocol: 1;
      id: string;
      ok: true;
      path?: string;
      format?: "wav";
      sampleRate?: 24000;
    }
  | {
      protocol: 1;
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export function encodeJsonLine(value: object, maxBytes = DEFAULT_MAX_JSONL_BYTES): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > maxBytes) {
    throw new Error(`Kokoro JSONL request exceeds the ${maxBytes}-byte limit.`);
  }
  return line;
}

export function parseReadyMessage(line: string): KokoroReadyMessage {
  const value = parseObject(line, "startup");
  if (
    value.protocol !== KOKORO_PROTOCOL_VERSION
    || value.op !== "ready"
    || typeof value.backendVersion !== "string"
    || value.backendVersion.trim() === ""
  ) {
    throw new Error("Kokoro worker returned an incompatible startup message (protocol v1 required).");
  }
  return value as KokoroReadyMessage;
}

export function parseResponse(line: string): KokoroResponse {
  const value = parseObject(line, "response");
  if (value.protocol !== KOKORO_PROTOCOL_VERSION || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    throw new Error("Kokoro worker returned an invalid protocol-v1 response.");
  }
  if (value.ok) {
    if (value.path !== undefined && typeof value.path !== "string") throw new Error("Kokoro response path is invalid.");
    if (value.format !== undefined && value.format !== "wav") throw new Error("Kokoro worker reported an unsupported output format.");
    if (value.sampleRate !== undefined && value.sampleRate !== 24000) throw new Error("Kokoro worker reported an unsupported sample rate.");
  } else {
    const error = value.error;
    if (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string") {
      throw new Error("Kokoro worker returned an invalid error response.");
    }
  }
  return value as KokoroResponse;
}

function parseObject(line: string, kind: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Kokoro worker emitted malformed JSON during ${kind}.`);
  }
  if (!isRecord(value)) throw new Error(`Kokoro worker emitted a non-object ${kind} message.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
