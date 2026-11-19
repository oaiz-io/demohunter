---
quick_id: 261119-luj
status: complete
date: 2026-11-19
---

# 261119-luj: Studio saves speech API keys once for all demos

## Result

- "Speech keys" dialog on the Demos page and in the Script tab. Add an OpenAI
  or ElevenLabs key once; the editor, `studio narrate`, MCP
  `regenerate_narration` and the desktop app use it.
- Order: saved key, then `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`.
- Store: macOS Keychain (service "DemoHunter Studio"); elsewhere or with
  `DEMOHUNTER_SPEECH_KEYS_FILE`, a 0600 file under
  `$XDG_CONFIG_HOME/demohunter/`.
- Key read only on a cache miss. Never in responses, errors, argv, child env
  or MCP.
- `GET/POST /api/speech-keys`: loopback socket and loopback Host name,
  same-origin JSON, 4 KB, strict schema.
- tts-core `NARRATION_PROVIDER_API_KEY_ENV`; providers take `resolveApiKey`.
- CLI unchanged (environment only).
- Design pass: dialog and editor line use the editor's dialog, button,
  field and quiet-link measurements; wording matches the UI ("Script" tab,
  "Demos" page); the red warning shows only when speech must be made.

## Verify

- Typecheck clean (`bun run typecheck`).
- `bun test packages apps/studio tests`: 512 pass, 1 skip, 0 fail (before
  the hardening test; speech key + security tests after it: 24 pass).
- `bun test apps/desktop`: 7 pass.
- Real Keychain round trip (dummy key, removed after): save, update, read,
  remove all work with no prompt.
- Browser check of both dialogs, save, remove and error states.
- Security review: no HIGH/MEDIUM; one LOW fixed. See
  `261119-luj-SECURITY-REVIEW.md`.
