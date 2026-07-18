import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

/** agy takes no stdin, so the child exposes only stdout/stderr. */
export type AgyChild = ChildProcessByStdio<null, Readable, Readable>;

/** Where the official installer places the binary, per platform. */
function defaultInstallPaths(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(localAppData, "agy", "bin", "agy.exe")];
  }
  return [
    path.join(home, ".agy", "bin", "agy"),
    path.join(home, ".local", "bin", "agy"),
    "/usr/local/bin/agy",
  ];
}

/**
 * Locate the `agy` executable. The installer adds `%LOCALAPPDATA%\agy\bin` to the
 * *user* PATH registry entry, which existing terminal sessions do not pick up
 * until they restart — so PATH lookup alone is not enough and we also probe the
 * known install locations.
 */
export function resolveAgyBinary(explicit?: string): string | undefined {
  const candidate = explicit ?? process.env.BREMIO_AGY_BIN;
  if (candidate) return existsSync(candidate) ? path.resolve(candidate) : undefined;

  const onPath = lookupOnPath();
  if (onPath) return onPath;

  return defaultInstallPaths().find((p) => existsSync(p));
}

function lookupOnPath(): string | undefined {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const target = process.platform === "win32" ? "agy.exe" : "agy";
  try {
    const output = execFileSync(finder, [target], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && existsSync(line));
  } catch {
    return undefined;
  }
}

/** State file the CLI writes once onboarding (including sign-in) completes. */
export function agyStateFile(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "jetski_state.pbtxt");
}

/**
 * Heuristic sign-in check. `agy` exposes no `auth status` subcommand, and the
 * only definitive test is a billed prompt — so Bremio reads the onboarding
 * state file instead of spending quota during `doctor`.
 */
export function agyLooksSignedIn(): boolean {
  return existsSync(agyStateFile());
}

/**
 * `agy` is a native executable, so it spawns directly with `shell: false` —
 * no cmd.exe, and therefore no unescaped-argument exposure.
 */
export function spawnAgy(bin: string, args: string[]): AgyChild {
  return spawn(bin, args, {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Format a millisecond timeout as the Go-style duration `--print-timeout` wants. */
export function formatPrintTimeout(timeoutMs: number): string {
  return `${Math.max(1, Math.round(timeoutMs / 1000))}s`;
}
