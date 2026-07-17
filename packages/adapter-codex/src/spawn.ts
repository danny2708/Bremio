import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Spawn the `codex` CLI cross-platform. On Windows the global npm bin is a
 * `codex.cmd` shim, and Node ≥18.20 refuses to spawn `.cmd` without a shell
 * (CVE-2024-27980), so we route through the shell and quote args ourselves.
 * On POSIX we spawn directly (no shell) — safer and no quoting needed.
 */
export function spawnCodex(
  bin: string,
  args: string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    const quoted = args.map((a) =>
      /[\s"^&|<>()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a,
    );
    return spawn(bin, quoted, {
      cwd,
      env: process.env,
      shell: true,
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
