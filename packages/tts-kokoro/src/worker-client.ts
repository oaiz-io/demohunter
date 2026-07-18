import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  DEFAULT_MAX_JSONL_BYTES,
  encodeJsonLine,
  KOKORO_PROTOCOL_VERSION,
  parseReadyMessage,
  parseResponse,
  type KokoroReadyMessage,
  type KokoroResponse,
  type KokoroSynthesisRequest,
} from "./protocol.js";

export type KokoroWorkerClientOptions = {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  expectedBackendVersion?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
};

export type KokoroSynthesizeInput = Omit<KokoroSynthesisRequest, "protocol" | "id" | "op">;

/** A worker could not become ready, so a previously verified identity may be used for cache lookup only. */
export class KokoroWorkerUnavailableError extends Error {
  override readonly name = "KokoroWorkerUnavailableError";
}

/** The worker answered, but its protocol or identity is unsafe to trust. */
export class KokoroWorkerIdentityError extends Error {
  override readonly name = "KokoroWorkerIdentityError";
}

type Waiter = { resolve(line: string): void; reject(error: unknown): void };

export class KokoroWorkerClient {
  readonly #options: Required<Pick<KokoroWorkerClientOptions, "startupTimeoutMs" | "requestTimeoutMs" | "shutdownTimeoutMs" | "maxLineBytes" | "maxStderrBytes">> & KokoroWorkerClientOptions;
  #session?: WorkerSession;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: KokoroWorkerClientOptions) {
    if (options.executable.trim() === "") throw new Error("Kokoro executable must be a non-empty path or command name.");
    this.#options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_JSONL_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
    };
    for (const [name, value] of Object.entries({
      startupTimeoutMs: this.#options.startupTimeoutMs,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      shutdownTimeoutMs: this.#options.shutdownTimeoutMs,
      maxLineBytes: this.#options.maxLineBytes,
      maxStderrBytes: this.#options.maxStderrBytes,
    })) if (!Number.isInteger(value) || value <= 0) throw new Error(`Kokoro ${name} must be a positive integer.`);
  }

  synthesize(input: KokoroSynthesizeInput, signal: AbortSignal): Promise<Extract<KokoroResponse, { ok: true }>> {
    if (this.#closed) return Promise.reject(new Error("Kokoro worker client is closed."));
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const run = async () => {
      try {
        signal.throwIfAborted();
        const session = await this.#getSession(signal);
        const id = randomUUID();
        const request: KokoroSynthesisRequest = { protocol: 1, id, op: "synthesize", ...input };
        const linePromise = session.nextLine(this.#options.requestTimeoutMs, "request", signal);
        session.write(encodeJsonLine(request, this.#options.maxLineBytes));
        const response = parseResponse(await linePromise);
        if (response.id !== id) throw new Error(`Kokoro worker response ID ${JSON.stringify(response.id)} did not match request ${JSON.stringify(id)}.`);
        if (!response.ok) throw new Error(`Kokoro worker ${response.error.code}: ${response.error.message}`);
        return response as Extract<KokoroResponse, { ok: true }>;
      } catch (error) {
        await this.#discardSession();
        throw error;
      }
    };
    return this.#enqueue(run, signal);
  }

  discoverIdentity(signal: AbortSignal): Promise<KokoroReadyMessage> {
    if (this.#closed) return Promise.reject(new Error("Kokoro worker client is closed."));
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    return this.#enqueue(async () => {
      signal.throwIfAborted();
      const session = await this.#getSession(signal);
      if (session.ready === undefined) throw new Error("Kokoro worker session has no verified identity.");
      return session.ready;
    }, signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    const session = this.#session;
    this.#session = undefined;
    if (session === undefined) return;
    const id = randomUUID();
    try {
      const responsePromise = session.nextLine(this.#options.shutdownTimeoutMs, "shutdown");
      session.write(encodeJsonLine({ protocol: KOKORO_PROTOCOL_VERSION, id, op: "shutdown" }, this.#options.maxLineBytes));
      const response = parseResponse(await responsePromise);
      if (response.id !== id || !response.ok) throw new Error("Kokoro worker rejected shutdown.");
      await session.waitForExit(this.#options.shutdownTimeoutMs);
    } catch (error) {
      session.kill();
      await session.waitForExit(this.#options.shutdownTimeoutMs).catch(() => undefined);
      throw error;
    } finally {
      session.dispose();
    }
  }

  async #getSession(signal: AbortSignal): Promise<WorkerSession> {
    if (this.#session !== undefined && !this.#session.exited) return this.#session;
    const session = new WorkerSession(this.#options);
    this.#session = session;
    try {
      const line = await session.nextLine(this.#options.startupTimeoutMs, "startup", signal);
      let ready: KokoroReadyMessage;
      try {
        ready = parseReadyMessage(line);
      } catch (error) {
        throw new KokoroWorkerIdentityError(
          error instanceof Error ? error.message : "Kokoro worker returned an invalid startup identity.",
          { cause: error },
        );
      }
      if (this.#options.expectedBackendVersion !== undefined && ready.backendVersion !== this.#options.expectedBackendVersion) {
        throw new KokoroWorkerIdentityError(`Kokoro worker backend version ${JSON.stringify(ready.backendVersion)} does not match required version ${JSON.stringify(this.#options.expectedBackendVersion)}.`);
      }
      session.ready = ready;
      return session;
    } catch (error) {
      session.kill();
      session.dispose();
      if (this.#session === session) this.#session = undefined;
      if (error instanceof KokoroWorkerIdentityError || isAbortError(error)) throw error;
      throw new KokoroWorkerUnavailableError(
        error instanceof Error ? error.message : "Kokoro worker was unavailable during startup.",
        { cause: error },
      );
    }
  }

  async #discardSession(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    session?.kill();
    if (session !== undefined) await session.waitForExit(this.#options.shutdownTimeoutMs).catch(() => undefined);
    session?.dispose();
  }

  #enqueue<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let rejectAborted: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted?.(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    const queued = this.#tail.then(run, run);
    this.#tail = queued.then(() => undefined, () => undefined);
    return Promise.race([queued, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class WorkerSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly maxLineBytes: number;
  readonly maxStderrBytes: number;
  #buffer = Buffer.alloc(0);
  #lines: string[] = [];
  #waiter?: Waiter;
  #fatal?: Error;
  #stderr = "";
  exited = false;
  ready?: KokoroReadyMessage;

  constructor(options: KokoroWorkerClientOptions & { maxLineBytes: number; maxStderrBytes: number }) {
    this.maxLineBytes = options.maxLineBytes;
    this.maxStderrBytes = options.maxStderrBytes;
    this.child = spawn(options.executable, [...(options.args ?? [])], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    });
    this.child.stdout.on("data", this.#onStdout);
    this.child.stderr.on("data", this.#onStderr);
    this.child.once("error", this.#onError);
    this.child.once("exit", this.#onExit);
  }

  write(line: string): void {
    if (this.exited || this.#fatal !== undefined) throw this.#fatal ?? new Error("Kokoro worker is not running.");
    this.child.stdin.write(line, "utf8", (error) => { if (error) this.#fail(error); });
  }

  nextLine(timeoutMs: number, phase: string, signal?: AbortSignal): Promise<string> {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift()!);
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal);
    if (this.#waiter !== undefined) return Promise.reject(new Error("Kokoro worker protocol attempted overlapping reads."));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiter = undefined;
        this.kill();
        reject(new Error(`Kokoro worker ${phase} timed out after ${timeoutMs}ms.${this.#stderrSuffix()}`));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        this.#waiter = undefined;
        this.kill();
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); };
      this.#waiter = {
        resolve: (line) => { cleanup(); this.#waiter = undefined; resolve(line); },
        reject: (error) => { cleanup(); this.#waiter = undefined; reject(error); },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  kill(): void { if (!this.exited) this.child.kill("SIGKILL"); }

  waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Kokoro worker did not exit within ${timeoutMs}ms.`)), timeoutMs);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  dispose(): void {
    this.child.stdout.off("data", this.#onStdout);
    this.child.stderr.off("data", this.#onStderr);
    this.child.off("error", this.#onError);
    this.child.off("exit", this.#onExit);
  }

  #onStdout = (chunk: Buffer) => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > this.maxLineBytes && this.#buffer.indexOf(0x0a) === -1) {
      this.#fail(new Error(`Kokoro worker emitted a JSONL line larger than ${this.maxLineBytes} bytes.`));
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > this.maxLineBytes) { this.#fail(new Error(`Kokoro worker emitted a JSONL line larger than ${this.maxLineBytes} bytes.`)); return; }
      const line = this.#buffer.subarray(0, newline).toString("utf8");
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (this.#waiter !== undefined) this.#waiter.resolve(line);
      else if (this.#lines.length === 0) this.#lines.push(line);
      else { this.#fail(new Error("Kokoro worker emitted duplicate or unsolicited protocol responses.")); return; }
    }
  };

  #onStderr = (chunk: Buffer) => {
    if (this.#stderr.length >= this.maxStderrBytes) return;
    this.#stderr += chunk.toString("utf8").slice(0, this.maxStderrBytes - this.#stderr.length);
  };

  #onError = (error: NodeJS.ErrnoException) => {
    const message = error.code === "ENOENT" ? "Kokoro executable not found." : `Kokoro worker process error: ${error.message}`;
    this.#fail(new Error(`${message}${this.#stderrSuffix()}`, { cause: error }));
  };

  #onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.exited = true;
    if (this.#waiter !== undefined) this.#fail(new Error(`Kokoro worker exited before responding (code ${code ?? "none"}, signal ${signal ?? "none"}).${this.#stderrSuffix()}`));
  };

  #fail(error: Error): void {
    this.#fatal ??= error;
    this.#waiter?.reject(this.#fatal);
    this.kill();
  }

  #stderrSuffix(): string { return this.#stderr === "" ? "" : ` Worker stderr: ${this.#stderr}`; }
}
