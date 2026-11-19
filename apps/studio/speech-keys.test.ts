import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveNarrationSegment } from "../../packages/generator-playwright/src/narration/resolve-narration.js";
import { createOpenAINarrationProvider } from "../../packages/tts-openai/src/openai-provider.js";
import { serveLibrary } from "./library-server.js";
import { regenerateNarration } from "./narration.js";
import {
  SPEECH_PROVIDERS,
  fileSpeechKeyStore,
  keychainSpeechKeyStore,
  normalizeSpeechKey,
  resolveSpeechKey,
  speechKeysStatus,
  type SecurityRunner,
  type SpeechKeyStore,
} from "./speech-keys.js";
import { loadBundle } from "./storage.js";
import { projectFixture, wavBytes } from "./test-support.js";

const OPENAI = "sk-proj-0123456789abcdefOPENAI";
const ELEVEN = "sk_0123456789abcdef0123456789abcdefELEVEN";

let dir: string;
const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY };
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dh-speech-keys-"));
  // The developer's own keys must not leak into (or decide) these tests.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  await rm(dir, { recursive: true, force: true });
});

describe("speech key validation", () => {
  test("accepts provider-shaped keys and trims them", () => {
    expect(normalizeSpeechKey(`  ${OPENAI}\n`)).toBe(OPENAI);
    expect(normalizeSpeechKey(ELEVEN)).toBe(ELEVEN);
  });
  test("refuses short keys, spaces, quotes and command text", () => {
    for (const bad of ["", "short", "sk-has space-0123456789", 'sk-"quoted"-0123456789', "-w-starts-with-dash-0123", "sk-0123456789abcdef\nadd-generic-password", "x".repeat(600)])
      expect(() => normalizeSpeechKey(bad)).toThrow(/does not look like an API key/);
  });
  test("every supported provider is listed with its environment variable", () => {
    expect(SPEECH_PROVIDERS).toEqual([
      { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" },
      { id: "elevenlabs", label: "ElevenLabs", envVar: "ELEVENLABS_API_KEY" },
    ]);
  });
});

describe("file store", () => {
  test("saves keys in a 0600 file inside a 0700 folder and removes them", async () => {
    const file = path.join(dir, "config", "demohunter", "speech-keys.json");
    const store = fileSpeechKeyStore(file);
    expect(await store.get("openai")).toBeUndefined();
    await store.set("openai", OPENAI);
    await store.set("elevenlabs", ELEVEN);
    expect(await store.get("openai")).toBe(OPENAI);
    expect(await store.get("elevenlabs")).toBe(ELEVEN);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    await store.remove("openai");
    expect(await store.get("openai")).toBeUndefined();
    expect(await store.get("elevenlabs")).toBe(ELEVEN);
    await store.remove("elevenlabs");
    await expect(lstat(file)).rejects.toThrow();
  });

  test.skipIf(process.platform === "win32")("refuses a key file other users can read", async () => {
    const file = path.join(dir, "speech-keys.json");
    await writeFile(file, JSON.stringify({ version: 1, keys: { openai: OPENAI } }));
    await chmod(file, 0o644);
    await expect(fileSpeechKeyStore(file).get("openai")).rejects.toThrow(/chmod 600/);
  });

  test.skipIf(process.platform === "win32")("never follows a link in place of the key file", async () => {
    const target = path.join(dir, "elsewhere.json");
    await writeFile(target, JSON.stringify({ version: 1, keys: { openai: OPENAI } }), { mode: 0o600 });
    const file = path.join(dir, "speech-keys.json");
    await symlink(target, file);
    const store = fileSpeechKeyStore(file);
    await expect(store.get("openai")).rejects.toThrow(/not a regular file/);
    await expect(store.set("openai", ELEVEN)).rejects.toThrow(/not a regular file/);
    expect(await readFile(target, "utf8")).toContain(OPENAI);
  });

  test("ignores unknown providers and malformed values", async () => {
    const file = path.join(dir, "speech-keys.json");
    await writeFile(file, JSON.stringify({ version: 1, keys: { openai: "bad key", other: OPENAI, __proto__: { elevenlabs: ELEVEN } } }), { mode: 0o600 });
    const store = fileSpeechKeyStore(file);
    expect(await store.get("openai")).toBeUndefined();
    expect(await store.get("elevenlabs")).toBeUndefined();
  });
});

describe("Keychain store", () => {
  function fakeSecurity() {
    const items = new Map<string, string>();
    const calls: { args: string[]; stdin?: string }[] = [];
    const run: SecurityRunner = async (args, stdin) => {
      calls.push({ args, stdin });
      if (args[0] === "-i") {
        const m = /^add-generic-password -U -s "DemoHunter Studio" -a (\w+) -l "DemoHunter Studio: [\w ]+ API key" -w (\S+)\n$/.exec(stdin ?? "");
        if (!m) return { code: 1, stdout: "" };
        items.set(m[1]!, m[2]!);
        return { code: 0, stdout: "" };
      }
      const account = args[args.indexOf("-a") + 1]!;
      if (args[0] === "find-generic-password")
        return items.has(account) ? { code: 0, stdout: `${items.get(account)}\n` } : { code: 44, stdout: "" };
      if (args[0] === "delete-generic-password") return { code: items.delete(account) ? 0 : 44, stdout: "" };
      return { code: 2, stdout: "" };
    };
    return { run, items, calls };
  }

  test("passes the key on stdin, never as an argument", async () => {
    const security = fakeSecurity();
    const store = keychainSpeechKeyStore(security.run);
    await store.set("elevenlabs", ELEVEN);
    expect(await store.get("elevenlabs")).toBe(ELEVEN);
    for (const call of security.calls) expect(call.args.join(" ")).not.toContain(ELEVEN);
    expect(security.calls[0]).toEqual({
      args: ["-i"],
      stdin: `add-generic-password -U -s "DemoHunter Studio" -a elevenlabs -l "DemoHunter Studio: ElevenLabs API key" -w ${ELEVEN}\n`,
    });
    await store.remove("elevenlabs");
    await store.remove("elevenlabs");
    expect(await store.get("elevenlabs")).toBeUndefined();
  });

  test("reports a failed save without the key", async () => {
    const store = keychainSpeechKeyStore(async (args) => ({ code: args[0] === "-i" ? 0 : 44, stdout: "" }));
    const error = await store.set("openai", OPENAI).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Could not save the OpenAI key/);
    expect((error as Error).message).not.toContain(OPENAI);
  });

  test("a locked or denied Keychain is an error, a missing item is not", async () => {
    expect(await keychainSpeechKeyStore(async () => ({ code: 44, stdout: "" })).get("openai")).toBeUndefined();
    await expect(keychainSpeechKeyStore(async () => ({ code: 51, stdout: "" })).get("openai")).rejects.toThrow(/status 51/);
  });
});

describe("which key Studio uses", () => {
  test("the saved key first, then the environment", async () => {
    const store = fileSpeechKeyStore(path.join(dir, "keys.json"));
    const env = { OPENAI_API_KEY: "env-openai-key-0123456789" };
    expect(await resolveSpeechKey("openai", store, env)).toBe("env-openai-key-0123456789");
    await store.set("openai", OPENAI);
    expect(await resolveSpeechKey("openai", store, env)).toBe(OPENAI);
    expect(await resolveSpeechKey("elevenlabs", store, env)).toBeUndefined();
  });

  test("an unreadable store falls back to the environment, else reports why", async () => {
    const broken: SpeechKeyStore = {
      kind: "keychain",
      location: "test",
      get: async () => {
        throw new Error("Keychain is locked");
      },
      set: async () => {},
      remove: async () => {},
    };
    expect(await resolveSpeechKey("openai", broken, { OPENAI_API_KEY: "env-openai-key-0123456789" })).toBe("env-openai-key-0123456789");
    await expect(resolveSpeechKey("openai", broken, {})).rejects.toThrow(/locked/);
  });

  test("status shows only the last four characters and the source in use", async () => {
    const store = fileSpeechKeyStore(path.join(dir, "keys.json"));
    await store.set("elevenlabs", ELEVEN);
    const status = await speechKeysStatus(store, { OPENAI_API_KEY: "env-openai-key-0123456789" });
    expect(JSON.stringify(status)).not.toContain(ELEVEN);
    expect(JSON.stringify(status)).not.toContain("env-openai-key");
    expect(status.providers).toEqual([
      { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", saved: false, environment: true, active: "environment" },
      { id: "elevenlabs", label: "ElevenLabs", envVar: "ELEVENLABS_API_KEY", saved: true, hint: "…EVEN", environment: false, active: "studio" },
    ]);
  });
});

describe("narration uses the saved key", () => {
  test("on a cache miss only, and names Studio when no key exists", async () => {
    const { root, dir: demo } = await projectFixture();
    const sent: string[] = [];
    let reads = 0;
    const file = fileSpeechKeyStore(path.join(dir, "keys.json"));
    const store: SpeechKeyStore = { ...file, get: (p) => (reads++, file.get(p)) };
    const resolve: typeof resolveNarrationSegment = (input) =>
      resolveNarrationSegment(input, {
        createProvider: (_config, resolveApiKey) =>
          createOpenAINarrationProvider({
            resolveApiKey,
            fetch: (async (_url: unknown, init?: RequestInit) => {
              sent.push(new Headers(init?.headers).get("authorization") ?? "");
              return new Response(new Uint8Array(wavBytes()));
            }) as typeof fetch,
          }),
      });
    const cacheDir = path.join(root, "cache");
    try {
      await expect(regenerateNarration(demo, { cacheDir, resolve, speechKeys: store })).rejects.toThrow(
        /No OpenAI API key\. Add one in Studio \(Speech keys, in the Script tab.*OPENAI_API_KEY/,
      );
      await file.set("openai", OPENAI);
      reads = 0;
      expect((await regenerateNarration(demo, { cacheDir, resolve, speechKeys: store })).generated).toBe(1);
      expect(sent).toEqual([`Bearer ${OPENAI}`]);
      expect(reads).toBe(1);
      expect((await loadBundle(demo)).narration.segments[0]!.audio?.origin).toBe("provider");
      // A cached take needs no key: the store is not read at all.
      await file.remove("openai");
      reads = 0;
      expect((await regenerateNarration(demo, { cacheDir, resolve, speechKeys: store })).generated).toBe(1);
      expect(reads).toBe(0);
      expect(sent).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("/api/speech-keys", () => {
  function call(url: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
    const u = new URL(url);
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.end(opts.body);
    });
  }
  const post = (url: string, value: unknown, headers: Record<string, string> = {}) =>
    call(url, { method: "POST", body: JSON.stringify(value), headers: { "content-type": "application/json", ...headers } });

  test("saves, reports and removes keys without ever returning one", async () => {
    const { root } = await projectFixture();
    const store = fileSpeechKeyStore(path.join(dir, "keys.json"));
    const app = await serveLibrary(root, { port: 0, speechKeys: store });
    const api = `${app.url}/api/speech-keys`;
    try {
      const empty = JSON.parse((await call(api)).body);
      expect(empty.store).toBe("file");
      expect(empty.providers.map((p: { active: string }) => p.active)).toEqual(["none", "none"]);

      const savedResponse = await post(api, { provider: "elevenlabs", key: ` ${ELEVEN} ` });
      expect(savedResponse.status).toBe(200);
      expect(savedResponse.body).not.toContain(ELEVEN);
      expect(JSON.parse(savedResponse.body).providers[1]).toMatchObject({ id: "elevenlabs", saved: true, hint: "…EVEN", active: "studio" });
      expect(await store.get("elevenlabs")).toBe(ELEVEN);
      expect((await call(api)).body).not.toContain(ELEVEN);

      const removed = await post(api, { provider: "elevenlabs", remove: true });
      expect(JSON.parse(removed.body).providers[1]).toMatchObject({ saved: false, active: "none" });
      expect(await store.get("elevenlabs")).toBeUndefined();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses other sites, forms, unknown providers and bad keys, without echoing input", async () => {
    const { root } = await projectFixture();
    const store = fileSpeechKeyStore(path.join(dir, "keys.json"));
    const app = await serveLibrary(root, { port: 0, speechKeys: store });
    const api = `${app.url}/api/speech-keys`;
    try {
      expect((await post(api, { provider: "openai", key: OPENAI }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await post(api, { provider: "openai", key: OPENAI }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await call(api, { headers: { host: "evil.example" } })).status).toBe(421);
      expect((await call(api, { method: "POST", body: `provider=openai&key=${OPENAI}`, headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
      const unknown = await post(api, { provider: "acme", key: OPENAI });
      expect(unknown.status).toBe(400);
      expect(unknown.body).not.toContain(OPENAI);
      const bad = await post(api, { provider: "openai", key: "not a key at all, has spaces" });
      expect(bad.status).toBe(400);
      expect(bad.body).not.toContain("has spaces");
      expect((await post(api, { provider: "openai", key: "x".repeat(5000) })).status).toBe(413);
      expect((await call(api, { method: "DELETE" })).status).toBe(405);
      expect(await store.get("openai")).toBeUndefined();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
