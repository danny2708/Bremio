import path from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { App } from "./app";

export interface StartTuiOptions {
  version: string;
  repoPath?: string;
}

/**
 * Launch the interactive TUI. Requires a TTY — callers should fall back to the
 * flag-based CLI when stdin/stdout are piped (CI, scripts).
 */
export async function startTui(options: StartTuiOptions): Promise<void> {
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const instance = render(
    createElement(App, { version: options.version, repoPath }),
  );
  await instance.waitUntilExit();
}

export function canUseTui(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
