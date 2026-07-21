import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export function resolveOpenCodeBinary(explicit?: string): string | undefined {
  const candidate = explicit ?? process.env.BREMIO_OPENCODE_BIN;
  if (candidate) return exists(candidate) ? path.resolve(candidate) : undefined;

  const onPath = lookupOnPath();
  if (onPath) return onPath;

  return undefined;
}

function lookupOnPath(): string | undefined {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const base = path.join(directory, "opencode");
    if (process.platform !== "win32") {
      if (exists(base)) return base;
      continue;
    }
    if (path.extname(base) && exists(base)) return base;
    const match = windowsExtensions()
      .map((ext) => base + ext)
      .find(exists);
    if (match) return match;
  }
  return undefined;
}

function windowsExtensions(): string[] {
  const fromEnv = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...fromEnv, ".cmd", ".exe"])];
}

function exists(candidate: string): boolean {
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function spawnOpenCode(
  bin: string,
  args: string[],
  cwd: string,
): ChildProcess {
  if (process.platform === "win32") {
    const extension = path.extname(bin).toLowerCase();
    if (extension === ".cmd" || extension === ".bat") {
      const comspec = process.env.ComSpec ?? "cmd.exe";
      const allArgs = `/d /s /c "${bin}" ${args.map((a) => /[ &"']/.test(a) ? `"${a}"` : a).join(" ")}`;
      return spawn(comspec, [allArgs], {
        cwd,
        env: process.env,
        shell: false,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  }
  return spawn(bin, args, {
    cwd,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
