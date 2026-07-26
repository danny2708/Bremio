import { DaemonClient, DaemonUnavailableError } from "@bremio/daemon-client";
import { c } from "./ui";

export interface ApplyCommandOptions {
  repoPath: string;
  runId?: string;
  taskId?: string;
  filePath?: string;
  revert: boolean;
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
        })
      : await client.applyPatch({
          repoPath: opts.repoPath,
          runId,
          taskId: opts.taskId,
          filePath: opts.filePath,
        });

    if (result.ok) {
      console.log(c.green(`✓ ${label}`));
      if (result.output) console.log(c.dim(result.output));
      return 0;
    }
    console.error(c.red(`✗ ${label} failed: ${result.error ?? "unknown error"}`));
    return 1;
  } catch (err) {
    console.error(c.red(`✗ ${label} failed: ${(err as Error).message}`));
    return 1;
  }
}
