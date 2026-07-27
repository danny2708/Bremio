import { DaemonClient, DaemonUnavailableError } from "@bremio/daemon-client";
import { c } from "./ui";

export interface ApplyCommandOptions {
  repoPath: string;
  runId?: string;
  taskId?: string;
  filePath?: string;
  revert: boolean;
  force?: boolean;
}

/** `bremio apply` / `bremio revert` — apply or revert a run's changes to the working tree. */
export async function applyCommand(opts: ApplyCommandOptions): Promise<number> {
  if (!opts.runId && !opts.taskId) {
    console.error(c.red("error: specify --run <runId> to apply or revert"));
    return 2;
  }

  const runId = opts.runId;
  if (!runId) {
    console.error(c.red("error: --run <runId> is required"));
    return 2;
  }

  let client: DaemonClient;
  try {
    client = new DaemonClient();
    await client.connect();
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      console.error(c.red(`error: ${err.message}`));
      return 2;
    }
    throw err;
  }

  const verb = opts.revert ? "revert" : "apply";
  const label = opts.filePath
    ? `${verb} file "${opts.filePath}"`
    : opts.taskId
      ? `${verb} task "${opts.taskId}"`
      : `${verb} run "${runId}"`;

  try {
    const result = opts.revert
      ? await client.revertPatch({
          repoPath: opts.repoPath,
          runId,
          taskId: opts.taskId,
          filePath: opts.filePath,
          force: opts.force,
        })
      : await client.applyPatch({
          repoPath: opts.repoPath,
          runId,
          taskId: opts.taskId,
          filePath: opts.filePath,
          force: opts.force,
        });

    if (result.ok) {
      console.log(c.green(`✓ ${label}`));
      if (result.output) console.log(c.dim(result.output));
      if (result.recoveryPatch) {
        console.log(c.yellow(`  your overwritten changes were saved to ${result.recoveryPatch}`));
        console.log(c.dim(`  restore them with:  git apply "${result.recoveryPatch}"`));
      }
      return 0;
    }

    const conflicts = result.conflictedFiles;
    if (conflicts && conflicts.length > 0) {
      console.error(c.yellow(`⚠ ${label} blocked by user edits in:`));
      for (const cf of conflicts) {
        const statusLabel = cf.status === "user_modified" ? "modified" : cf.status === "user_deleted" ? "deleted" : cf.status;
        console.error(c.yellow(`  - ${cf.file} (${statusLabel})`));
      }
      console.error(c.dim(`  Re-run with --force to overwrite user changes.`));
      return 1;
    }

    console.error(c.red(`✗ ${label} failed: ${result.error ?? "unknown error"}`));
    return 1;
  } catch (err) {
    console.error(c.red(`✗ ${label} failed: ${(err as Error).message}`));
    return 1;
  }
}
