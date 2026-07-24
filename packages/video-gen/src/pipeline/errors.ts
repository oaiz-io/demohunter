export type VideoGenErrorCode =
  | "INVALID_INPUT"
  | "PREFLIGHT_FAILED"
  | "CONTENT_REFUSED"
  | "CONTENT_FAILED"
  | "SPEC_INVALID"
  | "WORKSPACE_COLLISION"
  | "RENDER_FAILED"
  | "COMPILE_FAILED"
  | "SERVER_FAILED"
  | "DEMOHUNTER_FAILED"
  | "INTERRUPTED";

export class VideoGenError extends Error {
  readonly code: VideoGenErrorCode;
  readonly cause?: unknown;
  readonly details?: string[];

  constructor(
    code: VideoGenErrorCode,
    message: string,
    options?: { cause?: unknown; details?: string[] },
  ) {
    super(message);
    this.name = "VideoGenError";
    this.code = code;
    this.cause = options?.cause;
    this.details = options?.details;
  }
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/g,
  /OPENAI_API_KEY\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

export function formatCliError(error: unknown): string {
  if (error instanceof VideoGenError) {
    const lines = [`[${error.code}] ${redactSecrets(error.message)}`];
    if (error.details !== undefined) {
      for (const detail of error.details) {
        lines.push(`  - ${redactSecrets(detail)}`);
      }
    }
    return lines.join("\n");
  }

  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}
