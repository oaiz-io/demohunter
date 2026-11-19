# Security review: Studio speech keys (261119-luj)

Scope: `git diff origin/main...HEAD` for the speech key feature.
Method: an independent reviewer pass over the diff and the existing Studio
security model (trust.ts, library-server.ts, server.ts, agent-routes.ts).
Report threshold: HIGH or MEDIUM, confidence 0.8 or more.

## Result

No HIGH or MEDIUM findings.

## What was checked

| Area | Result |
| --- | --- |
| `security -i` line injection | Safe. The key must match `^[A-Za-z0-9][A-Za-z0-9._-]{15,511}$` (no space, quote, backslash or newline; cannot start with `-`). Provider comes from a fixed table. Service and label are constants. |
| Key on argv or in env | Safe. Key goes to `/usr/bin/security` (absolute path) on stdin. Minimal env. stderr dropped. No child process env gets a saved key. |
| Key in responses or errors | Safe. Responses carry `saved`, last 4 characters, source in use. Zod errors are not echoed. Store errors name no key. |
| Cross-site / cross-origin writes | Safe. Host check, `Sec-Fetch-Site`, `Origin == Host` for POST, `application/json` required (a form cannot send it without a preflight). |
| Other computers (`--host 0.0.0.0`) | Safe. Socket address must be loopback. |
| Untrusted scenes | Safe. Sandboxed without scripts. |
| XSS in the dialog | Safe. Server text goes in through `textContent`. The only `innerHTML` is a fixed SVG. |
| Key sent elsewhere | Safe. Provider endpoints are fixed HTTPS URLs. |
| File store | Safe. Path from env/home only. Links, group/world-readable files and other owners refused. `wx` temp file 0600, then `rename`. |

## LOW finding, fixed in this branch

- DNS rebinding with `--host 0.0.0.0`: in that mode the library accepts any
  Host, so a web page that rebinds its domain to 127.0.0.1 could replace or
  remove (not read) a saved key. Fix: the speech key routes also require a
  loopback Host name (`localhost`, `127.0.0.1`, `[::1]`). Test added.

## Accepted residual risk (out of scope)

- Any process that runs as the same user can read the Keychain item with
  `security find-generic-password -w` without a prompt (the item trusts
  `/usr/bin/security`). This is the same as a key in `~/.zshrc` today, and
  an agent with a shell has the person's rights anyway.
- A trusted folder's scene scripts run same-origin with the editor (existing
  design), so they can replace or remove a key, but cannot read it.

## Second review (before merge)

A second independent security review (branch at b3873d9) found **no
findings at confidence 8 or above**. The later code-review fixes below only
cache the status (the `?refresh=1` read passes the same guards and returns
the same fields), change the dialog markup, and isolate tests; they add no
new input to the store and no new output of a key. It re-checked the
Host-name fix, Host parsing edge cases (`localhost.`, `foo.localhost`,
`127.0.0.2`, missing Host), IPv4-mapped addresses, the Electron `app://`
origin, `Origin: null` from sandboxed scenes, the `/projects/<id>/` editor
paths, the MCP and `studio narrate` paths, every error path, provider
endpoints, the file store and prototype pollution.

Notes below the threshold, handled:

- MCP `regenerate_narration` and `studio` help still said "environment
  credentials": fixed.
- Studio keeps `OPENAI_API_KEY` from the agents it starts, so an environment
  OpenAI key does not reach agent narration: the dialog and Script tab now
  say "(not for agents)".
- Same-user processes can read the Keychain item without a prompt: accepted
  (see above).

Hardening from the code review that also reduces exposure:

- Tests can no longer reach the developer's real Keychain or key file: a
  test preload (`tests/helpers/isolate-speech-keys.ts`) points the default
  store at a temporary file.
- The key field is a masked text field outside a `<form>`, so browsers do
  not offer to save the key in a (possibly synced) password manager.
- The service reads saved keys once and only again when the person opens the
  dialog, so a locked Keychain asks once and not on every page load.
