import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";
import { APIError } from "openai";

import { ContentSpecSchema, type ContentSpec } from "./schema.js";
import { VideoGenError } from "../pipeline/errors.js";
import type { GenerateContentSpecInput } from "../pipeline/types.js";
import { ContentValidationError, validateContentSpec } from "../util/validate.js";

export const DEFAULT_CONTENT_MODEL = "gpt-4o-2024-08-06";
export const CONTENT_REQUEST_TIMEOUT_MS = 45_000;
export const MAX_CONTENT_ATTEMPTS = 3;
export const MAX_BACKOFF_MS = 8_000;



export type ContentGeneratorClient = {
  chat: {
    completions: {
      create: (args: Record<string, unknown>) => Promise<ChatCompletionResult>;
    };
  };
};

type ChatCompletionResult = {
  choices: Array<{
    message?: {
      content?: string | null;
      refusal?: string | null;
    };
  }>;
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
  const openai = new OpenAI({ apiKey, timeout: CONTENT_REQUEST_TIMEOUT_MS });
  return {
    chat: {
      completions: {
        create: (args: Record<string, unknown>) => openai.chat.completions.create(args as any) as any,
      },
    },
  };
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


const CONTENT_SPEC_JSON_SCHEMA = {
  type: "json_schema" as const,
  name: "content_spec",
  strict: true,
  schema: {
      type: "object",
      properties: {
        version: { type: "integer", const: 1 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        duration: { type: "string", pattern: "^\\d+(?:\\.\\d+)?(?:s|m)$" },
        slides: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              heading: { type: "string", minLength: 1, maxLength: 200 },
              body: {
                type: "array",
                minItems: 1,
                maxItems: 12,
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["paragraph", "bullet_list", "code_block"], description: "paragraph: use 'text'. bullet_list: use 'items' array. code_block: use 'language' and 'code'." },
                    text: { type: "string" },
                    items: { type: "array", items: { type: "string" } },
                    language: { type: "string" },
                    code: { type: "string" },
                  },
                  required: ["type"],
                  additionalProperties: false,
                },
              },
              narration: { type: "string", minLength: 1, maxLength: 2000 },
              transition: { type: "string", enum: ["fade", "slide-left"] },
            },
            required: ["id", "heading", "body", "narration", "transition"],
            additionalProperties: false,
          },
        },
      },
      required: ["version", "title", "duration", "slides"],
      additionalProperties: false,
    },
};

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
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: buildUserMessage(input.prompt, correctiveHint),
          },
        ],
        temperature: 0.3,
        max_tokens: 4000,
      });

      const message = response.choices?.[0]?.message;
      const refusal = message?.refusal;
      if (refusal !== undefined && refusal !== null && refusal.trim() !== "") {
        throw new VideoGenError("CONTENT_REFUSED", `The model refused to generate content: ${refusal}`);
      }

      const rawContent = message?.content;
      if (rawContent === undefined || rawContent === null || rawContent.trim() === "") {
        throw new VideoGenError("CONTENT_FAILED", "Content generation returned empty output.");
      }

      let parsed: unknown;
      try {
        const jsonText = extractJsonBlock(rawContent);
        parsed = JSON.parse(jsonText);
      } catch (error) {
        throw new VideoGenError(
          "CONTENT_FAILED",
          `Failed to parse content as JSON. The model returned: ${rawContent.slice(0, 200)}...`,
          { cause: error },
        );
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

function extractJsonBlock(text: string): string {
  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  // Try to find JSON object boundaries
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }
  return text.trim();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new VideoGenError("INTERRUPTED", "Content generation was cancelled.");
  }
}
