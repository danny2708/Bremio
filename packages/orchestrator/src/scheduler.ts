import type { AgentAdapter } from "@bremio/adapter-sdk";
import type { AgentEvent, Plan, Task, TaskResult } from "@bremio/protocol";
import { TaskLog, type WorktreeManager } from "@bremio/workspace";
import { permissionForKind, roleForKind, topologicalOrder } from "./router";
import { buildTaskPrompt } from "./plan-schema";
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

    if (opts.signal?.aborted) {
      results.push(cancelledResult(task, agentId, "run cancelled before this task started"));
      continue;
    }
    if (!adapter) {
      results.push(failedResult(task, agentId, `no adapter registered for "${agentId}"`));
      continue;
    }

    opts.hooks?.onTaskStart?.(task, agentId);
    const result = await runOneTask(task, agentId, adapter, opts);
    results.push(result);
    opts.hooks?.onTaskComplete?.(result);
  }

  return results;
}

async function runOneTask(
  task: Task,
  agentId: string,
  adapter: AgentAdapter,
  opts: RunPlanOptions,
): Promise<TaskResult> {
  const started = Date.now();
  const worktree = await opts.workspace.create(task.id, agentId);
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

  const summary =
    run.outcome.finalText?.trim() ||
    run.assistantText ||
    `${task.title} — no summary produced`;

  return {
    taskId: task.id,
    agentId,
    status: run.outcome.status,
    summary,
    filesChanged: collected.filesChanged,
    commandsExecuted: run.commands,
    tests: [],
    findings: [],
    ...(collected.commitHash ? { commitHash: collected.commitHash } : {}),
    ...(run.outcome.sessionId ? { sessionId: run.outcome.sessionId } : {}),
    branch: worktree.branch,
    worktreePath: worktree.path,
    logsPath: log.path,
    durationMs: Date.now() - started,
    ...(run.outcome.error ? { error: run.outcome.error } : {}),
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
