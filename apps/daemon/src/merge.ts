import { existsSync } from "node:fs";
import {
  CherryPickConflictError,
  MergeConflictError,
  MergeManager,
  MergeStateError,
} from "@bremio/workspace";
import {
  findTaskAcrossReports,
  listReports,
  loadReportByRunId,
  type RunReport,
  type RunReportTask,
} from "@bremio/orchestrator";

export interface MergeRequest {
  repoPath: string;
  taskId?: string;
  runId?: string;
  base?: string;
  strategy?: "merge" | "cherry-pick";
}

export interface MergeTaskOutcome {
  taskId: string;
  status: "merged" | "skipped" | "conflict" | "error";
  detail: string;
}

export interface MergeOutcome {
  ok: boolean;
  merged: number;
  tasks: MergeTaskOutcome[];
  error?: string;
}

/**
 * Merge task branches for a completed run.
 *
 * Deliberately mirrors the CLI's invariants rather than relaxing them for a
 * GUI: the run's quality gate must have passed, the repo must already be on
 * the base branch, and tracked changes block the merge. A button is not a
 * reason to skip the checks that protect the user's working tree.
 *
 * Confirmation is the caller's job — the UI shows the diff and asks — but the
 * gate is enforced here so no client can bypass it.
 */
export async function mergeRun(request: MergeRequest): Promise<MergeOutcome> {
  const resolved = await resolveTargets(request);
  if ("error" in resolved) return { ok: false, merged: 0, tasks: [], error: resolved.error };

  const { report, tasks } = resolved;
  const strategy = request.strategy ?? "merge";

  if (!report.qualityGate || report.qualityGate.status !== "passed") {
    const status = report.qualityGate?.status ?? "missing";
    const reasons = report.qualityGate?.reasons ?? [];
    return {
      ok: false,
      merged: 0,
      tasks: [],
      error: `quality gate is ${status}; refusing to merge${reasons.length ? `: ${reasons.join("; ")}` : ""}`,
    };
  }

  const manager = new MergeManager(request.repoPath);
  const current = await manager.currentBranch();
  const base = request.base ?? report.baseBranch ?? current;

  if (current !== base) {
    return {
      ok: false,
      merged: 0,
      tasks: [],
      error: `repository is on "${current}", not the base branch "${base}"`,
    };
  }
  if (await manager.hasTrackedChanges()) {
    return {
      ok: false,
      merged: 0,
      tasks: [],
      error: "working tree has uncommitted changes to tracked files",
    };
  }

  const outcomes: MergeTaskOutcome[] = [];
  let merged = 0;

  for (const { task, result } of tasks) {
    if (result.status !== "completed") {
      outcomes.push({ taskId: task.id, status: "skipped", detail: `status is ${result.status}` });
      continue;
    }
    if (!result.branch) {
      outcomes.push({ taskId: task.id, status: "skipped", detail: "no branch recorded" });
      continue;
    }
    if (!(await manager.branchExists(result.branch))) {
      outcomes.push({
        taskId: task.id,
        status: "skipped",
        detail: `branch ${result.branch} no longer exists (already merged?)`,
      });
      continue;
    }
    if (strategy === "cherry-pick" && !result.commitHash) {
      outcomes.push({ taskId: task.id, status: "skipped", detail: "no task commit to cherry-pick" });
      continue;
    }

    try {
      if (strategy === "cherry-pick") {
        await manager.cherryPick(result.commitHash as string, base);
      } else {
        await manager.merge(result.branch, base);
      }
      if (result.worktreePath && existsSync(result.worktreePath)) {
        // The merge already landed; a stuck worktree must not fail the result.
        await manager.cleanup(result.worktreePath, result.branch).catch(() => {});
      }
      merged += 1;
      outcomes.push({ taskId: task.id, status: "merged", detail: result.branch });
    } catch (err) {
      const conflict = err instanceof MergeConflictError || err instanceof CherryPickConflictError;
      const state = err instanceof MergeStateError;
      outcomes.push({
        taskId: task.id,
        status: conflict ? "conflict" : "error",
        detail: (err as Error).message,
      });
      // A conflict or bad repo state aborts the whole run: continuing would
      // stack changes on top of a tree the user has not reconciled yet.
      if (conflict || state) break;
    }
  }

  return { ok: outcomes.every((o) => o.status !== "conflict" && o.status !== "error"), merged, tasks: outcomes };
}

type Resolved = { report: RunReport; tasks: RunReportTask[] } | { error: string };

async function resolveTargets(request: MergeRequest): Promise<Resolved> {
  if (request.runId) {
    const stored = await loadReportByRunId(request.repoPath, request.runId);
    if (!stored) return { error: `no report found for run ${request.runId}` };
    if (stored.report.mode !== "team") {
      return { error: `run ${request.runId} is a Single run and has no Bremio branch to merge` };
    }
    const report = stored.report;
    const tasks = request.taskId
      ? report.tasks.filter((entry) => entry.task.id === request.taskId)
      : report.tasks;
    if (tasks.length === 0) {
      return { error: `task ${request.taskId} is not part of run ${request.runId}` };
    }
    return { report, tasks };
  }

  if (!request.taskId) return { error: "either taskId or runId is required" };

  const matches = findTaskAcrossReports(await listReports(request.repoPath), request.taskId);
  if (matches.length === 0) return { error: `no completed task found with id ${request.taskId}` };
  if (matches.length > 1) {
    return {
      error: `task ${request.taskId} appears in ${matches.length} runs; pass runId to disambiguate`,
    };
  }
  const match = matches[0] as (typeof matches)[number];
  return { report: match.stored.report, tasks: [match.entry] };
}
