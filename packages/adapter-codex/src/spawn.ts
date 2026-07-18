import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Spawn the `codex` CLI cross-platform. On Windows the global npm bin is a
 * `codex.cmd` shim, and Node ≥18.20 refuses to spawn `.cmd` without a shell
 * (CVE-2024-27980). Resolve the npm shim to its JavaScript entry (or a native
 * `.exe`) so user-controlled model/path arguments never pass through cmd.exe.
 */
export function spawnCodex(
  bin: string,
  args: string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    const target = resolveWindowsTarget(bin, args);
    return spawn(target.command, target.args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  }
  return spawn(bin, args, {
    cwd,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

function resolveWindowsTarget(bin: string, args: string[]): SpawnTarget {
  if (bin.toLowerCase().endsWith(".exe")) return { command: bin, args };

  const cmdPath = locateWindowsCommand(bin, ".cmd");
  if (cmdPath) {
    const npmEntry = path.join(
      path.dirname(cmdPath),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (existsSync(npmEntry)) {
      return { command: process.execPath, args: [npmEntry, ...args] };
    }
  }

  const executable = locateWindowsCommand(bin, ".exe");
  return executable ? { command: executable, args } : { command: bin, args };
}

function locateWindowsCommand(bin: string, extension: ".cmd" | ".exe"): string | undefined {
  const currentExtension = path.extname(bin).toLowerCase();
  if (currentExtension && currentExtension !== extension) return undefined;

  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    const candidate = currentExtension ? bin : `${bin}${extension}`;
    return existsSync(candidate) ? path.resolve(candidate) : undefined;
  }

  const command = currentExtension ? bin : `${bin}${extension}`;
  try {
    const output = execFileSync("where.exe", [command], {
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
