import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";

export function resolveOpenCodeBinary(explicit?: string): string | undefined {
  const candidate = explicit ?? process.env.BREMIO_OPENCODE_BIN;
  if (candidate) return resolveWindowsCompanion(exists(candidate) ? path.resolve(candidate) : undefined);

  const onPath = lookupOnPath();
  if (onPath) return resolveWindowsCompanion(onPath);

  return undefined;
}

function resolveWindowsCompanion(bin: string | undefined): string | undefined {
  if (!bin || process.platform !== "win32") return bin;
  const ext = path.extname(bin).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return bin;

  const exePath = resolveExeFromCmd(bin);
  return exePath ?? bin;
}

function resolveExeFromCmd(cmdPath: string): string | undefined {
  try {
    const content = readFileSync(cmdPath, "utf8");
    const match = content.match(/"([^"]+\.exe)"/);
    if (!match) return undefined;
    const relative = match[1]!.replace(/%dp0%/gi, path.dirname(cmdPath) + "\\");
    const resolved = path.resolve(relative);
    return exists(resolved) ? resolved : undefined;
  } catch { return undefined; }
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
  return spawn(bin, args, {
    cwd,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
