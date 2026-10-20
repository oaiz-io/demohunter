import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { terminalLine, terminalScript } from "./terminal.js";

test("the terminal line runs exactly the argv, in the folder, whatever the quotes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dh term 'q' "));
  try {
    const line = terminalLine(dir, ["printf", "%s|", "a b", "it's", '{"x":"$HOME"}', "`id`"]);
    const out = execFileSync("/bin/sh", ["-c", `${line}; printf '%s' "$PWD"`]).toString();
    expect(out).toBe(`a b|it's|{"x":"$HOME"}|\`id\`|${dir}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.if(process.platform === "darwin")("the AppleScript hands Terminal that line unchanged", () => {
  const line = terminalLine("/tmp/a \"b\"", ["echo", 'say "hi" \\ back']);
  // Same escaping as `do script`, but returned instead of run.
  const script = terminalScript(line).replace(/tell application "Terminal"\n  do script (.*)\n  activate\nend tell/s, "return $1");
  expect(execFileSync("osascript", ["-e", script]).toString().trim()).toBe(line);
});
