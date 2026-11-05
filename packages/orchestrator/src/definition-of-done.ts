import type { Plan, Task, TaskResult } from "@bremio/protocol";

/**
 * Definition of done (P2-T6, docs/17, docs/19).
 *
 * Maps every acceptance criterion in the executed plan to the evidence Bremio
 * actually holds for it. Bremio cannot read a criterion and decide it is true;
 * what it can say is whether the task that owns the criterion completed, and
 * whether an objective check (a test command's exit code) and an independent
 * review (no open blockers) ran against that task's branch. Anything short of
 * that is `unknown` — never `evidenced`.
 *
 * Informational: the quality gate still decides mergeability.
 */

export type CriterionStatus = "evidenced" | "failed" | "unknown";

export interface DoneCriterion {
  taskId: string;
  criterion: string;
  status: CriterionStatus;
  /** Human-readable evidence or the reason it is missing / failing. */
  evidence: string[];
}

export interface DoneVerification {
  taskId?: string;
  command: string;
  exitCode: number;
  /** Who ran it: an agent's test task, or Bremio itself (Single --verify). */
  ranBy: "agent" | "bremio";
}

export interface DefinitionOfDone {
  /** met: every criterion evidenced; unmet: any failed; unknown otherwise (or no criteria). */
  status: "met" | "unmet" | "unknown";
  criteria: DoneCriterion[];
  verifications: DoneVerification[];
  summary: { total: number; evidenced: number; failed: number; unknown: number };
}

interface Entry {
  task: Task;
  result?: TaskResult;
}

export function evaluateDefinitionOfDone(input: {
  plan: Plan;
  results: readonly TaskResult[];
  /** Checks a fix iteration re-ran; their failures no longer stand. */
  superseded?: ReadonlySet<string>;
}): DefinitionOfDone {
  const superseded = input.superseded ?? new Set<string>();
  const byResult = new Map(input.results.map((r) => [r.taskId, r] as const));
  const entries: Entry[] = input.plan.tasks.map((task) => ({
    task,
    ...(byResult.has(task.id) ? { result: byResult.get(task.id)! } : {}),
  }));
  const byId = new Map(entries.map((e) => [e.task.id, e] as const));
  const live = entries.filter((e) => !superseded.has(e.task.id));

  const reaches = (task: Task, target: string, seen = new Set<string>()): boolean => {
    if (task.dependencies.includes(target)) return true;
    for (const dep of task.dependencies) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const parent = byId.get(dep)?.task;
      if (parent && reaches(parent, target, seen)) return true;
    }
    return false;
  };

  const verifications: DoneVerification[] = live
    .filter((e) => e.task.kind === "test" && e.result?.tests.at(-1))
    .map((e) => {
      const last = e.result!.tests.at(-1)!;
      return { taskId: e.task.id, command: last.command, exitCode: last.exitCode, ranBy: "agent" as const };
    });

  const criteria: DoneCriterion[] = [];
  for (const entry of live) {
    for (const criterion of entry.task.acceptanceCriteria) {
      criteria.push({ taskId: entry.task.id, criterion, ...judge(entry, live, reaches) });
    }
  }
  return finish(criteria, verifications);
}

/** Single runs have no plan criteria; the declared verification is the contract. */
export function evaluateSingleDefinitionOfDone(input: {
  verifyCommand?: string;
  /** Last Bremio-run verification, when --verify was given and it ran. */
  bremioVerification?: { command: string; exitCode: number };
  agentTests: ReadonlyArray<{ command: string; exitCode: number }>;
  runStatus: TaskResult["status"];
}): DefinitionOfDone {
  const verifications: DoneVerification[] = input.agentTests.map((t) => ({
    command: t.command,
    exitCode: t.exitCode,
    ranBy: "agent" as const,
  }));
  if (input.bremioVerification) {
    // The Bremio-run command is already in agentTests (it is appended to the
    // run's tests); mark that copy as Bremio's instead of listing it twice.
    const last = [...verifications].reverse().find((v) => v.command === input.bremioVerification!.command);
    if (last) last.ranBy = "bremio";
  }
  const criteria: DoneCriterion[] = [];
  if (input.verifyCommand) {
    const v = input.bremioVerification;
    criteria.push({
      taskId: "single",
      criterion: `\`${input.verifyCommand}\` exits 0`,
      status: input.runStatus !== "completed"
        ? "failed"
        : !v ? "unknown" : v.exitCode === 0 ? "evidenced" : "failed",
      evidence: input.runStatus !== "completed"
        ? [`run ${input.runStatus}`]
        : !v ? ["verification did not run"] : [`Bremio ran it: exit ${v.exitCode}`],
    });
  }
  return finish(criteria, verifications);
}

function judge(
  entry: Entry,
  live: readonly Entry[],
  reaches: (task: Task, target: string) => boolean,
): Pick<DoneCriterion, "status" | "evidence"> {
  const { task, result } = entry;
  if (!result) return { status: "unknown", evidence: ["task did not run"] };
  if (result.status !== "completed") {
    return { status: "failed", evidence: [`${task.id} ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}`] };
  }

  if (task.kind === "test") {
    const last = result.tests.at(-1);
    return last && last.exitCode === 0
      ? { status: "evidenced", evidence: [`${task.id}: \`${last.command}\` exit 0`] }
      : { status: "unknown", evidence: [`${task.id} has no passing command evidence`] };
  }
  if (task.kind === "review") {
    const blockers = openBlockers(result);
    return blockers.length > 0
      ? { status: "failed", evidence: blockers.map((b) => `${task.id} open blocker: ${b}`) }
      : { status: "evidenced", evidence: [`${task.id}: review completed with no open blockers`] };
  }

  const tests = live.filter((e) => e.task.kind === "test" && reaches(e.task, task.id));
  const reviews = live.filter((e) => e.task.kind === "review" && reaches(e.task, task.id));
  const evidence: string[] = [];
  let failed = false;

  let commandEvidence = false;
  for (const test of tests) {
    const last = test.result?.tests.at(-1);
    if (test.result?.status === "completed" && last?.exitCode === 0) {
      commandEvidence = true;
      evidence.push(`${test.task.id}: \`${last.command}\` exit 0`);
    } else if (test.result && test.result.status !== "completed") {
      failed = true;
      evidence.push(`${test.task.id} ${test.result.status}${last ? ` (\`${last.command}\` exit ${last.exitCode})` : ""}`);
    }
  }
  let reviewEvidence = false;
  for (const review of reviews) {
    if (!review.result) continue;
    const blockers = openBlockers(review.result);
    if (review.result.status === "completed" && blockers.length === 0) {
      reviewEvidence = true;
      evidence.push(`${review.task.id}: independent review, no open blockers`);
    } else if (blockers.length > 0) {
      failed = true;
      evidence.push(...blockers.map((b) => `${review.task.id} open blocker: ${b}`));
    } else {
      failed = true;
      evidence.push(`${review.task.id} ${review.result.status}`);
    }
  }

  if (failed) return { status: "failed", evidence };
  if (task.kind === "implementation" ? commandEvidence && reviewEvidence : reviewEvidence || commandEvidence) {
    return { status: "evidenced", evidence };
  }
  const missing: string[] = [];
  if (!commandEvidence && task.kind === "implementation") missing.push("no passing test command against this task");
  if (!reviewEvidence) missing.push("no independent review of this task");
  return { status: "unknown", evidence: [...evidence, ...missing] };
}

function openBlockers(result: TaskResult): string[] {
  return result.findings
    .filter((f) => f.severity === "blocker" && f.status === "open")
    .map((f) => f.message);
}

function finish(criteria: DoneCriterion[], verifications: DoneVerification[]): DefinitionOfDone {
  const summary = {
    total: criteria.length,
    evidenced: criteria.filter((c) => c.status === "evidenced").length,
    failed: criteria.filter((c) => c.status === "failed").length,
    unknown: criteria.filter((c) => c.status === "unknown").length,
  };
  const status: DefinitionOfDone["status"] = summary.failed > 0
    ? "unmet"
    : summary.total > 0 && summary.evidenced === summary.total
      ? "met"
      : "unknown";
  return { status, criteria, verifications, summary };
}
