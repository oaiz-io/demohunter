import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Open a terminal window in a folder and run one command there, for the
 * person to use: an agent's own sign-in, or the agent itself. macOS only
 * (Terminal.app); elsewhere the caller shows the command to copy.
 */
const run = promisify(execFile);

/** POSIX single-quoting: safe for any argument, including quotes and spaces. */
export const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

/** The line typed into the terminal: change to the folder, then run argv. */
export function terminalLine(cwd: string, argv: string[]): string {
  // The line is typed into an interactive shell, whose line editor acts on
  // control characters (Ctrl-U erases what came before) even inside quotes.
  if ([cwd, ...argv].some((a) => /[\u0000-\u001f\u007f]/.test(a)))
    throw Object.assign(new Error("That folder or command can't be opened in Terminal."), { status: 400 });
  return `cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(" ")}`;
}

/** AppleScript that opens a Terminal window running `line`. */
export function terminalScript(line: string): string {
  const asString = `"${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `tell application "Terminal"\n  do script ${asString}\n  activate\nend tell`;
}

export type TerminalResult = { opened: true; line: string } | { opened: false; line: string };

export async function openTerminal(
  cwd: string,
  argv: string[],
  /** Replaces Terminal.app (tests). */
  launch?: (script: string) => Promise<unknown>,
): Promise<TerminalResult> {
  const line = terminalLine(cwd, argv);
  if (!launch && process.platform !== "darwin") return { opened: false, line };
  await (launch ?? ((script: string) => run("osascript", ["-e", script], { timeout: 10_000 })))(terminalScript(line));
  return { opened: true, line };
}
