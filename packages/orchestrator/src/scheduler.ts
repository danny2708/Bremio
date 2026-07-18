import type { AgentAdapter } from "@bremio/adapter-sdk";
import type { AgentEvent, Plan, Task, TaskResult } from "@bremio/protocol";
import { TaskLog, type WorktreeManager } from "@bremio/workspace";
import { appendLedgerEntry } from "./ledger";
import { permissionForKind, roleForKind, topologicalOrder } from "./router";
import { buildTaskPrompt } from "./plan-schema";
import { parseReviewOutput, reviewOutputJsonSchema } from "./quality-gate";
import { collectRun } from "./stream";

export interface SchedulerHooks {
  onTaskStart?(task: Task, agentId: string): void;
  onEvent?(task: Task, agentId: string, event: AgentEvent): void;
  onTaskComplete?(result: TaskResult): void;
}

export interface RunPlanOptions {
  plan: Plan;
  /** taskId -> agentId (from the router). */
  assign: Map<string, string>;
  registry: Map<string, AgentAdapter>;
  workspace: WorktreeManager;
  runDir: string;
  runId: string;
  /** Append-only usage ledger; when set, one line is written per task. */
  ledgerPath?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  hooks?: SchedulerHooks;
}

/**
 * Sequential scheduler (Phase 1). Runs tasks in dependency order, one at a
 * time. Each task gets its own worktree + branch; the assigned agent runs
 * there; the diff and logs are collected into a TaskResult. Tasks branch from
 * repo HEAD independently, so a failed task doesn't block the others. On
 * cancellation, the in-flight task is cancelled and remaining tasks are marked
 * cancelled without running.
 */
export async function runPlan(opts: RunPlanOptions): Promise<TaskResult[]> {
  const ordered = topologicalOrder(opts.plan);
  const results: TaskResult[] = [];

  for (const task of ordered) {
    const agentId = opts.assign.get(task.id) ?? task.preferredAgents[0] ?? "";
    const adapter = opts.registry.get(agentId);
    const dependencyResults = task.dependencies.map((id) => results.find((r) => r.taskId === id));
    const blockedDependencies = dependencyResults.filter((r) => !r || r.status !== "completed");

    let result: TaskResult;
    if (opts.signal?.aborted) {
      result = cancelledResult(task, agentId, "run cancelled before this task started");
    } else if (blockedDependencies.length > 0) {
      const ids = task.dependencies.filter((_, index) => blockedDependencies.includes(dependencyResults[index]));
      result = failedResult(task, agentId, `blocked by unsuccessful dependencies: ${ids.join(", ")}`);
    } else if (!adapter) {
      result = failedResult(task, agentId, `no adapter registered for "${agentId}"`);
    } else {
      opts.hooks?.onTaskStart?.(task, agentId);
      const dependencyRefs = dependencyResults
        .map((r) => r?.branch)
        .filter((branch): branch is string => Boolean(branch));
      try {
        result = await runOneTask(task, agentId, adapter, opts, dependencyRefs);
      } catch (err) {
        result = failedResult(task, agentId, `task setup or execution failed: ${(err as Error).message}`);
      }
      opts.hooks?.onTaskComplete?.(result);
    }

    results.push(result);
    await recordLedger(task, result, opts);
  }

  return results;
}

/** Append one usage-ledger line for a finished task. Never breaks a run. */
async function recordLedger(task: Task, result: TaskResult, opts: RunPlanOptions): Promise<void> {
  if (!opts.ledgerPath) return;
  try {
    await appendLedgerEntry(opts.ledgerPath, {
      ts: new Date().toISOString(),
      runId: opts.runId,
      taskId: task.id,
      provider: result.agentId,
      role: roleForKind(task.kind),
      kind: task.kind,
      status: result.status,
      filesChanged: result.filesChanged.length,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    });
  } catch {
    // measurement is best-effort; a ledger write must never fail a run
  }
}

async function runOneTask(
  task: Task,
  agentId: string,
  adapter: AgentAdapter,
  opts: RunPlanOptions,
  dependencyRefs: string[],
): Promise<TaskResult> {
  const started = Date.now();
  const worktree = await opts.workspace.create(
    task.id,
    agentId,
    dependencyRefs.length > 0 ? dependencyRefs : "HEAD",
  );
  const log = new TaskLog(opts.runDir, `${task.id}-${agentId}`);
  log.line(`# Task ${task.id} (${task.kind}) — agent=${agentId} branch=${worktree.branch}`);

  const permission = permissionForKind(task.kind);
  const run = await collectRun(
    adapter.startRun({
      runId: `${task.id}::${agentId}`,
      role: roleForKind(task.kind),
      prompt: buildTaskPrompt(opts.plan, task),
      cwd: worktree.path,
      permission,
      ...(task.kind === "review" ? { outputSchema: reviewOutputJsonSchema } : {}),
      maxTurns: opts.maxTurns ?? 40,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
    {
      log,
      ...(opts.hooks?.onEvent ? { onEvent: (e) => opts.hooks?.onEvent?.(task, agentId, e) } : {}),
    },
  );

  const collected = await opts.workspace.collect(worktree);
  await log.close();

  let status = run.outcome.status;
  let error = run.outcome.error;
  let findings = [] as TaskResult["findings"];
  const tests = task.kind === "test" ? run.tests : [];
  let summary =
    run.outcome.finalText?.trim() ||
    run.assistantText ||
    `${task.title} — no summary produced`;

  if (task.kind === "test" && status === "completed") {
    const finalTest = tests.at(-1);
    if (!finalTest) {
      status = "failed";
      error = "test task completed without shell test evidence";
    } else if (finalTest.exitCode !== 0) {
      status = "failed";
      error = `final test command exited ${finalTest.exitCode}: ${finalTest.command}`;
    }
  }

  if (task.kind === "review" && status === "completed") {
    const review = parseReviewOutput(run);
    if (review.ok) {
      summary = review.summary;
      findings = review.findings;
    } else {
      status = "failed";
      error = `review output invalid: ${review.error}`;
    }
  }

  return {
    taskId: task.id,
    agentId,
    status,
    summary,
    filesChanged: collected.filesChanged,
    commandsExecuted: run.commands,
    tests,
    findings,
    ...(collected.commitHash ? { commitHash: collected.commitHash } : {}),
    ...(run.outcome.sessionId ? { sessionId: run.outcome.sessionId } : {}),
    branch: worktree.branch,
    worktreePath: worktree.path,
    logsPath: log.path,
    durationMs: Date.now() - started,
    ...(error ? { error } : {}),
  };
}

function cancelledResult(task: Task, agentId: string, error: string): TaskResult {
  return {
    taskId: task.id,
    agentId,
    status: "cancelled",
    summary: error,
    filesChanged: [],
    commandsExecuted: [],
    tests: [],
    findings: [],
    error,
  };
}

function failedResult(task: Task, agentId: string, error: string): TaskResult {
  return {
    taskId: task.id,
    agentId,
    status: "failed",
    summary: error,
    filesChanged: [],
    commandsExecuted: [],
    tests: [],
    findings: [],
    error,
  };
}
