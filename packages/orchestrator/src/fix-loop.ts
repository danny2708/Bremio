import { promises as fs } from "node:fs";
import { evaluate, type ControlMode } from "@bremio/policy";
import type { Plan, Task, TaskFailureCode, TaskResult } from "@bremio/protocol";
import { evaluateQualityGate, type QualityGateResult, type QualityGateTask } from "./quality-gate";

/**
 * Closed autonomy loop for Team runs (P2-T3, docs/17, docs/19).
 *
 * When the quality gate fails because a test or review *about* an otherwise
 * completed implementation failed, Bremio synthesizes one bounded fix chain:
 *
 *   FIX-n (implementation, inherits the failing branch)
 *     ├─ FIX-n-TEST   (copy of the failing/related test task)
 *     └─ FIX-n-REVIEW (copy of the failing/related review task)
 *
 * The failing test/review entries are *superseded* — kept in the report, but
 * excluded from the final gate, because the fix chain re-runs the same check
 * on a descendant branch. Completed tasks are never re-run.
 */

/** CLI/daemon default (docs/17 P2-T3). The library default is 0 = off. */
export const DEFAULT_MAX_FIX_ITERATIONS = 2;

/** Bytes of a failing task's log handed to the fixer. */
export const FIX_EVIDENCE_TAIL_BYTES = 3_000;

/**
 * Failure codes a fix iteration can address: Bremio's own verdicts on a
 * provider run that otherwise finished. Provider failures (auth, quota,
 * timeouts …) are not fixable by writing more code.
 */
const FIXABLE_CODES: ReadonlySet<TaskFailureCode> = new Set<TaskFailureCode>([
  "verification_failed",
  "verification_missing",
  "review_invalid",
  "blocked_by_dependency",
]);

export type FixLoopStatus =
  /** The first gate passed or was not run; nothing to fix. */
  | "not-needed"
  /** `maxFixIterations` is 0. */
  | "disabled"
  /** A fix iteration made the gate pass. */
  | "passed"
  /** Every allowed iteration ran and the gate is still failing. */
  | "exhausted"
  /** Cancellation, a guard/stop request, policy or the cost budget ended the loop. */
  | "stopped"
  /** The failure is not something a fix task can address. */
  | "not-fixable";

export interface FixIterationRecord {
  iteration: number;
  /** Task ids whose failure this iteration addresses (now superseded). */
  addresses: string[];
  /** Branch-providing task ids the fix inherits from. */
  basedOn: string[];
  /** Task ids added by this iteration, in execution order. */
  taskIds: string[];
  /** Gate reasons before this iteration ran. */
  reasonsBefore: string[];
  /** Gate after this iteration (superseded entries excluded). */
  gateAfter: QualityGateResult;
  /** Sum of provider-reported cost of this iteration's tasks; absent if any was unreported. */
  costUsd?: number;
}

export interface FixLoopReport {
  status: FixLoopStatus;
  /** Named reason for every status except `passed` / `not-needed`. */
  reason?: string;
  maxIterations: number;
  iterations: FixIterationRecord[];
  /** Task ids excluded from the final gate because a fix chain re-ran their check. */
  superseded: string[];
}

export interface FixLoopBounds {
  maxIterations: number;
  /** Stop once fix iterations have spent this much provider-reported cost. */
  maxCostUsd?: number;
  controlMode: ControlMode;
  signal?: AbortSignal;
  stopRequested?: () => boolean;
}

export type FixPlan =
  | {
      ok: true;
      tasks: Task[];
      assign: Map<string, string>;
      addresses: string[];
      basedOn: string[];
    }
  | { ok: false; reason: string };

/** Gate over all entries, excluding superseded ones (and the reasons they caused). */
export function evaluateGateWithFixes(
  plan: Plan,
  entries: readonly QualityGateTask[],
  superseded: ReadonlySet<string>,
): QualityGateResult {
  return evaluateQualityGate(
    plan,
    entries.filter((entry) => !superseded.has(entry.task.id)),
  );
}

/** Whether policy lets Bremio write a fix without a per-action approval. */
export function fixLoopPolicyBlock(controlMode: ControlMode): string | undefined {
  const rule = evaluate(controlMode, "write");
  if (!rule.allowed) return `${controlMode} mode does not allow fix iterations: ${rule.reason}`;
  if (rule.approvalRequired === "per-action") {
    return `${controlMode} mode requires per-action approval for writes; fix iterations cannot run unattended`;
  }
  return undefined;
}

/**
 * Decide whether the loop may start another iteration. Returns a named stop
 * reason, or undefined to continue. Cost is fail-closed: a budget that cannot
 * be measured stops the loop rather than being assumed unspent.
 */
export function fixLoopStopReason(
  bounds: FixLoopBounds,
  iterations: readonly FixIterationRecord[],
): { status: FixLoopStatus; reason: string } | undefined {
  if (bounds.signal?.aborted) return { status: "stopped", reason: "run cancelled" };
  if (bounds.stopRequested?.()) {
    return { status: "stopped", reason: "run is constrained or a stop was requested" };
  }
  if (iterations.length >= bounds.maxIterations) {
    return {
      status: "exhausted",
      reason: `reached maxFixIterations (${bounds.maxIterations}) with the quality gate still failing`,
    };
  }
  if (bounds.maxCostUsd !== undefined && iterations.length > 0) {
    if (iterations.some((it) => it.costUsd === undefined)) {
      return {
        status: "stopped",
        reason: "a fix cost budget is set but a fix iteration's cost was not provider-reported",
      };
    }
    const spent = iterations.reduce((sum, it) => sum + (it.costUsd ?? 0), 0);
    if (spent >= bounds.maxCostUsd) {
      return {
        status: "stopped",
        reason: `fix cost budget exhausted ($${spent.toFixed(4)} of $${bounds.maxCostUsd})`,
      };
    }
  }
  return undefined;
}

/**
 * Build the next fix chain from the current entries, or explain why the
 * failure is not fixable. Pure apart from reading bounded log tails.
 */
export async function planFixIteration(input: {
  plan: Plan;
  entries: readonly QualityGateTask[];
  superseded: ReadonlySet<string>;
  iteration: number;
}): Promise<FixPlan> {
  const live = input.entries.filter((e) => !input.superseded.has(e.task.id));
  const byId = new Map(live.map((e) => [e.task.id, e] as const));
  const allIds = new Set(input.entries.map((e) => e.task.id));

  const isFixTarget = (entry: QualityGateTask): boolean => {
    if (entry.task.kind !== "test" && entry.task.kind !== "review") return false;
    if (entry.result.status === "completed") {
      return entry.task.kind === "review" && openBlockers(entry.result).length > 0;
    }
    return entry.result.status === "failed" &&
      entry.result.errorCode !== undefined &&
      FIXABLE_CODES.has(entry.result.errorCode);
  };

  const targets = live.filter(isFixTarget);
  const unfixable = live.filter(
    (e) => e.result.status !== "completed" && !targets.includes(e),
  );
  if (unfixable.length > 0) {
    return {
      ok: false,
      reason: `not fixable by a fix task: ${unfixable
        .map((e) => `${e.task.id} ${e.result.status} (${e.result.errorCode ?? "unknown"})`)
        .join(", ")}`,
    };
  }
  if (targets.length === 0) {
    return { ok: false, reason: "the quality gate failed for structural reasons (missing test or review tasks)" };
  }

  // The fix inherits whatever the failing checks were checking: their
  // non-test/review dependencies, which must have completed.
  const targetIds = new Set(targets.map((t) => t.task.id));
  const basedOn = [...new Set(targets.flatMap((t) => t.task.dependencies))]
    .filter((id) => !targetIds.has(id))
    .filter((id) => {
      const dep = byId.get(id);
      return dep !== undefined && dep.task.kind !== "test" && dep.task.kind !== "review";
    });
  if (basedOn.length === 0) {
    return { ok: false, reason: "failing checks have no completed implementation to fix" };
  }
  for (const id of basedOn) {
    const dep = byId.get(id)!;
    if (dep.result.status !== "completed" || !dep.result.branch) {
      return { ok: false, reason: `${id} has no completed branch to fix from` };
    }
  }

  const testTemplate = targets.find((t) => t.task.kind === "test")?.task ??
    relatedTask(input.plan, "test", basedOn);
  const reviewTemplate = targets.find((t) => t.task.kind === "review")?.task ??
    relatedTask(input.plan, "review", basedOn);
  if (!testTemplate || !reviewTemplate) {
    return { ok: false, reason: "no test and review task to re-run after a fix" };
  }

  const fixId = uniqueId(`FIX-${input.iteration}`, allIds);
  const testId = uniqueId(`${fixId}-TEST`, allIds);
  const reviewId = uniqueId(`${fixId}-REVIEW`, allIds);
  const fixAgent = byId.get(basedOn[0]!)!.agentId;
  const testAgent = byId.get(testTemplate.id)?.agentId ?? input.entries.find((e) => e.task.id === testTemplate.id)?.agentId ?? fixAgent;
  const reviewAgent = byId.get(reviewTemplate.id)?.agentId ?? input.entries.find((e) => e.task.id === reviewTemplate.id)?.agentId ?? fixAgent;

  const evidence = await Promise.all(targets.map((t) => describeFailure(t)));
  const criteria = [
    ...new Set([
      ...targets.flatMap((t) => t.task.acceptanceCriteria),
      "the previously failing verification command(s) now exit 0",
      "no open blocker findings remain",
    ]),
  ];

  const fix: Task = {
    id: fixId,
    title: `[fix ${input.iteration}] Make ${[...targetIds].join(", ")} pass`,
    kind: "implementation",
    requiredCapabilities: ["repository.read", "repository.write", "shell"],
    preferredAgents: [fixAgent],
    risk: "medium",
    dependencies: basedOn,
    expectedArtifacts: [],
    acceptanceCriteria: criteria,
    description: [
      "A previous attempt at this plan failed its quality gate. Your branch already",
      "contains that attempt. Fix the root cause shown below; do not weaken, skip or",
      "delete tests to make them pass.",
      "",
      "FAILURE EVIDENCE:",
      ...evidence,
    ].join("\n"),
  };
  const test: Task = {
    ...testTemplate,
    id: testId,
    title: `[fix ${input.iteration}] ${testTemplate.title}`,
    dependencies: [fixId],
    preferredAgents: [testAgent],
  };
  const review: Task = {
    ...reviewTemplate,
    id: reviewId,
    title: `[fix ${input.iteration}] ${reviewTemplate.title}`,
    dependencies: [fixId],
    preferredAgents: [reviewAgent],
  };

  return {
    ok: true,
    tasks: [fix, test, review],
    assign: new Map([
      [fixId, fixAgent],
      [testId, testAgent],
      [reviewId, reviewAgent],
    ]),
    addresses: [...targetIds],
    basedOn,
  };
}

/** Provider-reported cost of a set of results; undefined if any is unreported. */
export function reportedCost(results: readonly TaskResult[]): number | undefined {
  let total = 0;
  for (const result of results) {
    if (result.usage?.costUsd === undefined) return undefined;
    total += result.usage.costUsd;
  }
  return total;
}

function openBlockers(result: TaskResult) {
  return result.findings.filter((f) => f.severity === "blocker" && f.status === "open");
}

function relatedTask(plan: Plan, kind: "test" | "review", basedOn: readonly string[]): Task | undefined {
  const byId = new Map(plan.tasks.map((t) => [t.id, t] as const));
  const reaches = (task: Task, target: string, seen = new Set<string>()): boolean => {
    if (task.dependencies.includes(target)) return true;
    for (const dep of task.dependencies) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const parent = byId.get(dep);
      if (parent && reaches(parent, target, seen)) return true;
    }
    return false;
  };
  return plan.tasks.find((t) => t.kind === kind && basedOn.some((id) => reaches(t, id))) ??
    plan.tasks.find((t) => t.kind === kind);
}

function uniqueId(base: string, taken: Set<string>): string {
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}-${n++}`;
  taken.add(candidate);
  return candidate;
}

async function describeFailure(entry: QualityGateTask): Promise<string> {
  const lines = [`- ${entry.task.id} (${entry.task.kind}): ${entry.task.title}`];
  if (entry.result.error) lines.push(`  error [${entry.result.errorCode ?? "unknown"}]: ${entry.result.error}`);
  const lastTest = entry.result.tests.at(-1);
  if (lastTest) lines.push(`  last command: ${lastTest.command} (exit ${lastTest.exitCode})`);
  for (const finding of openBlockers(entry.result)) {
    lines.push(`  open blocker: ${finding.message}${finding.file ? ` (${finding.file})` : ""}`);
  }
  const tail = await logTail(entry.result.logsPath);
  if (tail) lines.push("  log tail:", ...tail.split("\n").map((l) => `    ${l}`));
  return lines.join("\n");
}

async function logTail(logsPath: string | undefined): Promise<string | undefined> {
  if (!logsPath) return undefined;
  try {
    const text = await fs.readFile(logsPath, "utf8");
    const tail = text.length > FIX_EVIDENCE_TAIL_BYTES ? text.slice(-FIX_EVIDENCE_TAIL_BYTES) : text;
    return tail.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Pair every plan task with its result (or a synthetic "did not run"). */
export function entriesOf(
  plan: Plan,
  assign: ReadonlyMap<string, string>,
  results: readonly TaskResult[],
): QualityGateTask[] {
  const byId = new Map(results.map((r) => [r.taskId, r] as const));
  return plan.tasks.map((task) => {
    const result = byId.get(task.id);
    const agentId = result?.agentId ?? assign.get(task.id) ?? "";
    return {
      task,
      agentId,
      result: result ?? {
        taskId: task.id,
        agentId,
        status: "failed",
        summary: "task did not run",
        filesChanged: [],
        filesRead: [],
        changeLedger: [],
        commandsExecuted: [],
        tests: [],
        findings: [],
        messages: [],
        error: "no result was produced for this task",
        errorCode: "unknown",
      },
    };
  });
}

export interface TeamFixLoopInput {
  plan: Plan;
  assign: ReadonlyMap<string, string>;
  results: readonly TaskResult[];
  bounds: FixLoopBounds;
  /** Executes one fix chain; `prior` are every result so far (never re-run). */
  execute(iterationPlan: Plan, assign: Map<string, string>, prior: readonly TaskResult[]): Promise<TaskResult[]>;
  onIteration?(iteration: number, reasons: readonly string[], tasks: readonly Task[]): void;
}

export interface TeamFixLoopResult {
  plan: Plan;
  assign: Map<string, string>;
  results: TaskResult[];
  gate: QualityGateResult;
  report: FixLoopReport;
}

/** Run fix iterations until the gate passes or a bound stops the loop. */
export async function runTeamFixLoop(input: TeamFixLoopInput): Promise<TeamFixLoopResult> {
  let plan: Plan = { ...input.plan, tasks: [...input.plan.tasks] };
  const assign = new Map(input.assign);
  let results = [...input.results];
  const superseded = new Set<string>();
  const iterations: FixIterationRecord[] = [];
  let gate = evaluateGateWithFixes(plan, entriesOf(plan, assign, results), superseded);

  const finish = (status: FixLoopStatus, reason?: string): TeamFixLoopResult => ({
    plan,
    assign,
    results,
    gate,
    report: {
      status,
      ...(reason ? { reason } : {}),
      maxIterations: input.bounds.maxIterations,
      iterations,
      superseded: [...superseded],
    },
  });

  if (gate.status !== "failed") return finish("not-needed");
  if (input.bounds.maxIterations <= 0) return finish("disabled", "maxFixIterations is 0");
  const policyBlock = fixLoopPolicyBlock(input.bounds.controlMode);
  if (policyBlock) return finish("stopped", policyBlock);

  for (;;) {
    const stop = fixLoopStopReason(input.bounds, iterations);
    if (stop) return finish(stop.status, stop.reason);

    const iteration = iterations.length + 1;
    const next = await planFixIteration({
      plan,
      entries: entriesOf(plan, assign, results),
      superseded,
      iteration,
    });
    if (!next.ok) return finish("not-fixable", next.reason);

    const reasonsBefore = gate.reasons;
    input.onIteration?.(iteration, reasonsBefore, next.tasks);
    const iterationPlan: Plan = { ...plan, tasks: next.tasks };
    const iterationResults = await input.execute(iterationPlan, next.assign, results);

    plan = { ...plan, tasks: [...plan.tasks, ...next.tasks] };
    for (const [id, agent] of next.assign) assign.set(id, agent);
    results = [...results, ...iterationResults];
    for (const id of next.addresses) superseded.add(id);
    gate = evaluateGateWithFixes(plan, entriesOf(plan, assign, results), superseded);

    const cost = reportedCost(iterationResults);
    iterations.push({
      iteration,
      addresses: next.addresses,
      basedOn: next.basedOn,
      taskIds: next.tasks.map((t) => t.id),
      reasonsBefore,
      gateAfter: gate,
      ...(cost !== undefined ? { costUsd: cost } : {}),
    });
    if (gate.status === "passed") return finish("passed");
  }
}
