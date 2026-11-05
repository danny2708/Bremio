import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HIDDEN_DIR, type LoadedCase } from "./schema";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
  return stdout;
}

/** Copy every file of `src` over `dest` (files in `dest` not in `src` survive). */
export async function overlay(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  await fs.cp(src, dest, { recursive: true, force: true });
}

/**
 * Create a fresh git repository holding only the case's `repo/` files. This is
 * the agent's whole world: hidden files and the reference solution are never
 * copied here before the agent finishes.
 */
export async function materializeCase(
  benchCase: LoadedCase,
  workRoot: string = os.tmpdir(),
): Promise<string> {
  await fs.mkdir(workRoot, { recursive: true });
  const workdir = await fs.mkdtemp(path.join(workRoot, `bremio-bench-${benchCase.definition.id}-`));
  await overlay(benchCase.repoDir, workdir);
  await git(workdir, ["init", "-q", "-b", "main"]);
  await git(workdir, ["config", "user.email", "bench@bremio.invalid"]);
  await git(workdir, ["config", "user.name", "bremio-bench"]);
  await git(workdir, ["config", "commit.gpgsign", "false"]);
  await git(workdir, ["add", "--", "."]);
  await git(workdir, ["commit", "-q", "-m", `bench: ${benchCase.definition.id} baseline`]);
  return workdir;
}

/**
 * Install the hidden verification files after the agent is done. The hidden
 * directory is removed first, so anything the agent wrote there is discarded
 * rather than run as if it were the case's own test.
 */
export async function installHidden(benchCase: LoadedCase, workdir: string): Promise<void> {
  await fs.rm(path.join(workdir, HIDDEN_DIR), { recursive: true, force: true });
  await overlay(benchCase.hiddenDir, workdir);
}

/** Remove a workdir created by {@link materializeCase}; refuses anything else. */
export async function removeWorkdir(workdir: string): Promise<void> {
  if (!path.basename(workdir).startsWith("bremio-bench-")) {
    throw new Error(`refusing to remove unexpected bench workdir: ${workdir}`);
  }
  await fs.rm(workdir, { recursive: true, force: true, maxRetries: 3 });
}
