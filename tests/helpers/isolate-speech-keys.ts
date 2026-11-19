// Loaded before every test (bunfig.toml). Tests must never read or write the
// developer's real speech keys (macOS Keychain or ~/.config): Studio's default
// store uses this private temporary file instead. Child processes the tests
// start inherit it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DEMOHUNTER_SPEECH_KEYS_FILE = path.join(mkdtempSync(path.join(tmpdir(), "dh-test-keys-")), "speech-keys.json");
