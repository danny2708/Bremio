import type { Plan, Task, TaskFailureCode, TaskResult } from "@bremio/protocol";

/**
 * Re-plan on blocker (P2-T5, docs/17, docs/19).
 *
 * When a non-check task fails for a reason a different plan could route
 * around (the agent gave up, an expected artifact never appeared, a task
 * could not be set up), the lead is asked for a plan covering the *remaining*
 * work only. Completed tasks are immutable: they are passed to the scheduler
 * as prior results (their branches are inherited, they never re-run). Failed
 * tasks and everything they blocked are *replaced* — kept in the report,
 * excluded from the gate.
 *
 * Off by default (`maxReplans` 0): a re-plan costs another lead call and can
 * double-pay (docs/99 R5).
 */

/** Failures a different plan could plausibly avoid. */
const REPLANNABLE: ReadonlySet<TaskFailureCode> = new Set<TaskFailureCode>([
  "execution_failed",
  "unknown",
  "missing_artifact",
  "setup_failed",
]);

/** Provider/run conditions no plan can fix; re-planning would only spend quota. */
const NOT_REPLANNABLE: ReadonlySet<TaskFailureCode> = new Set<TaskFailureCode>([
  "authentication_failed",
  "quota_exhausted",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "cancelled",
  "session_not_found",
  "no_adapter",
]);

export interface ReplanRecord {
  iteration: number;
  /** Failed tasks that triggered the re-plan, with their codes. */
  blockers: Array<{ taskId: string; errorCode: TaskFailureCode | "unknown"; error?: string }>;
  /** Tasks replaced by this re-plan (blockers + what they blocked). */
  replaced: string[];
  /** Completed tasks the new plan may build on. */
  kept: string[];
  /** Task ids the lead added. */
  added: string[];
}

export interface ReplanReport {
  status: "not-needed" | "disabled" | "replanned" | "stopped";
  reason?: string;
  maxReplans: number;
  replans: ReplanRecord[];
}

export type BlockerAnalysis =
  | { kind: "none" }
  | { kind: "not-replannable"; reason: string }
  | { kind: "replannable"; blockers: TaskResult[]; replaced: string[]; kept: string[] };

/** Decide whether the current results warrant a re-plan, and what it replaces. */
export function analyzeBlockers(
  plan: Plan,
  results: readonly TaskResult[],
  superseded: ReadonlySet<string>,
): BlockerAnalysis {
  const byId = new Map(results.map((r) => [r.taskId, r] as const));
  const live = plan.tasks.filter((t) => !superseded.has(t.id));
  const failed = live
    .map((t) => ({ task: t, result: byId.get(t.id) }))
    .filter((e): e is { task: Task; result: TaskResult } => e.result !== undefined && e.result.status !== "completed");
  if (failed.length === 0) return { kind: "none" };

  const hard = failed.filter((e) => NOT_REPLANNABLE.has(e.result.errorCode ?? "unknown"));
  if (hard.length > 0) {
    return {
      kind: "not-replannable",
      reason: `a re-plan cannot fix: ${hard.map((e) => `${e.task.id} (${e.result.errorCode})`).join(", ")}`,
    };
  }

  const blockers = failed.filter(
    (e) => e.task.kind !== "test" && e.task.kind !== "review" &&
      REPLANNABLE.has(e.result.errorCode ?? "unknown"),
  );
  if (blockers.length === 0) return { kind: "none" };

  // Everything downstream of a blocker is replaced with it.
  const replaced = new Set(blockers.map((b) => b.task.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of live) {
      if (replaced.has(task.id)) continue;
      if (task.dependencies.some((d) => replaced.has(d))) {
        replaced.add(task.id);
        grew = true;
      }
    }
  }
  const kept = live
    .filter((t) => !replaced.has(t.id) && byId.get(t.id)?.status === "completed")
    .map((t) => t.id);
  return { kind: "replannable", blockers: blockers.map((b) => b.result), replaced: [...replaced], kept };
}

/** The request text handed to the lead for a remaining-work plan. */
export function buildReplanRequest(input: {
  originalPrompt: string;
  plan: Plan;
  results: readonly TaskResult[];
  analysis: Extract<BlockerAnalysis, { kind: "replannable" }>;
  takenIds: ReadonlySet<string>;
}): string {
  const byId = new Map(input.plan.tasks.map((t) => [t.id, t] as const));
  const resultById = new Map(input.results.map((r) => [r.taskId, r] as const));
  const lines = [
    input.originalPrompt,
    "",
    "--- RE-PLAN: an earlier plan for this request hit a blocker ---",
    "COMPLETED TASKS (immutable; your tasks may list these ids as dependencies to build on their work):",
    ...input.analysis.kept.map((id) => {
      const r = resultById.get(id);
      return `- ${id} [${byId.get(id)?.kind}] ${byId.get(id)?.title}${r?.summary ? ` — ${oneLine(r.summary)}` : ""}`;
    }),
    "FAILED (do not repeat the same approach):",
    ...input.analysis.blockers.map((b) => `- ${b.taskId} [${b.errorCode ?? "unknown"}] ${byId.get(b.taskId)?.title}: ${oneLine(b.error ?? "")}`),
    "",
    "Plan ONLY the remaining work. Do not re-plan completed tasks.",
    `Do not reuse these task ids: ${[...input.takenIds].join(", ")}.`,
  ];
  return lines.join("\n");
}

/** Validate a remaining-work plan against what already exists. Throws on failure. */
export function validateReplan(
  newPlan: Plan,
  context: { takenIds: ReadonlySet<string>; kept: readonly string[] },
): void {
  const errors: string[] = [];
  const newIds = new Set(newPlan.tasks.map((t) => t.id));
  const kept = new Set(context.kept);
  for (const task of newPlan.tasks) {
    if (context.takenIds.has(task.id)) errors.push(`task id ${task.id} is already used by this run`);
    for (const dep of task.dependencies) {
      if (!newIds.has(dep) && !kept.has(dep)) {
        errors.push(`${task.id} depends on ${dep}, which is neither new nor a completed task`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`invalid re-plan: ${errors.join("; ")}`);
}

export interface ReplanLoopInput {
  plan: Plan;
  assign: ReadonlyMap<string, string>;
  results: readonly TaskResult[];
  maxReplans: number;
  originalPrompt: string;
  signal?: AbortSignal;
  stopRequested?: () => boolean;
  /** Ask the lead; `validate` throws on a plan that must be repaired/rejected. */
  requestPlan(request: string, iteration: number, validate: (plan: Plan) => void): Promise<Plan>;
  /** Semantic validation of kept + new tasks (the same validator a lead plan passes). */
  validateCombined(plan: Plan): void;
  assignNew(plan: Plan): Map<string, string>;
  execute(plan: Plan, assign: Map<string, string>, prior: readonly TaskResult[]): Promise<TaskResult[]>;
  onReplan?(record: ReplanRecord): void;
}

export interface ReplanLoopResult {
  plan: Plan;
  assign: Map<string, string>;
  results: TaskResult[];
  /** Replaced task ids; the gate and definition of done exclude them. */
  superseded: Set<string>;
  report: ReplanReport;
}

export async function runReplanLoop(input: ReplanLoopInput): Promise<ReplanLoopResult> {
  let plan: Plan = { ...input.plan, tasks: [...input.plan.tasks] };
  const assign = new Map(input.assign);
  let results = [...input.results];
  const superseded = new Set<string>();
  const replans: ReplanRecord[] = [];
  const maxReplans = Math.max(0, Math.trunc(input.maxReplans));
  const finish = (status: ReplanReport["status"], reason?: string): ReplanLoopResult => ({
    plan,
    assign,
    results,
    superseded,
    report: { status, ...(reason ? { reason } : {}), maxReplans, replans },
  });

  let analysis = analyzeBlockers(plan, results, superseded);
  if (analysis.kind === "none") return finish("not-needed");
  if (analysis.kind === "not-replannable") return finish("stopped", analysis.reason);
  if (maxReplans === 0) return finish("disabled", "maxReplans is 0");

  while (analysis.kind === "replannable") {
    if (input.signal?.aborted) return finish("stopped", "run cancelled");
    if (input.stopRequested?.()) return finish("stopped", "run is constrained or a stop was requested");
    if (replans.length >= maxReplans) {
      return finish("stopped", `reached maxReplans (${maxReplans}) with blockers remaining`);
    }
    const current = analysis;
    const iteration = replans.length + 1;
    const takenIds = new Set(plan.tasks.map((t) => t.id));
    const keptTasks = plan.tasks.filter((t) => current.kept.includes(t.id));
    let added: Plan;
    try {
      added = await input.requestPlan(
        buildReplanRequest({ originalPrompt: input.originalPrompt, plan, results, analysis: current, takenIds }),
        iteration,
        (candidate) => {
          validateReplan(candidate, { takenIds, kept: current.kept });
          input.validateCombined({ ...candidate, tasks: [...keptTasks, ...candidate.tasks] });
        },
      );
    } catch (err) {
      return finish("stopped", `re-plan ${iteration} failed: ${(err as Error).message}`);
    }

    const newAssign = input.assignNew(added);
    const newResults = await input.execute(added, newAssign, results);
    plan = { ...plan, tasks: [...plan.tasks, ...added.tasks] };
    for (const [id, agent] of newAssign) assign.set(id, agent);
    results = [...results, ...newResults];
    for (const id of current.replaced) superseded.add(id);

    const record: ReplanRecord = {
      iteration,
      blockers: current.blockers.map((b) => ({
        taskId: b.taskId,
        errorCode: b.errorCode ?? "unknown",
        ...(b.error ? { error: b.error } : {}),
      })),
      replaced: current.replaced,
      kept: current.kept,
      added: added.tasks.map((t) => t.id),
    };
    replans.push(record);
    input.onReplan?.(record);

    analysis = analyzeBlockers(plan, results, superseded);
    if (analysis.kind === "not-replannable") return finish("stopped", analysis.reason);
  }
  return finish("replanned");
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
