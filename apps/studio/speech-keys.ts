/**
 * Speech (text-to-speech) API keys saved once for all of DemoHunter Studio.
 *
 * macOS: the login Keychain (service "DemoHunter Studio", one item per
 * provider), written and read with /usr/bin/security. Elsewhere, or when
 * DEMOHUNTER_SPEECH_KEYS_FILE names a file: a JSON file only the person can
 * read (folder 0700, file 0600).
 *
 * A key never leaves this module except to the provider's own API: it is not
 * put on a command line, in a child process environment, a response, a log or
 * an error message. Callers see only whether a key is saved and its last four
 * characters.
 */
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { NARRATION_PROVIDER_API_KEY_ENV, type ApiKeyNarrationProviderName } from "../../packages/tts-core/src/contracts.js";

export type SpeechProvider = ApiKeyNarrationProviderName;

const LABELS: Record<SpeechProvider, string> = { openai: "OpenAI", elevenlabs: "ElevenLabs" };
export const SPEECH_PROVIDERS = (Object.keys(NARRATION_PROVIDER_API_KEY_ENV) as SpeechProvider[]).map((id) => ({
  id,
  label: LABELS[id] ?? id,
  envVar: NARRATION_PROVIDER_API_KEY_ENV[id],
}));
export function isSpeechProvider(value: unknown): value is SpeechProvider {
  return typeof value === "string" && Object.hasOwn(NARRATION_PROVIDER_API_KEY_ENV, value);
}

/** Provider keys are long tokens of letters, digits, "-", "_" and ".". The
 * strict alphabet also keeps a key safe inside a `security -i` command line. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,511}$/;
export function normalizeSpeechKey(value: string): string {
  const key = value.trim();
  if (!KEY_PATTERN.test(key))
    throw new Error("That does not look like an API key: use 16 to 512 letters, digits, '-', '_' or '.', with no spaces.");
  return key;
}
const hintOf = (key: string) => `…${key.slice(-4)}`;

export interface SpeechKeyStore {
  readonly kind: "keychain" | "file";
  /** Where keys are kept, for display. */
  readonly location: string;
  get(provider: SpeechProvider): Promise<string | undefined>;
  set(provider: SpeechProvider, key: string): Promise<void>;
  remove(provider: SpeechProvider): Promise<void>;
}

// ---------------------------------------------------------------- Keychain

export const KEYCHAIN_SERVICE = "DemoHunter Studio";
const SECURITY = "/usr/bin/security";
/** Exit status of `security` when the item does not exist. */
const NOT_FOUND = 44;
export type SecurityRunner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>;

/** Runs /usr/bin/security (absolute path: never one found on PATH). Its
 * output is returned to the caller only; stderr is dropped because it can
 * echo the command it was given. */
const runSecurity: SecurityRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(SECURITY, args, { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout = (stdout + d).slice(-8192)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run the macOS Keychain tool (${(error as NodeJS.ErrnoException).code ?? "error"}).`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
    child.stdin.end(stdin ?? "");
  });

export function keychainSpeechKeyStore(run: SecurityRunner = runSecurity): SpeechKeyStore {
  const item = (provider: SpeechProvider) => ["-s", KEYCHAIN_SERVICE, "-a", provider];
  const label = (provider: SpeechProvider) => `"${KEYCHAIN_SERVICE}: ${LABELS[provider] ?? provider} API key"`;
  const store: SpeechKeyStore = {
    kind: "keychain",
    location: "macOS Keychain",
    async get(provider) {
      const { code, stdout } = await run(["find-generic-password", ...item(provider), "-w"]);
      if (code === NOT_FOUND) return undefined;
      if (code !== 0) throw new Error(`Could not read the ${LABELS[provider]} key from the macOS Keychain (status ${code}).`);
      const key = stdout.replace(/\n$/, "");
      return KEY_PATTERN.test(key) ? key : undefined;
    },
    async set(provider, key) {
      key = normalizeSpeechKey(key);
      // `-w <key>` on a command line would show in `ps`. Interactive mode reads
      // the command from stdin instead. Service and label hold no quote and
      // the key no space or quote, so the line parses exactly as written.
      const line = `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a ${provider} -l ${label(provider)} -w ${key}\n`;
      const { code } = await run(["-i"], line);
      // Interactive mode can exit 0 when its command failed: read it back.
      if (code !== 0 || (await store.get(provider)) !== key)
        throw new Error(`Could not save the ${LABELS[provider]} key in the macOS Keychain.`);
    },
    async remove(provider) {
      const { code } = await run(["delete-generic-password", ...item(provider)]);
      if (code !== 0 && code !== NOT_FOUND)
        throw new Error(`Could not remove the ${LABELS[provider]} key from the macOS Keychain (status ${code}).`);
    },
  };
  return store;
}

// ---------------------------------------------------------------- file

/** Absolute paths only: Studio, `studio narrate` and an agent's MCP server
 * run in different folders and must all find the same file. */
export function defaultSpeechKeysFile(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.DEMOHUNTER_SPEECH_KEYS_FILE;
  if (chosen && path.isAbsolute(chosen)) return chosen;
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homedir(), ".config");
  return path.join(base, "demohunter", "speech-keys.json");
}

type KeyFile = { version: 1; keys: Partial<Record<SpeechProvider, string>> };

/** Writes are serialized within one process. Two Studio processes saving
 * different providers at the same instant can lose one save (the file is
 * replaced whole); the Keychain store (macOS) has no such limit. */
export function fileSpeechKeyStore(file = defaultSpeechKeysFile()): SpeechKeyStore {
  file = path.resolve(file);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const posix = process.platform !== "win32";
  const read = async (): Promise<KeyFile> => {
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: {} };
      throw error;
    }
    // Never follow a link someone put in place of the key file, and never use
    // a file other people can read or that belongs to someone else.
    if (!info.isFile()) throw new Error(`${file} is not a regular file; Studio will not read speech keys from it.`);
    if (posix && (info.mode & 0o077) !== 0)
      throw new Error(`${file} can be read by other users. Run: chmod 600 "${file}"`);
    if (posix && typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error(`${file} belongs to another user; Studio will not read speech keys from it.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new Error(`${file} is not valid JSON. Remove it and add the keys again.`);
    }
    const keys: KeyFile["keys"] = {};
    const raw = (parsed as { keys?: unknown })?.keys;
    if (raw && typeof raw === "object")
      for (const [provider, key] of Object.entries(raw))
        if (isSpeechProvider(provider) && typeof key === "string" && KEY_PATTERN.test(key)) keys[provider] = key;
    return { version: 1, keys };
  };
  const write = async (data: KeyFile) => {
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.speech-keys.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    // "wx": fail rather than write through anything already at the temp name.
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // rename replaces a link at the target name instead of writing through it.
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  };
  return {
    kind: "file",
    location: file,
    get: (provider) => serial(async () => (await read()).keys[provider]),
    set: (provider, key) =>
      serial(async () => {
        key = normalizeSpeechKey(key);
        const data = await read();
        data.keys[provider] = key;
        await write(data);
      }),
    remove: (provider) =>
      serial(async () => {
        const data = await read();
        if (!(provider in data.keys)) return;
        delete data.keys[provider];
        if (Object.keys(data.keys).length) await write(data);
        else await unlink(file).catch(() => {});
      }),
  };
}

// ---------------------------------------------------------------- default

let defaultStore: SpeechKeyStore | undefined;
/** The macOS Keychain on a Mac, otherwise (or with DEMOHUNTER_SPEECH_KEYS_FILE)
 * the per-user file. */
export function speechKeyStore(): SpeechKeyStore {
  const file = process.env.DEMOHUNTER_SPEECH_KEYS_FILE;
  return (defaultStore ??=
    process.platform === "darwin" && !(file && path.isAbsolute(file))
      ? keychainSpeechKeyStore()
      : fileSpeechKeyStore(defaultSpeechKeysFile()));
}

/** The key Studio uses for a provider: the saved key, else its environment
 * variable, else none. A store that cannot be read falls back to the
 * environment; when that is empty too, the store's error is thrown. */
export async function resolveSpeechKey(
  provider: SpeechProvider,
  store: SpeechKeyStore = speechKeyStore(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  let failure: unknown;
  try {
    const saved = await store.get(provider);
    if (saved) return saved;
  } catch (error) {
    failure = error;
  }
  const fromEnv = env[NARRATION_PROVIDER_API_KEY_ENV[provider]]?.trim();
  if (fromEnv) return fromEnv;
  if (failure) throw failure;
  return undefined;
}

export type SpeechKeyState = {
  id: SpeechProvider;
  label: string;
  envVar: string;
  /** A key is saved in Studio; `hint` shows its last four characters. */
  saved: boolean;
  hint?: string;
  /** The environment variable is set. */
  environment: boolean;
  /** Which key synthesis uses. */
  active: "studio" | "environment" | "none";
  /** Agents Studio starts (and their MCP narration) can use the key. False
   * when only the environment has it and Studio keeps that variable from
   * agents (OPENAI_API_KEY: Codex would sign in with it). */
  agents: boolean;
  error?: string;
};
export type SpeechKeysStatus = { store: SpeechKeyStore["kind"]; location: string; providers: SpeechKeyState[] };

type Known = { hint?: string; error?: string };

/**
 * What the Speech keys dialog and the Script tab show, read from the store
 * once and then kept up to date by the saves and removals made through it.
 * Reading a saved key from a locked Keychain asks the person to unlock it, so
 * Studio reads again only when the person opens the dialog (`refresh`), and
 * stops at the first failure instead of asking once per provider.
 */
export class SpeechKeyStatus {
  private known = new Map<SpeechProvider, Known>();
  private reading: Promise<void> | undefined;
  constructor(
    readonly store: SpeechKeyStore = speechKeyStore(),
    private env: NodeJS.ProcessEnv = process.env,
    /** Environment variables Studio removes before it starts an agent. */
    private hiddenFromAgents: readonly string[] = [],
  ) {}

  async status(refresh = false): Promise<SpeechKeysStatus> {
    if (refresh || this.known.size < SPEECH_PROVIDERS.length) await (this.reading ??= this.read().finally(() => (this.reading = undefined)));
    return this.snapshot();
  }
  async set(provider: SpeechProvider, key: string): Promise<SpeechKeysStatus> {
    key = normalizeSpeechKey(key);
    await this.store.set(provider, key);
    this.known.set(provider, { hint: hintOf(key) });
    return this.status();
  }
  async remove(provider: SpeechProvider): Promise<SpeechKeysStatus> {
    await this.store.remove(provider);
    this.known.set(provider, {});
    return this.status();
  }

  private async read(): Promise<void> {
    let failure: string | undefined;
    // One at a time: a locked Keychain asks once, not once per provider.
    for (const { id } of SPEECH_PROVIDERS) {
      if (failure) {
        this.known.set(id, { error: failure });
        continue;
      }
      try {
        const saved = await this.store.get(id);
        this.known.set(id, saved ? { hint: hintOf(saved) } : {});
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        this.known.set(id, { error: failure });
      }
    }
  }
  private snapshot(): SpeechKeysStatus {
    const providers = SPEECH_PROVIDERS.map(({ id, label, envVar }): SpeechKeyState => {
      const known = this.known.get(id) ?? {};
      const environment = !!this.env[envVar]?.trim();
      const active = known.hint ? "studio" : environment ? "environment" : "none";
      return {
        id,
        label,
        envVar,
        saved: !!known.hint,
        ...(known.hint ? { hint: known.hint } : {}),
        environment,
        active,
        agents: active === "studio" || (active === "environment" && !this.hiddenFromAgents.includes(envVar)),
        ...(known.error ? { error: known.error } : {}),
      };
    });
    return { store: this.store.kind, location: this.store.location, providers };
  }
}

/** A one-off status (reads every saved key). */
export function speechKeysStatus(
  store: SpeechKeyStore = speechKeyStore(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SpeechKeysStatus> {
  return new SpeechKeyStatus(store, env).status();
}

/** Studio's narration message when a provider has no key anywhere. */
export function missingSpeechKeyMessage(provider: SpeechProvider): string {
  return `No ${LABELS[provider] ?? provider} API key. Add one in Studio (Speech keys, in the Script tab or on the Demos page), or set ${NARRATION_PROVIDER_API_KEY_ENV[provider]}.`;
}
