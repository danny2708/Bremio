import {
  CommandTool,
  processSupervisor,
  type AgentAdapter,
  type AgentRunRequest,
  type AgentToolVocabulary,
  type ProcessSupervisor,
} from "@bremio/adapter-sdk";
import { evaluate, type ControlMode } from "@bremio/policy";
import type { AgentEvent, TestRun, UsageSummary } from "@bremio/protocol";
import { TaskLog } from "@bremio/workspace";
import { FIX_EVIDENCE_TAIL_BYTES, fixLoopPolicyBlock, type FixLoopStatus } from "./fix-loop";
import { collectRun, withErrorCode, type CollectedRun } from "./stream";

/**
 * Single-mode verify → fix loop (P2-T4, docs/17, docs/19).
 *
 * Bremio — not the agent — runs a user-declared verification command after
 * the agent's turn. On failure the agent gets the failing command and a
 * bounded output tail, in its resumed provider session when the adapter
 * supports resume, otherwise in a fresh turn carrying the prior summary.
 */

export interface VerificationRun {
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  /** Last FIX_EVIDENCE_TAIL_BYTES of combined stdout/stderr. */
  outputTail: string;
}

export interface SingleFixAttempt {
  iteration: number;
  /** How the fix reached the agent. */
  mechanism: "resume" | "fresh-turn";
  /** Verification exit code that triggered this attempt. */
  triggeredByExitCode: number;
  /** Status of the agent's fix turn. */
  turnStatus: "completed" | "failed" | "cancelled";
  costUsd?: number;
}

export interface SingleFixLoopReport {
  status: FixLoopStatus;
  reason?: string;
  verifyCommand: string;
  maxIterations: number;
  /** Every verification Bremio ran, in order (the last one decides). */
  verifications: Array<Omit<VerificationRun, "outputTail">>;
  attempts: SingleFixAttempt[];
}

/** Why policy forbids Bremio from running the verification command itself. */
export function verificationPolicyBlock(controlMode: ControlMode): string | undefined {
  const rule = evaluate(controlMode, "command");
  if (!rule.allowed) return `${controlMode} mode does not allow Bremio to run commands: ${rule.reason}`;
  if (rule.approvalRequired !== "none") {
    return `${controlMode} mode requires ${rule.approvalRequired} approval for commands; --verify cannot run unattended`;
  }
  return undefined;
}

/**
 * Run the verification command through `CommandTool`, so the spawn is
 * policy-checked and owned by the process supervisor (cancel = tree kill).
 */
export async function runVerification(input: {
  command: string;
  cwd: string;
  runId: string;
  controlMode: ControlMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  supervisor?: ProcessSupervisor;
}): Promise<VerificationRun> {
  const supervisor = input.supervisor ?? processSupervisor;
  const tool = new CommandTool(supervisor, () => {
    const block = verificationPolicyBlock(input.controlMode);
    return block ? { allowed: false, reason: block } : { allowed: true, reason: "allowed by policy" };
  });
  const [shell, args] = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", input.command]]
    : ["sh", ["-c", input.command]];
  const supervisedId = `${input.runId}::verify`;
  try {
    const result = await tool.execute(shell, args, {
      runId: supervisedId,
      cwd: input.cwd,
      ...(input.timeoutMs ? { timeout: input.timeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    return {
      command: input.command,
      exitCode: result.timedOut ? 124 : result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.duration,
      outputTail: output.length > FIX_EVIDENCE_TAIL_BYTES ? output.slice(-FIX_EVIDENCE_TAIL_BYTES) : output,
    };
  } finally {
    supervisor.release(supervisedId);
  }
}

export function verificationAsTestRun(run: VerificationRun): TestRun {
  return {
    command: run.command,
    passed: run.exitCode === 0 ? 1 : 0,
    failed: run.exitCode === 0 ? 0 : 1,
    exitCode: run.exitCode,
  };
}

/** The message a fix turn receives. Resume turns omit the original request. */
export function buildSingleFixPrompt(input: {
  originalPrompt: string;
  priorSummary?: string;
  verification: VerificationRun;
  iteration: number;
  mechanism: "resume" | "fresh-turn";
}): string {
  const lines: string[] = [];
  if (input.mechanism === "fresh-turn") {
    lines.push(
      "You previously worked on this request in the current workspace:",
      input.originalPrompt,
      "",
    );
    if (input.priorSummary) lines.push("Your previous summary:", input.priorSummary, "");
  }
  lines.push(
    `Bremio ran the verification command and it failed (fix attempt ${input.iteration}).`,
    "",
    "FAILURE EVIDENCE:",
    `command: ${input.verification.command}`,
    `exit code: ${input.verification.exitCode}${input.verification.timedOut ? " (timed out)" : ""}`,
    "output tail:",
    input.verification.outputTail || "(no output)",
    "",
    "Fix the root cause so this command passes. Do not weaken, skip or delete tests.",
  );
  return lines.join("\n");
}

export interface SingleVerifyLoopInput {
  adapter: AgentAdapter;
  resumable: boolean;
  initial: CollectedRun;
  originalPrompt: string;
  verifyCommand: string;
  maxIterations: number;
  maxCostUsd?: number;
  controlMode: ControlMode;
  cwd: string;
  runId: string;
  runDir: string;
  /** Base request fields reused by every fix turn. */
  request: Pick<AgentRunRequest, "model" | "reasoningLevel" | "maxTurns">;
  timeoutMs?: number;
  signal?: AbortSignal;
  stopRequested?: () => boolean;
  toolVocabulary?: AgentToolVocabulary;
  onEvent?: (event: AgentEvent) => void;
  supervisor?: ProcessSupervisor;
}

export interface SingleVerifyLoopResult {
  collected: CollectedRun;
  report: SingleFixLoopReport;
  lastVerification?: VerificationRun;
}

/** Verify, and while it fails and bounds allow, hand the failure back to the agent. */
export async function runSingleVerifyLoop(input: SingleVerifyLoopInput): Promise<SingleVerifyLoopResult> {
  let collected = input.initial;
  const verifications: VerificationRun[] = [];
  const attempts: SingleFixAttempt[] = [];
  const maxIterations = Math.max(0, Math.trunc(input.maxIterations));
  const finish = (status: FixLoopStatus, reason?: string): SingleVerifyLoopResult => ({
    collected,
    ...(verifications.length > 0 ? { lastVerification: verifications.at(-1)! } : {}),
    report: {
      status,
      ...(reason ? { reason } : {}),
      verifyCommand: input.verifyCommand,
      maxIterations,
      verifications: verifications.map(({ outputTail: _tail, ...rest }) => rest),
      attempts,
    },
  });

  if (collected.outcome.status !== "completed") {
    return finish("stopped", `agent run ${collected.outcome.status}; verification not run`);
  }
  const commandBlock = verificationPolicyBlock(input.controlMode);
  if (commandBlock) return finish("stopped", commandBlock);

  for (;;) {
    if (input.signal?.aborted) return finish("stopped", "run cancelled");
    const verification = await runVerification({
      command: input.verifyCommand,
      cwd: input.cwd,
      runId: input.runId,
      controlMode: input.controlMode,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.supervisor ? { supervisor: input.supervisor } : {}),
    });
    verifications.push(verification);
    collected = { ...collected, tests: [...collected.tests, verificationAsTestRun(verification)] };

    if (verification.exitCode === 0) return finish(attempts.length > 0 ? "passed" : "not-needed");
    if (input.signal?.aborted) return finish("stopped", "run cancelled");
    if (input.stopRequested?.()) return finish("stopped", "run is constrained or a stop was requested");
    if (maxIterations === 0) return finish("disabled", "maxFixIterations is 0");
    if (attempts.length >= maxIterations) {
      return finish(
        "exhausted",
        `reached maxFixIterations (${maxIterations}) with "${input.verifyCommand}" still exiting ${verification.exitCode}`,
      );
    }
    const writeBlock = fixLoopPolicyBlock(input.controlMode);
    if (writeBlock) return finish("stopped", writeBlock);
    if (input.maxCostUsd !== undefined && attempts.length > 0) {
      if (attempts.some((a) => a.costUsd === undefined)) {
        return finish("stopped", "a fix cost budget is set but a fix turn's cost was not provider-reported");
      }
      const spent = attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
      if (spent >= input.maxCostUsd) {
        return finish("stopped", `fix cost budget exhausted ($${spent.toFixed(4)} of $${input.maxCostUsd})`);
      }
    }

    const iteration = attempts.length + 1;
    const sessionId = collected.outcome.sessionId;
    const mechanism: SingleFixAttempt["mechanism"] = input.resumable && sessionId ? "resume" : "fresh-turn";
    const fix = await runFixTurn(input, {
      iteration,
      mechanism,
      prompt: buildSingleFixPrompt({
        originalPrompt: input.originalPrompt,
        priorSummary: collected.outcome.finalText?.trim() || collected.assistantText || undefined,
        verification,
        iteration,
        mechanism,
      }),
      ...(sessionId ? { sessionId } : {}),
    });
    attempts.push({
      iteration,
      mechanism,
      triggeredByExitCode: verification.exitCode,
      turnStatus: fix.outcome.status,
      ...(fix.usage?.costUsd !== undefined ? { costUsd: fix.usage.costUsd } : {}),
    });
    collected = mergeCollected(collected, fix);
    if (fix.outcome.status !== "completed") {
      return finish(
        "stopped",
        `fix turn ${iteration} ${fix.outcome.status} (${fix.outcome.errorCode ?? "unknown"})`,
      );
    }
  }
}

async function runFixTurn(
  input: SingleVerifyLoopInput,
  turn: { iteration: number; mechanism: "resume" | "fresh-turn"; prompt: string; sessionId?: string },
): Promise<CollectedRun> {
  const runId = `${input.runId}-fix-${turn.iteration}`;
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    void input.adapter.cancelRun(runId).catch(() => {});
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  let timedOut = false;
  const timer = input.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        onAbort();
      }, input.timeoutMs)
    : undefined;
  const log = new TaskLog(input.runDir, `single-fix-${turn.iteration}`);
  log.line(`# Single fix turn ${turn.iteration} (${turn.mechanism})`);
  const request: AgentRunRequest = {
    runId,
    role: "implementer",
    prompt: turn.prompt,
    cwd: input.cwd,
    permission: "workspace-write",
    ...(input.request.model ? { model: input.request.model } : {}),
    ...(input.request.reasoningLevel ? { reasoningLevel: input.request.reasoningLevel } : {}),
    ...(input.request.maxTurns !== undefined ? { maxTurns: input.request.maxTurns } : {}),
    signal: controller.signal,
    metadata: { executionMode: "single", fixIteration: turn.iteration },
  };
  try {
    const events = turn.mechanism === "resume" && turn.sessionId
      ? input.adapter.resumeRun(turn.sessionId, request)
      : input.adapter.startRun(request);
    const run = await collectRun(events, {
      log,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      ...(input.toolVocabulary ? { toolVocabulary: input.toolVocabulary } : {}),
    });
    if (timedOut) {
      return {
        ...run,
        outcome: { ...run.outcome, status: "cancelled", errorCode: "timeout", error: `fix turn timed out after ${input.timeoutMs}ms` },
      };
    }
    return run;
  } catch (error) {
    return {
      outcome: withErrorCode({
        status: controller.signal.aborted ? "cancelled" : "failed",
        error: (error as Error).message,
      }),
      assistantText: "",
      commands: [],
      tests: [],
      filesRead: [],
      filesWritten: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    await log.close();
  }
}

/** Combine two turns. Usage dimensions stay unknown unless both turns reported them. */
function mergeCollected(prev: CollectedRun, next: CollectedRun): CollectedRun {
  const usage = mergeUsage(prev.usage, next.usage);
  const actualModel = prev.actualModel && prev.actualModel === next.actualModel ? prev.actualModel : undefined;
  const actualReasoningLevel = prev.actualReasoningLevel && prev.actualReasoningLevel === next.actualReasoningLevel
    ? prev.actualReasoningLevel
    : undefined;
  return {
    outcome: {
      ...next.outcome,
      ...(next.outcome.sessionId ?? prev.outcome.sessionId
        ? { sessionId: next.outcome.sessionId ?? prev.outcome.sessionId }
        : {}),
      ...(next.outcome.finalText ?? prev.outcome.finalText
        ? { finalText: next.outcome.finalText ?? prev.outcome.finalText }
        : {}),
    },
    assistantText: [prev.assistantText, next.assistantText].filter(Boolean).join("\n").trim(),
    commands: [...prev.commands, ...next.commands],
    tests: [...prev.tests, ...next.tests],
    filesRead: [...prev.filesRead, ...next.filesRead],
    filesWritten: [...prev.filesWritten, ...next.filesWritten],
    ...(usage ? { usage } : {}),
    ...(actualModel ? { actualModel } : {}),
    ...(actualReasoningLevel ? { actualReasoningLevel } : {}),
  };
}

function mergeUsage(a: UsageSummary | undefined, b: UsageSummary | undefined): UsageSummary | undefined {
  if (!a || !b) return undefined;
  const out: UsageSummary = {};
  if (a.inputTokens !== undefined && b.inputTokens !== undefined) out.inputTokens = a.inputTokens + b.inputTokens;
  if (a.outputTokens !== undefined && b.outputTokens !== undefined) out.outputTokens = a.outputTokens + b.outputTokens;
  if (a.costUsd !== undefined && b.costUsd !== undefined) out.costUsd = a.costUsd + b.costUsd;
  return Object.keys(out).length > 0 ? out : undefined;
}
