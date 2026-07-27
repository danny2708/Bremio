import type { SingleRunReport, RunReport, RunReportTask } from "@bremio/orchestrator";
import { ApplyConflictError, MergeManager } from "@bremio/workspace";
import { loadReportByRunId } from "@bremio/orchestrator";

export interface ApplyPatchRequest {
  repoPath: string;
  runId: string;
  taskId?: string;
  filePath?: string;
  force?: boolean;
}

export interface ConflictFile {
  file: string;
  status: string;
}

export interface ApplyRevertResult {
  ok: boolean;
  output?: string;
  error?: string;
  conflictedFiles?: ConflictFile[];
  /** Where `force` saved the user changes it overwrote, when it overwrote any. */
  recoveryPatch?: string;
}

/** A stored report that might be Single or Team mode. */
type AnyReport = SingleRunReport | RunReport;

function isSingleReport(r: AnyReport): r is SingleRunReport {
  return r.mode === "single";
}

/**
 * Extract the diff patch for a given run and optional task/file.
 * For Single runs: returns `report.result.diff`.
 * For Team runs: if `taskId` is given, returns that task's diff; otherwise
 * concatenates all completed task diffs.
 */
async function resolvePatch(
  repoPath: string,
  runId: string,
  taskId?: string,
  filePath?: string,
): Promise<string> {
  const stored = await loadReportByRunId(repoPath, runId);
  if (!stored) throw new Error(`no report found for run ${runId}`);

  const manager = new MergeManager(repoPath);
  let patch = "";
  const report = stored.report as AnyReport;

  if (isSingleReport(report)) {
    if (!report.result?.diff?.patch) throw new Error("this Single run has no stored diff");
    patch = report.result.diff.patch;
  } else {
    if (!report.tasks || report.tasks.length === 0) throw new Error("this Team run has no tasks");

    const filtered = taskId
      ? report.tasks.filter((entry) => entry.task.id === taskId)
      : report.tasks.filter((entry) => entry.result.status === "completed");

    if (filtered.length === 0) {
      throw new Error(
        taskId ? `no completed task found with id ${taskId}` : "no completed tasks",
      );
    }

    patch = filtered
      .map((entry) => (entry as RunReportTask).result.diff?.patch ?? "")
      .filter(Boolean)
      .join("");
  }

  if (!patch.trim()) throw new Error("diff patch is empty — nothing to apply or revert");

  if (filePath) {
    patch = manager.extractFilePatch(patch, filePath);
    if (!patch.trim()) throw new Error(`file "${filePath}" is not in the diff`);
  }

  return patch;
}

/** Apply a stored run's diff to the working tree. */
export async function applyRunPatch(request: ApplyPatchRequest): Promise<ApplyRevertResult> {
  try {
    const patch = await resolvePatch(
      request.repoPath,
      request.runId,
      request.taskId,
      request.filePath,
    );
    const manager = new MergeManager(request.repoPath);

    // Detect pre-existing conflicts first for rich reporting.
    const preConflicts = await manager.detectConflicts(patch);
    if (preConflicts.length > 0 && !request.force) {
      return {
        ok: false,
        error: `User edits conflict with ${preConflicts.length} file(s) the agent changed. Use --force to overwrite user changes.`,
        conflictedFiles: preConflicts,
      };
    }

    const result = await manager.applyPatch(patch, { force: request.force });
    return { ok: true, output: result.output, ...(result.recoveryPatch ? { recoveryPatch: result.recoveryPatch } : {}) };
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof ApplyConflictError) {
      return {
        ok: false,
        error: `conflict: ${msg}`,
        conflictedFiles: err.conflictedFiles,
      };
    }
    return { ok: false, error: msg };
  }
}

/** Reverse-apply (revert) a stored run's diff from the working tree. */
export async function revertRunPatch(request: ApplyPatchRequest): Promise<ApplyRevertResult> {
  try {
    const patch = await resolvePatch(
      request.repoPath,
      request.runId,
      request.taskId,
      request.filePath,
    );
    const manager = new MergeManager(request.repoPath);

    // Detect pre-existing conflicts first for rich reporting.
    const preConflicts = await manager.detectConflicts(patch);
    if (preConflicts.length > 0 && !request.force) {
      return {
        ok: false,
        error: `User edits conflict with ${preConflicts.length} file(s) the agent changed. Use --force to overwrite user changes.`,
        conflictedFiles: preConflicts,
      };
    }

    const result = await manager.revertPatch(patch, { force: request.force });
    return { ok: true, output: result.output, ...(result.recoveryPatch ? { recoveryPatch: result.recoveryPatch } : {}) };
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof ApplyConflictError) {
      return {
        ok: false,
        error: `conflict: ${msg}`,
        conflictedFiles: err.conflictedFiles,
      };
    }
    return { ok: false, error: msg };
  }
}
