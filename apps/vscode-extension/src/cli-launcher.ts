import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

/**
 * Locating and launching the Bremio CLI.
 *
 * `npm i -g` on Windows does not install an executable. It writes shim files —
 * `bremio.cmd`, `bremio.ps1` and an extensionless shell script — and Node's
 * `spawn` with `shell: false` can only start real executables. Spawning
 * `"bremio"` therefore failed with ENOENT on every Windows machine, and the
 * panel reported "CLI not installed" to users who had installed it correctly.
 *
 * Resolving the shim explicitly is preferred over `shell: true`, which would
 * hand a user-configured path to a command interpreter for parsing.
 */

/** Extensions Windows treats as executable, in the order PATH lookup uses. */
function windowsExtensions(): string[] {
  const fromEnv = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  // The shim npm writes is .cmd, so make sure it is considered even if the
  // user has trimmed PATHEXT.
  return [...new Set([...fromEnv, ".cmd", ".exe"])];
}

function isFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the real file behind a command name.
 *
 * Returns undefined when nothing matches, which is the genuine "not installed"
 * case — as opposed to the spawn failure that used to masquerade as one.
 */
export function resolveCliPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const onWindows = process.platform === "win32";

  // An explicit path from settings is used as given, but still probed for the
  // Windows extensions so `bremio.cmd` is found from a bare `bremio`.
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.resolve(command);
    if (isFile(absolute)) return absolute;
    if (!onWindows) return undefined;
    return windowsExtensions()
      .map((extension) => absolute + extension)
      .find(isFile);
  }

  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const base = path.join(directory, command);
    if (!onWindows) {
      if (isFile(base)) return base;
      continue;
    }
    if (path.extname(base) && isFile(base)) return base;
    const match = windowsExtensions()
      .map((extension) => base + extension)
      .find(isFile);
    if (match) return match;
  }
  return undefined;
}

export interface LaunchResult {
  child: ChildProcess;
  /** The file actually launched, for the output channel. */
  resolved: string;
}

export class CliNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`the Bremio CLI was not found (tried "${command}")`);
    this.name = "CliNotFoundError";
  }
}

/**
 * Start the CLI, going through the command interpreter only when the resolved
 * target is a batch shim that cannot be executed directly.
 */
export function launchCli(command: string, args: string[]): LaunchResult {
  const resolved = resolveCliPath(command);
  if (!resolved) throw new CliNotFoundError(command);

  const stdio = ["ignore", "pipe", "pipe"] as const;
  const extension = path.extname(resolved).toLowerCase();

  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    // cmd.exe is required for a batch shim. `/d` skips AutoRun scripts and `/s`
    // keeps the quoted path intact, so a directory containing spaces — such as
    // the default under AppData — is not split into separate arguments.
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return {
      resolved,
      child: spawn(comspec, ["/d", "/s", "/c", `"${resolved}" ${args.join(" ")}`], {
        stdio: [...stdio],
        windowsVerbatimArguments: true,
        shell: false,
      }),
    };
  }

  return {
    resolved,
    child: spawn(resolved, args, { stdio: [...stdio], shell: false }),
  };
}
