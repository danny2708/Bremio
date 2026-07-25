import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceStrategy } from "@bremio/policy";
import type { AgentEvent, ReasoningLevel, TaskStatus, TestRun, UsageSummary } from "@bremio/protocol";
import { prepareTurnExecution, type TurnMechanismDecision } from "@bremio/harness";
import { TaskLog, WorktreeManager, type TaskWorktree } from "@bremio/workspace";
import { appendLedgerEntry, ledgerPathFor } from "./ledger";
import type { AgentRegistry } from "./registry";
import { createRunId } from "./run";
import { collectRun, type CollectedRun } from "./stream";

const execFileAsync = promisify(execFile);

export interface SingleRunHooks {
  onWorkspaceReady?(dirtyFiles: readonly string[]): void;
  onStart?(agentId: string): void;
  onEvent?(event: AgentEvent): void;
  onComplete?(result: SingleAgentResult): void;
}

export interface RunSingleAgentOptions {
  primaryAgentId: string;
  repoPath: string;
  prompt: string;
  registry: AgentRegistry;
  workspaceStrategy?: WorkspaceStrategy;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  maxTurns?: number;
  timeoutMs?: number;
  comparisonId?: string;
  signal?: AbortSignal;
  hooks?: SingleRunHooks;
  sessionId?: string;
  turnIndex?: number;
  priorTurns?: Array<{
    turnIndex: number;
    prompt: string;
    finalText?: string;
    summary?: string;
    measuredInputTokens?: number;
  }>;
  providerSessionId?: string;
}

export interface SingleAgentResult {
  status: TaskStatus;
  summary: string;
  filesChanged: string[];
  commandsExecuted: string[];
  tests: TestRun[];
  sessionId?: string;
  logsPath: string;
  durationMs: number;
  requestedModel?: string;
  actualModel?: string;
  requestedReasoningLevel?: ReasoningLevel;
  actualReasoningLevel?: ReasoningLevel;
  usage?: UsageSummary;
  error?: string;
}

export interface SingleRunVerification {
  status: "passed" | "failed" | "unverified";
  reasons: string[];
}

export interface SingleRunFallback {
  fromMode: "team";
  teamRunId: string;
  reason: string;
  baselineRunId: string;
  baselineTaskCostUsd: number;
  orchestrationCostUsd: number;
  maxOrchestrationCostShare: number;
}

export interface SingleRunReport {
  mode: "single";
  runId: string;
  createdAt: string;
  prompt: string;
  primaryAgentId: string;
  repoPath: string;
  runDir: string;
  workspaceStrategy?: WorkspaceStrategy;
  worktree?: {
    branch: string;
    path: string;
  };
  result: SingleAgentResult;
  verification: SingleRunVerification;
  workspace: {
    dirtyBefore: string[];
    dirtyAfter: string[];
  };
  turnIndex?: number;
  mechanismDecision?: TurnMechanismDecision;
  /** Present only when Team stopped before task execution and delegated here. */
  fallback?: SingleRunFallback;
}

interface WorkspaceState {
  head?: string;
  dirtyFiles: string[];
}

/** Direct pass-through execution: exactly one adapter run on the selected workspace. */
export async function runSingleAgent(opts: RunSingleAgentOptions): Promise<SingleRunReport> {
  const repoPath = path.resolve(opts.repoPath);
  const stat = await fs.stat(repoPath).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`workspace does not exist: ${repoPath}`);
  await assertGitWorkspace(repoPath);

  const adapter = opts.registry.get(opts.primaryAgentId);
  if (!adapter) {
    throw new Error(
      `agent "${opts.primaryAgentId}" is not registered ` +
        `(available: ${[...opts.registry.keys()].join(", ") || "none"})`,
    );
  }
  const capabilities = await adapter.getCapabilities();
  if (!capabilities.repositoryRead || !capabilities.repositoryWrite) {
    throw new Error(`agent "${opts.primaryAgentId}" cannot run with workspace-write access`);
  }

  const workspaceStrategy = opts.workspaceStrategy ?? "direct-workspace";
  const runId = createRunId();
  const before = await captureWorkspaceState(repoPath);
  opts.hooks?.onWorkspaceReady?.(before.dirtyFiles);

  let targetCwd = repoPath;
  let taskWorktree: TaskWorktree | undefined;
  let worktreeManager: WorktreeManager | undefined;

  if (workspaceStrategy === "isolated-worktree") {
    worktreeManager = new WorktreeManager(repoPath, { runToken: runId.slice(-6) });
    await worktreeManager.assertUsable();
    taskWorktree = await worktreeManager.create("SOLO", opts.primaryAgentId);
    targetCwd = taskWorktree.path;
  }

  const bremioDir = path.join(repoPath, ".bremio");
  const runDir = path.join(bremioDir, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(bremioDir, ".gitignore"),
    "*\n",
    { encoding: "utf8", flag: "wx" },
  ).catch(() => {});

  const log = new TaskLog(runDir, `single-${opts.primaryAgentId}`);
  log.line(`# Single Agent run — agent=${opts.primaryAgentId} cwd=${targetCwd}`);
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => {
    controller.abort();
    void adapter.cancelRun(runId).catch(() => {});
  };
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (opts.signal?.aborted) onExternalAbort();
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
        void adapter.cancelRun(runId).catch(() => {});
      }, opts.timeoutMs)
    : undefined;

  opts.hooks?.onStart?.(opts.primaryAgentId);
  let collected: CollectedRun;
  let mechanismDecision: TurnMechanismDecision | undefined;

  try {
    if (opts.priorTurns && opts.priorTurns.length > 0) {
      const execution = await prepareTurnExecution({
        adapter,
        sessionId: opts.sessionId ?? runId,
        turnIndex: opts.turnIndex ?? opts.priorTurns.length,
        priorTurns: opts.priorTurns,
        providerSessionId: opts.providerSessionId,
        currentDiff: before.dirtyFiles.length > 0 ? before.dirtyFiles.join("\n") : undefined,
        newPrompt: opts.prompt,
        request: {
          runId,
          role: "implementer",
          cwd: targetCwd,
          permission: "workspace-write",
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
          ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
          signal: controller.signal,
          metadata: { executionMode: "single" },
        },
      });

      mechanismDecision = execution.decision;
      collected = await collectRun(execution.run(), {
        log,
        ...(opts.hooks?.onEvent ? { onEvent: opts.hooks.onEvent } : {}),
      });
    } else {
      mechanismDecision = {
        mechanism: "re-inject",
        reason: "initial turn of single-agent run",
      };
      collected = await collectRun(
        adapter.startRun({
          runId,
          role: "implementer",
          prompt: opts.prompt,
          cwd: targetCwd,
          permission: "workspace-write",
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
          ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
          signal: controller.signal,
          metadata: { executionMode: "single" },
        }),
        { log, ...(opts.hooks?.onEvent ? { onEvent: opts.hooks.onEvent } : {}) },
      );
    }
  } catch (error) {
    collected = {
      outcome: { status: controller.signal.aborted ? "cancelled" : "failed", error: (error as Error).message },
      assistantText: "",
      commands: [],
      tests: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    await log.close();
  }

  let filesChanged: string[];
  let after = before;
  if (workspaceStrategy === "isolated-worktree" && worktreeManager && taskWorktree) {
    const collectRes = await worktreeManager.collect(taskWorktree);
    filesChanged = collectRes.filesChanged;
  } else {
    after = await captureWorkspaceState(repoPath);
    const committedFiles = await filesChangedBetween(repoPath, before.head, after.head);
    filesChanged = [...new Set([...committedFiles, ...after.dirtyFiles])].sort();
  }
  let status = collected.outcome.status;
  let error = collected.outcome.error;
  if (timedOut) {
    status = "cancelled";
    error = `single-agent run timed out after ${opts.timeoutMs}ms`;
  }
  const result: SingleAgentResult = {
    status,
    summary: collected.outcome.finalText?.trim() ||
      collected.assistantText ||
      "Agent produced no summary.",
    filesChanged,
    commandsExecuted: collected.commands,
    tests: collected.tests,
    ...(collected.outcome.sessionId ? { sessionId: collected.outcome.sessionId } : {}),
    logsPath: log.path,
    durationMs: Date.now() - started,
    ...(opts.model ? { requestedModel: opts.model } : {}),
    ...(collected.actualModel ? { actualModel: collected.actualModel } : {}),
    ...(opts.reasoningLevel ? { requestedReasoningLevel: opts.reasoningLevel } : {}),
    ...(collected.actualReasoningLevel
      ? { actualReasoningLevel: collected.actualReasoningLevel }
      : {}),
    ...(collected.usage ? { usage: collected.usage } : {}),
    ...(error ? { error } : {}),
  };
  const verification = verifySingleResult(result);
  const report: SingleRunReport = {
    mode: "single",
    runId,
    createdAt: new Date().toISOString(),
    prompt: opts.prompt,
    primaryAgentId: opts.primaryAgentId,
    repoPath,
    runDir,
    workspaceStrategy,
    ...(taskWorktree ? { worktree: { branch: taskWorktree.branch, path: taskWorktree.path } } : {}),
    result,
    verification,
    workspace: { dirtyBefore: before.dirtyFiles, dirtyAfter: after.dirtyFiles },
    ...(opts.turnIndex !== undefined ? { turnIndex: opts.turnIndex } : {}),
    ...(mechanismDecision ? { mechanismDecision } : {}),
  };

  await fs.writeFile(
    path.join(runDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  await recordSingleLedger(report, opts.comparisonId);
  opts.hooks?.onComplete?.(result);
  return report;
}

/** Escalation is offered only after a Single run fails its objective verification,
 * not on any failure signal the model reports about itself. A run that itself
 * failed (crash, timeout, cancel) does not qualify — only a completed run whose
 * verification (test/lint/build) failed or was missing.
 */
export function shouldEscalate(report: SingleRunReport): boolean {
  if (report.result.status !== "completed") return false;
  return report.verification.status !== "passed";
}

export type EscalationApproval =
  | { approved: true; via: "flag" | "prompt" }
  | { approved: false; reason: string };

/**
 * Whether an *eligible* escalation may actually run.
 *
 * `shouldEscalate` only says a Single run qualifies to be offered; it never
 * authorises spending a second run's quota. That authority is here, and it is
 * deliberately a separate, pure decision so the guarantee "escalation never
 * runs without approval" can be proven rather than asserted — the CLI's flag
 * and terminal handling are inputs to it, not a place where the rule lives.
 *
 * Fail closed: with no flag and no terminal to ask in, the answer is no. A
 * non-interactive context (CI, a pipe) must never silently pay twice, which is
 * the double-pay trap in `docs/05` R5.
 */
export function resolveEscalationApproval(input: {
  escalateFlag: boolean;
  interactive: boolean;
  answer?: string;
}): EscalationApproval {
  if (input.escalateFlag) return { approved: true, via: "flag" };
  if (!input.interactive) {
    return {
      approved: false,
      reason: "not a terminal; pass --escalate to approve escalation",
    };
  }
  const answer = (input.answer ?? "").trim().toLowerCase();
  if (answer === "y" || answer === "yes") return { approved: true, via: "prompt" };
  return { approved: false, reason: "escalation declined" };
}

function verifySingleResult(result: SingleAgentResult): SingleRunVerification {
  if (result.status !== "completed") {
    return { status: "failed", reasons: [result.error ?? `agent run ${result.status}`] };
  }
  const finalEvidence = result.tests.filter((run) =>
    isVerificationCommand(run.command)).at(-1);
  if (!finalEvidence) {
    return {
      status: "unverified",
      reasons: ["agent completed without recognizable test, lint, build, or check evidence"],
    };
  }
  if (finalEvidence.exitCode !== 0) {
    return {
      status: "failed",
      reasons: [`verification command exited ${finalEvidence.exitCode}: ${finalEvidence.command}`],
    };
  }
  return { status: "passed", reasons: [] };
}

function isVerificationCommand(command: string): boolean {
  return [
    /\b(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun)\s+(?:run\s+)?(?:test|verify|check|lint|build|typecheck)(?=['"\s:]|$)/i,
    /\bnode(?:\.exe)?\s+--test\b/i,
    /\b(?:pytest|vitest|jest|tsc|unittest)\b/i,
    /\b(?:cargo|go|dotnet)\s+test\b/i,
    /\b(?:mvnw?|gradlew?)\b[^\r\n]*\b(?:test|check|build)\b/i,
  ].some((pattern) => pattern.test(command));
}

async function recordSingleLedger(
  report: SingleRunReport,
  comparisonId: string | undefined,
): Promise<void> {
  const { result } = report;
  const common = {
    ...(comparisonId ? { comparisonId } : {}),
    flowMode: "single-agent" as const,
  };
  try {
    await appendLedgerEntry(ledgerPathFor(report.repoPath), {
      ts: new Date().toISOString(),
      runId: report.runId,
      taskId: `${report.runId}::single`,
      scope: "task",
      provider: report.primaryAgentId,
      role: "implementer",
      kind: "single-run",
      status: result.status,
      filesChanged: result.filesChanged.length,
      durationMs: result.durationMs,
      ...(result.requestedModel ? { requestedModel: result.requestedModel } : {}),
      ...(result.actualModel ? { actualModel: result.actualModel } : {}),
      ...(result.requestedReasoningLevel
        ? { requestedReasoningLevel: result.requestedReasoningLevel }
        : {}),
      ...(result.actualReasoningLevel
        ? { actualReasoningLevel: result.actualReasoningLevel }
        : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...common,
    });
    await appendLedgerEntry(ledgerPathFor(report.repoPath), {
      ts: new Date().toISOString(),
      runId: report.runId,
      taskId: `${report.runId}::summary`,
      scope: "run",
      provider: "bremio",
      role: "orchestrator",
      kind: "run-summary",
      status: result.status,
      filesChanged: 0,
      outcomeVerified: report.verification.status === "passed",
      ...common,
    });
  } catch {
    // measurement is best-effort; it must never replace the direct run result
  }
}

async function captureWorkspaceState(repoPath: string): Promise<WorkspaceState> {
  try {
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repoPath, encoding: "utf8" },
    );
    const head = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repoPath, encoding: "utf8" },
    ).then(({ stdout }) => stdout.trim()).catch(() => undefined);
    return {
      ...(head ? { head } : {}),
      dirtyFiles: parsePorcelainStatus(status),
    };
  } catch {
    return { dirtyFiles: [] };
  }
}

async function assertGitWorkspace(repoPath: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: repoPath, encoding: "utf8" },
    );
    if (stdout.trim() === "true") return;
  } catch {
    // fall through to one stable user-facing error
  }
  throw new Error(`workspace is not a git repository: ${repoPath}`);
}

function parsePorcelainStatus(status: string): string[] {
  const records = status.split("\0");
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    files.push(record.slice(3));
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return files.sort();
}

async function filesChangedBetween(
  repoPath: string,
  beforeHead: string | undefined,
  afterHead: string | undefined,
): Promise<string[]> {
  if (!beforeHead || !afterHead || beforeHead === afterHead) return [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", beforeHead, afterHead],
      { cwd: repoPath, encoding: "utf8" },
    );
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}
