---
quick_id: 261119-luj
slug: studio-global-speech-api-keys
date: 2026-11-19
mode: quick (inline; GSD agents not installed)
---

# Quick Task 261119-luj: Studio saves speech (TTS) API keys globally

## Goal

A person adds an OpenAI or ElevenLabs API key once in DemoHunter Studio. Every
Studio path that makes speech (editor, `studio narrate`, MCP
`regenerate_narration`, desktop app) loads that key. The environment variable
stays a fallback. The CLI (`demohunter generate`) is not changed.

## Decisions

- Store: macOS Keychain (service `DemoHunter Studio`, one item per provider)
  through `/usr/bin/security`. The key goes to `security -i` on stdin, never on
  a command line. Other platforms (or `DEMOHUNTER_SPEECH_KEYS_FILE`): a JSON
  file in `$XDG_CONFIG_HOME/demohunter/` (default `~/.config/demohunter/`),
  folder 0700, file 0600, atomic write, symlinks and open permissions refused.
- Order: key saved in Studio, then `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`.
- The key is read only on a cache miss (offline cache hits never touch the
  store). It never goes into a child process environment, a response, a log or
  an error message. The HTTP API returns only "saved", the last 4 characters,
  and the source in use.
- HTTP: `GET/POST /api/speech-keys` on the library service. Loopback clients
  only, same origin only, `application/json` only, 4 KB body limit, strict
  schema. Not exposed through MCP.
- Provider list comes from `@demohunter/tts-core`
  (`NARRATION_PROVIDER_API_KEY_ENV`), so a new provider must name its key.

## Tasks

1. tts-core provider metadata; providers accept `resolveApiKey`;
   `resolveNarrationSegment` passes it through. Tests.
2. `apps/studio/speech-keys.ts` (Keychain + file stores, validation, status,
   resolution); `regenerateNarration` uses it; routes in `library-server.ts`.
   Tests (no test touches the real Keychain).
3. UI: "Speech keys" dialog on the library page and in the editor Narration
   panel (shows the key state for the demo's provider). Docs, SECURITY.md,
   AGENTS.md constraint, security review, PR.

## Verify

`bun run typecheck`, `bun test apps/studio packages`, desktop tests, a browser
check of both dialogs, and a security review of the diff.
