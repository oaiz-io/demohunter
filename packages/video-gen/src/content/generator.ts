import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { APIError } from "openai";

import { ContentSpecSchema, type ContentSpec } from "./schema.js";
import { VideoGenError } from "../pipeline/errors.js";
import type { GenerateContentSpecInput } from "../pipeline/types.js";
import { ContentValidationError, validateContentSpec } from "../util/validate.js";

export const DEFAULT_CONTENT_MODEL = "gpt-4o-2024-08-06";
export const CONTENT_REQUEST_TIMEOUT_MS = 45_000;
export const MAX_CONTENT_ATTEMPTS = 3;
export const MAX_BACKOFF_MS = 8_000;

type ResponsesParseResult = {
  output_parsed?: unknown;
  refusal?: string | null;
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; refusal?: string; text?: string }>;
  }>;
};

export type ContentGeneratorClient = {
  responses: {
    parse: (args: Record<string, unknown>) => Promise<ResponsesParseResult>;
  };
};

export type ContentGeneratorDependencies = {
  createClient?: () => ContentGeneratorClient;
  loadSystemPrompt?: () => string;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  env?: NodeJS.ProcessEnv;
};

const PACKAGE_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultLoadSystemPrompt(): string {
  const candidates = [
    path.join(PACKAGE_SRC_ROOT, "content", "prompts", "system.txt"),
    path.join(PACKAGE_SRC_ROOT, "..", "dist", "content", "prompts", "system.txt"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // continue
    }
  }
  throw new Error("Unable to load content system prompt");
}

function defaultCreateClient(env: NodeJS.ProcessEnv): ContentGeneratorClient {
  const apiKey = env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new VideoGenError(
      "PREFLIGHT_FAILED",
      "OPENAI_API_KEY is not set. Export it in your environment before generating content.",
    );
  }
  return new OpenAI({ apiKey, timeout: CONTENT_REQUEST_TIMEOUT_MS }) as unknown as ContentGeneratorClient;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new VideoGenError("INTERRUPTED", "Content generation was cancelled."));
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function generateContentSpec(
  input: GenerateContentSpecInput,
  dependencies: ContentGeneratorDependencies = {},
): Promise<ContentSpec> {
  const env = dependencies.env ?? process.env;
  const createClient = dependencies.createClient ?? (() => defaultCreateClient(env));
  const loadSystemPrompt = dependencies.loadSystemPrompt ?? defaultLoadSystemPrompt;
  const sleep = dependencies.sleep ?? defaultSleep;
  const random = dependencies.random ?? Math.random;
  const client = createClient();
  const systemPrompt = loadSystemPrompt();
  const model = input.model?.trim() || DEFAULT_CONTENT_MODEL;

  let attempt = 0;
  let correctiveHint: string | undefined;
  let lastError: unknown;

  while (attempt < MAX_CONTENT_ATTEMPTS) {
    attempt += 1;
    throwIfAborted(input.signal);

    try {
      const response = await client.responses.parse({
        model,
        input: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: buildUserMessage(input.prompt, correctiveHint),
          },
        ],
        text: {
          format: zodTextFormat(ContentSpecSchema, "content_spec"),
        },
      });

      const refusal = extractRefusal(response);
      if (refusal !== undefined) {
        throw new VideoGenError("CONTENT_REFUSED", `The model refused to generate content: ${refusal}`);
      }

      const parsed = response.output_parsed;
      if (parsed === undefined || parsed === null) {
        throw new VideoGenError("CONTENT_FAILED", "Content generation returned no parsed output.");
      }

      const schemaParsed = ContentSpecSchema.safeParse(parsed);
      if (!schemaParsed.success) {
        const message = schemaParsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new ContentValidationError(
          schemaParsed.error.issues.map((issue) => ({
            path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
            message: issue.message,
          })),
        );
      }

      try {
        return validateContentSpec(schemaParsed.data);
      } catch (error) {
        if (error instanceof ContentValidationError && correctiveHint === undefined) {
          correctiveHint = error.message;
          lastError = error;
          continue;
        }
        throw new VideoGenError("SPEC_INVALID", error instanceof Error ? error.message : String(error), {
          cause: error,
        });
      }
    } catch (error) {
      lastError = error;
      if (error instanceof VideoGenError && error.code === "CONTENT_REFUSED") {
        throw error;
      }
      if (error instanceof VideoGenError && error.code === "INTERRUPTED") {
        throw error;
      }
      if (error instanceof ContentValidationError && correctiveHint === undefined) {
        correctiveHint = error.message;
        continue;
      }
      if (!isRetryableError(error) || attempt >= MAX_CONTENT_ATTEMPTS) {
        throw toContentError(error, attempt);
      }
      const delayMs = computeBackoffMs(attempt, error, random);
      await sleep(delayMs, input.signal);
    }
  }

  throw toContentError(lastError, attempt);
}

function buildUserMessage(prompt: string, correctiveHint?: string): string {
  if (correctiveHint === undefined) {
    return prompt;
  }
  return `${prompt}\n\nYour previous response failed validation. Fix only these issues and return valid JSON for the schema:\n${correctiveHint}`;
}

function extractRefusal(response: ResponsesParseResult): string | undefined {
  if (typeof response.refusal === "string" && response.refusal.trim() !== "") {
    return response.refusal.trim();
  }
  for (const item of response.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.refusal === "string" && part.refusal.trim() !== "") {
        return part.refusal.trim();
      }
    }
  }
  return undefined;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof VideoGenError) {
    return error.code === "CONTENT_FAILED";
  }
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403 || error.status === 400 || error.status === 404) {
      return false;
    }
    if (error.status === 408 || error.status === 409 || error.status === 429) {
      return true;
    }
    if (error.status !== undefined && error.status >= 500) {
      return true;
    }
    return false;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("timeout")
      || message.includes("network")
      || message.includes("econnreset")
      || message.includes("fetch failed")
    );
  }
  return false;
}

function computeBackoffMs(
  attempt: number,
  error: unknown,
  random: () => number,
): number {
  const retryAfter = readRetryAfterMs(error);
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, MAX_BACKOFF_MS);
  }
  const base = Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = Math.floor(random() * 250);
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof APIError)) {
    return undefined;
  }
  const header = error.headers?.get?.("retry-after");
  if (header === undefined || header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.min(seconds * 1000, MAX_BACKOFF_MS);
}

function toContentError(error: unknown, attempt: number): VideoGenError {
  if (error instanceof VideoGenError) {
    return error;
  }
  if (error instanceof ContentValidationError) {
    return new VideoGenError("SPEC_INVALID", error.message, { cause: error });
  }
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) {
      return new VideoGenError(
        "CONTENT_FAILED",
        "OpenAI authentication failed. Check OPENAI_API_KEY.",
        { cause: error },
      );
    }
    if (error.status === 400 || error.status === 404) {
      return new VideoGenError(
        "CONTENT_FAILED",
        `OpenAI rejected the content request: ${error.message}`,
        { cause: error },
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VideoGenError(
    "CONTENT_FAILED",
    `Content generation failed after ${attempt} attempt(s): ${message}`,
    { cause: error },
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new VideoGenError("INTERRUPTED", "Content generation was cancelled.");
  }
}
