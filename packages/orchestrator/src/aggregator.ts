import type { Plan, Task, TaskResult } from "@bremio/protocol";
import { evaluateQualityGate, type QualityGateResult } from "./quality-gate";

export interface RunReportTask {
  task: Task;
  agentId: string;
  result: TaskResult;
  reason?: string;
}

export interface RunReport {
  mode: "team";
  runId: string;
  createdAt: string;
  prompt: string;
  leadAgentId: string;
  repoPath: string;
  runDir: string;
  /** Branch the repo was on when the run started; merge target for tasks. */
  baseBranch?: string;
  plan: Plan;
  tasks: RunReportTask[];
  qualityGate: QualityGateResult;
  summary: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    filesChanged: number;
  };
  /** Why this flow mode (single/team) was chosen, if automatic. */
  autoModeReason?: string;
}

export type BremioRunReport = RunReport | import("./single-run").SingleRunReport;

export interface BuildReportInput {
  runId: string;
  prompt: string;
  leadAgentId: string;
  repoPath: string;
  runDir: string;
  baseBranch?: string;
  plan: Plan;
  assign: Map<string, string>;
  results: TaskResult[];
  /** Why each task was assigned to its agent. Map: taskId → reason. */
  reasonByTask?: ReadonlyMap<string, string>;
  /** Why this flow mode was chosen (auto mode resolution). */
  autoModeReason?: string;
}

/** Collect every TaskResult into one report. */
export function buildReport(input: BuildReportInput): RunReport {
  const byId = new Map(input.results.map((r) => [r.taskId, r] as const));
  const tasks: RunReportTask[] = input.plan.tasks.map((task) => {
    const result = byId.get(task.id);
    const agentId = result?.agentId ?? input.assign.get(task.id) ?? "";
    return {
      task,
      agentId,
      result: result ?? missingResult(task.id, agentId),
      ...(input.reasonByTask?.get(task.id)
        ? { reason: input.reasonByTask.get(task.id) }
        : {}),
    };
  });

  const summary = {
    total: tasks.length,
    completed: input.results.filter((r) => r.status === "completed").length,
    failed: input.results.filter((r) => r.status === "failed").length,
    cancelled: input.results.filter((r) => r.status === "cancelled").length,
    filesChanged: new Set(input.results.flatMap((r) => r.filesChanged)).size,
  };
  const qualityGate = evaluateQualityGate(input.plan, tasks);

  return {
    mode: "team",
    runId: input.runId,
    createdAt: new Date().toISOString(),
    prompt: input.prompt,
    leadAgentId: input.leadAgentId,
    repoPath: input.repoPath,
    runDir: input.runDir,
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    plan: input.plan,
    tasks,
    qualityGate,
    summary,
    ...(input.autoModeReason ? { autoModeReason: input.autoModeReason } : {}),
  };
}

function missingResult(taskId: string, agentId: string): TaskResult {
  return {
    taskId,
    agentId,
    status: "failed",
    summary: "task did not run",
    filesChanged: [],
    commandsExecuted: [],
    tests: [],
    findings: [],
    error: "no result was produced for this task",
  };
}
