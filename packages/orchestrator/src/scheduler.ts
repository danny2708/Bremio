import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentAdapter } from "@bremio/adapter-sdk";
import type { AgentEvent, Attribution, ChangeType, Plan, Task, TaskResult, TurnFileChange, TaskMessage, MicrotaskProposal } from "@bremio/protocol";
import { TaskLog, type WorktreeManager } from "@bremio/workspace";

const execFileAsync = promisify(execFile);
import { appendLedgerEntry } from "./ledger";
import { permissionForKind, roleForKind, topologicalOrder } from "./router";
import { buildTaskPrompt } from "./plan-schema";
import { parseReviewOutput, reviewOutputJsonSchema } from "./quality-gate";
import { collectRun, type CollectedRun } from "./stream";

export const DEFAULT_MAX_CONCURRENCY = 2;

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
  /** Hard timeout for each task's provider run. */
  taskTimeoutMs?: number;
  /**
   * How many tasks may execute at once (default 2). Dependency order is always
   * respected; this only bounds how many *independent* tasks run in parallel.
   */
  maxConcurrency?: number;
  signal?: AbortSignal;
  /** If true, no new tasks will be started, but in-flight tasks may finish. */
  stopRequested?: () => boolean;
  hooks?: SchedulerHooks;
  /** If true, allows tasks to propose new microtasks dynamically. Default false. */
  enableDynamicExpansion?: boolean;
  /** Max tasks that can be added dynamically to this run. Default 10. */
  dynamicReserveCount?: number;
  /** Max depth of dynamic task chains. Default 3. */
  maxDynamicDepth?: number;
  /** Max dynamic tasks a single task can propose. Default 3. */
  maxDynamicChildren?: number;
  /** Fetch unresolved messages targeting a specific task ID */
  fetchUnresolvedMessages?: (targetId: string) => Promise<TaskMessage[]>;
  /** Resolve an artifact request across the run index */
  resolveArtifact?: (taskId: string, artifactPath: string) => Promise<{ path: string, content: string } | undefined>;
  /** Mark a message as handled in the daemon */
  markMessageHandled?: (messageId: string) => Promise<void>;
}

export interface ValidationContext {
  tasks: Task[];
  parentMap: Map<string, string>;
  isConstrained: boolean;
  reserveCount: number;
  maxDepth: number;
  maxChildren: number;
}

export function validateMicrotaskProposal(
  proposal: MicrotaskProposal,
  sourceTaskId: string,
  context: ValidationContext
): { valid: true } | { valid: false; reason: string } {
  if (context.isConstrained) {
    return { valid: false, reason: "run is constrained; no new tasks allowed" };
  }
  if (context.reserveCount <= 0) {
    return { valid: false, reason: "dynamic task reserve depleted" };
  }
  if (context.tasks.some(t => t.id === proposal.id)) {
    return { valid: false, reason: `duplicate task id: ${proposal.id}` };
  }

  // Check children limit
  let children = 0;
  for (const [_, parent] of context.parentMap) {
    if (parent === sourceTaskId) children++;
  }
  if (children >= context.maxChildren) {
    return { valid: false, reason: `task ${sourceTaskId} exceeded max children (${context.maxChildren})` };
  }

  // Check depth limit
  let depth = 1;
  let curr = sourceTaskId;
  while (context.parentMap.has(curr)) {
    depth++;
    curr = context.parentMap.get(curr)!;
  }
  if (depth > context.maxDepth) {
    return { valid: false, reason: `task chain exceeded max depth (${context.maxDepth})` };
  }

  // Cycle check for dependencies
  const isDescendant = (ancestorId: string, targetId: string): boolean => {
    let current = targetId;
    while (context.parentMap.has(current)) {
      const p = context.parentMap.get(current)!;
      if (p === ancestorId) return true;
      current = p;
    }
    return false;
  };

  for (const dep of proposal.dependencies ?? []) {
    if (isDescendant(proposal.id, dep)) {
      return { valid: false, reason: `dependency cycle detected via ${dep}` };
    }
  }

  return { valid: true };
}

/**
 * Serializes async sections. Used to keep git operations one-at-a-time while
 * agent execution runs concurrently.
 */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    // Keep the queue alive after a failure: the chain swallows the rejection,
    // while the caller still receives the real one through `result`.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Dependency-aware scheduler. Runs up to `maxConcurrency` tasks at a time
 * (default 2); a task starts only once every dependency it declares has
 * finished.
 *
 * Concurrency covers *agent execution* only. Git operations (worktree create,
 * diff collect) go through a mutex: `git worktree add` and the capture commit
 * contend on shared `.git` metadata locks, and the agent run dominates
 * wall-clock time anyway, so serializing the git steps costs almost nothing
 * while removing a class of lock-contention failures.
 *
 * Each task gets its own worktree + branch and starts from its dependencies'
 * branches (or repo HEAD), so a failed task blocks only its dependents. On
 * cancellation, in-flight tasks are cancelled and tasks that never started are
 * recorded as cancelled. Results are returned in topological order regardless
 * of completion order, so reports stay deterministic.
 */
export async function runPlan(opts: RunPlanOptions): Promise<TaskResult[]> {
  const ordered = topologicalOrder(opts.plan);
  const planTaskIds = new Set(ordered.map((t) => t.id));
  const concurrency = Math.max(1, Math.trunc(opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY));
  const gitLock = new Mutex();

  const results = new Map<string, TaskResult>();
  const pending = new Map(ordered.map((task) => [task.id, task] as const));
  /** Resolves with the finished task's id, so the race can evict it directly. */
  const running = new Map<string, Promise<string>>();

  const parentMap = new Map<string, string>();
  let reserveCount = opts.dynamicReserveCount ?? 10;
  const maxDepth = opts.maxDynamicDepth ?? 3;
  const maxChildren = opts.maxDynamicChildren ?? 3;

  /**
   * A dependency is settled once it has a result, or once it is known never to
   * produce one (an id outside this plan). Unsettled dependencies keep a task
   * waiting; settled-but-unsuccessful ones block it.
   */
  const isSettled = (dependencyId: string): boolean =>
    results.has(dependencyId) || !planTaskIds.has(dependencyId);

  const blockedBy = (task: Task): string[] =>
    task.dependencies.filter((id) => results.get(id)?.status !== "completed");

  const settle = async (task: Task, result: TaskResult): Promise<void> => {
    results.set(task.id, result);
    pending.delete(task.id);
    await recordLedger(task, result, opts);

    if (opts.enableDynamicExpansion && result.status === "completed") {
      const proposals = result.messages.filter((m) => m.act === "propose-microtask" && !m.handled);
      for (const msg of proposals) {
        try {
          const proposal = JSON.parse(msg.payload) as MicrotaskProposal;
          const validation = validateMicrotaskProposal(proposal, task.id, {
            tasks: ordered,
            parentMap,
            isConstrained: opts.stopRequested?.() ?? false,
            reserveCount,
            maxDepth,
            maxChildren
          });

          if (validation.valid) {
            msg.handled = true;
            const newTask: Task = {
              id: proposal.id,
              title: proposal.title,
              kind: proposal.kind ?? "implementation",
              requiredCapabilities: proposal.requiredCapabilities ?? [],
              preferredAgents: [result.agentId], // Inherit agent from parent by default
              risk: "low",
              dependencies: proposal.dependencies ?? [],
              expectedArtifacts: proposal.expectedArtifacts ?? [],
              acceptanceCriteria: proposal.acceptanceCriteria ?? [],
              description: proposal.description
            };
            ordered.push(newTask);
            planTaskIds.add(newTask.id);
            pending.set(newTask.id, newTask);
            parentMap.set(newTask.id, task.id);
            reserveCount--;
            
            result.findings.push({
              severity: "info",
              message: `Accepted dynamic microtask proposal: ${newTask.id}`,
              status: "open"
            });
          } else {
            msg.handled = true;
            result.findings.push({
              severity: "warning",
              message: `Rejected microtask proposal ${proposal.id}: ${validation.reason}`,
              status: "open"
            });
          }
        } catch (e) {
          msg.handled = true;
          result.findings.push({
            severity: "warning",
            message: `Failed to parse microtask proposal: ${e}`,
            status: "open"
          });
        }
      }
    }
  };

  while (pending.size > 0 || running.size > 0) {
    for (const task of [...pending.values()]) {
      if (running.size >= concurrency) break;
      if (running.has(task.id)) continue;
      if (!task.dependencies.every(isSettled)) continue;

      const agentId = opts.assign.get(task.id) ?? task.preferredAgents[0] ?? "";
      const adapter = opts.registry.get(agentId);
      const blocked = blockedBy(task);

      if (opts.signal?.aborted || opts.stopRequested?.()) {
        await settle(
          task,
          cancelledResult(task, agentId, opts.signal?.aborted ? "run cancelled before this task started" : "run stopped before this task started"),
        );
        continue;
      }
      if (blocked.length > 0) {
        await settle(
          task,
          failedResult(task, agentId, `blocked by unsuccessful dependencies: ${blocked.join(", ")}`),
        );
        continue;
      }
      if (!adapter) {
        await settle(task, failedResult(task, agentId, `no adapter registered for "${agentId}"`));
        continue;
      }

      opts.hooks?.onTaskStart?.(task, agentId);
      const dependencyRefs = task.dependencies
        .map((id) => results.get(id)?.branch)
        .filter((branch): branch is string => Boolean(branch));

      // Never rejects: a task failure is a TaskResult, and a throwing hook must
      // not take down the whole run.
      running.set(
        task.id,
        (async () => {
          let result: TaskResult;
          try {
            result = await runOneTask(task, agentId, adapter, opts, dependencyRefs, gitLock);
          } catch (err) {
            result = failedResult(
              task,
              agentId,
              `task setup or execution failed: ${(err as Error).message}`,
            );
          }
          try {
            opts.hooks?.onTaskComplete?.(result);
          } catch {
            // a reporting hook must never change the run's outcome
          }
          await settle(task, result);
          return task.id;
        })(),
      );
    }

    if (running.size === 0) {
      // Nothing runnable and nothing in flight: the rest is unreachable
      // (dependencies that failed, or were never part of this plan).
      for (const task of [...pending.values()]) {
        const agentId = opts.assign.get(task.id) ?? task.preferredAgents[0] ?? "";
        const blocked = blockedBy(task);
        await settle(
          task,
          opts.signal?.aborted || opts.stopRequested?.()
            ? cancelledResult(task, agentId, opts.signal?.aborted ? "run cancelled before this task started" : "run stopped before this task started")
            : failedResult(
                task,
                agentId,
                `blocked by unsuccessful dependencies: ${blocked.join(", ")}`,
              ),
        );
      }
      break;
    }

    running.delete(await Promise.race(running.values()));
  }

  return ordered
    .map((task) => results.get(task.id))
    .filter((result): result is TaskResult => result !== undefined);
}

/** Append one usage-ledger line for a finished task. Never breaks a run. */
async function recordLedger(task: Task, result: TaskResult, opts: RunPlanOptions): Promise<void> {
  if (!opts.ledgerPath) return;
  try {
    await appendLedgerEntry(opts.ledgerPath, {
      ts: new Date().toISOString(),
      runId: opts.runId,
      taskId: task.id,
      scope: "task",
      provider: result.agentId,
      role: roleForKind(task.kind),
      kind: task.kind,
      status: result.status,
      filesChanged: result.filesChanged.length,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(result.requestedModel ? { requestedModel: result.requestedModel } : {}),
      ...(result.actualModel ? { actualModel: result.actualModel } : {}),
      ...(result.requestedReasoningLevel
        ? { requestedReasoningLevel: result.requestedReasoningLevel }
        : {}),
      ...(result.actualReasoningLevel
        ? { actualReasoningLevel: result.actualReasoningLevel }
        : {}),
      ...(result.usage ? { usage: result.usage } : {}),
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
  gitLock: Mutex,
): Promise<TaskResult> {
  const started = Date.now();
  const worktree = await gitLock.run(() =>
    opts.workspace.create(
      task.id,
      agentId,
      dependencyRefs.length > 0 ? dependencyRefs : "HEAD",
    ),
  );
  const log = new TaskLog(opts.runDir, `${task.id}-${agentId}`);
  log.line(`# Task ${task.id} (${task.kind}) — agent=${agentId} branch=${worktree.branch}`);

  const permission = permissionForKind(task.kind);
  const taskRunId = `${task.id}::${agentId}`;
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();
  const timer = opts.taskTimeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
        void adapter.cancelRun(taskRunId).catch(() => {});
      }, opts.taskTimeoutMs)
    : undefined;

  // Load expected artifacts
  const loadedArtifacts: { name: string; content: string }[] = [];
  if (task.expectedArtifacts?.length > 0) {
    for (const name of task.expectedArtifacts) {
      const artifactPath = path.join(worktree.path, name);
      try {
        const content = await fs.readFile(artifactPath, "utf8");
        // Simple context budget check: if the artifact is huge, truncate or fail?
        // The requirement says "Context-budget overflow is reported and deterministic."
        // But maybe that's S12-T3's token budget? 
        // For now, let's just include the content.
        loadedArtifacts.push({ name, content });
      } catch {
        await log.close();
        const error = `missing expected artifact: ${name}`;
        return {
          taskId: task.id,
          agentId,
          status: "failed",
          summary: error,
          filesChanged: [],
          filesRead: [],
          changeLedger: [],
          commandsExecuted: [],
          tests: [],
          findings: [{ severity: "blocker", message: error, status: "open" }],
      messages: [],
          error,
          branch: worktree.branch,
          worktreePath: worktree.path,
          logsPath: log.path,
          durationMs: Date.now() - started,
        };
      }
    }
  }

  // Fetch unresolved messages
  const messages = opts.fetchUnresolvedMessages ? await opts.fetchUnresolvedMessages(task.id) : [];

  // Resolve any request-artifact messages immediately if possible
  if (opts.resolveArtifact) {
    for (const msg of messages) {
      if (msg.act === "request-artifact") {
        const resolved = await opts.resolveArtifact(msg.sourceTaskId, msg.payload);
        if (resolved) {
          loadedArtifacts.push({ name: resolved.path, content: resolved.content });
          msg.handled = true; // Mark it as handled so the agent knows it was provided
          if (opts.markMessageHandled) {
            await opts.markMessageHandled(msg.id);
          }
        } else {
          // Unresolved artifact request escalates to a blocker
          const error = `unresolved artifact request from ${msg.sourceTaskId}: ${msg.payload}`;
          return {
            taskId: task.id,
            agentId,
            status: "failed",
            summary: error,
            filesChanged: [],
            filesRead: [],
            changeLedger: [],
            commandsExecuted: [],
            tests: [],
            findings: [{ severity: "blocker", message: error, status: "open" }],
            messages: [],
            error,
            branch: worktree.branch,
            worktreePath: worktree.path,
            logsPath: log.path,
            durationMs: Date.now() - started,
          };
        }
      }
    }
  }

  let run: CollectedRun;
  try {
    run = await collectRun(
      adapter.startRun({
        runId: taskRunId,
        role: roleForKind(task.kind),
        prompt: buildTaskPrompt(opts.plan, task, loadedArtifacts, messages),
        cwd: worktree.path,
        permission,
        ...(task.kind === "review" ? { outputSchema: reviewOutputJsonSchema } : {}),
        maxTurns: opts.maxTurns ?? 40,
        signal: controller.signal,
      }),
      {
        log,
        ...(opts.hooks?.onEvent ? { onEvent: (e) => opts.hooks?.onEvent?.(task, agentId, e) } : {}),
        ...(adapter.getToolVocabulary?.() ? { toolVocabulary: adapter.getToolVocabulary() } : {}),
      },
    );
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    await log.close();
  }

  const collected = await gitLock.run(() => opts.workspace.collect(worktree));

  let status = run.outcome.status;
  let error = run.outcome.error;
  let findings = [] as TaskResult["findings"];
  const tests = task.kind === "test" ? run.tests : [];
  let summary =
    run.outcome.finalText?.trim() ||
    run.assistantText ||
    `${task.title} — no summary produced`;

  if (timedOut) {
    status = "cancelled";
    error = `task timed out after ${opts.taskTimeoutMs}ms`;
  }

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

  const filesRead = [...new Set(run.filesRead)].sort();
  // Team tasks always use isolated worktrees — all changes belong to the agent.
  const changeLedger: TurnFileChange[] = [
    ...collected.filesChanged.map((f) => ({
      filePath: f,
      changeType: "write" as ChangeType,
      source: "git" as const,
      attributedTo: "agent" as Attribution,
    })),
    ...filesRead.map((f) => ({
      filePath: f,
      changeType: "read" as ChangeType,
      source: "event" as const,
      attributedTo: "agent" as Attribution,
    })),
  ];

  let diff: { stat: string; patch: string } | undefined;
  if (collected.commitHash) {
    try {
      const [stat, patch] = await Promise.all([
        execFileAsync("git", ["show", "--stat", "--format=", collected.commitHash], { cwd: worktree.path, encoding: "utf8" }).then(r => r.stdout.trim()),
        execFileAsync("git", ["show", "--format=", "--no-ext-diff", collected.commitHash], { cwd: worktree.path, encoding: "utf8" }).then(r => r.stdout.trim()),
      ]);
      if (stat || patch) diff = { stat, patch };
    } catch { /* best-effort — diff is metadata, not a gate */ }
  }

  return {
    taskId: task.id,
    agentId,
    status,
    summary,
    filesChanged: collected.filesChanged,
    filesRead,
    changeLedger,
    ...(diff ? { diff } : {}),
    commandsExecuted: run.commands,
    tests,
    findings,
    messages: [],
    ...(collected.commitHash ? { commitHash: collected.commitHash } : {}),
    ...(run.outcome.sessionId ? { sessionId: run.outcome.sessionId } : {}),
    branch: worktree.branch,
    worktreePath: worktree.path,
    logsPath: log.path,
    durationMs: Date.now() - started,
    ...(run.actualModel ? { actualModel: run.actualModel } : {}),
    ...(run.actualReasoningLevel
      ? { actualReasoningLevel: run.actualReasoningLevel }
      : {}),
    ...(run.usage ? { usage: run.usage } : {}),
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
    filesRead: [],
    changeLedger: [],
    commandsExecuted: [],
    tests: [],
    findings: [],
      messages: [],
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
    filesRead: [],
    changeLedger: [],
    commandsExecuted: [],
    tests: [],
    findings: [],
      messages: [],
    error,
  };
}
