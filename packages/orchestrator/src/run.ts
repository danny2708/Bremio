import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { AgentCapabilities } from "@bremio/adapter-sdk";
import type {
  AgentEvent,
  Plan,
  ReasoningLevel,
  Task,
  UsageSummary,
} from "@bremio/protocol";
import type {
  AgentCapacitySnapshot,
  CapacityRoutingPolicyInput,
} from "@bremio/quota";
import { WorktreeManager, getCurrentBranch } from "@bremio/workspace";
import { buildReport, type RunReport } from "./aggregator";
import { createPlan, LeadPlanError } from "./lead-manager";
import { appendLedgerEntry, ledgerPathFor } from "./ledger";
import type { AgentRegistry } from "./registry";
import { assignAgents } from "./router";
import { runPlan, type SchedulerHooks } from "./scheduler";
import { validatePlan } from "./validator";

export interface RunBremioHooks extends SchedulerHooks {
  onLeadStart?(leadId: string): void;
  onLeadEvent?(event: AgentEvent): void;
  onPlan?(plan: Plan, assign: Map<string, string>): void;
}

export interface RunBremioOptions {
  leadId: string;
  repoPath: string;
  prompt: string;
  registry: AgentRegistry;
  /** Model for the lead's planning run (workers use their adapter defaults). */
  model?: string;
  /** Reasoning level for the lead; workers keep their adapter/config defaults. */
  reasoningLevel?: ReasoningLevel;
  /** Hard timeout for each lead attempt and worker task. */
  taskTimeoutMs?: number;
  /** Optional canonical snapshots used by the opt-in capacity-aware router. */
  capacitySnapshots?: readonly AgentCapacitySnapshot[];
  capacityPolicy?: CapacityRoutingPolicyInput;
  /** Provider-confirmed model id for model-scoped capacity selection. */
  modelByAgent?: ReadonlyMap<string, string>;
  /** Links controlled single/multi runs of the same request for calibration. */
  comparisonId?: string;
  signal?: AbortSignal;
  logger?: Logger;
  hooks?: RunBremioHooks;
}

/** Generate a sortable, human-readable run id: run-YYYYMMDD-HHMMSS-xxxx. */
export function createRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `run-${stamp}-${randomBytes(2).toString("hex")}`;
}

/**
 * One Bremio run: lead plans → validate → assign (lead ≠ worker) → sequential
 * worktree execution → aggregate into one report (also written to
 * `.bremio/runs/<runId>/report.json`).
 */
export async function runBremio(opts: RunBremioOptions): Promise<RunReport> {
  const { leadId, prompt, registry, logger } = opts;
  const repoPath = path.resolve(opts.repoPath);
  const runId = createRunId();
  const bremioDir = path.join(repoPath, ".bremio");
  const runDir = path.join(bremioDir, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  // Keep Bremio's own state out of the target repo's git status.
  await fs.writeFile(path.join(bremioDir, ".gitignore"), "*\n", "utf8").catch(() => {});

  const lead = registry.get(leadId);
  if (!lead) {
    throw new Error(
      `lead "${leadId}" is not registered (available: ${[...registry.keys()].join(", ") || "none"})`,
    );
  }

  const workspace = new WorktreeManager(repoPath, { runToken: runId.slice(-6) });
  await workspace.assertUsable();
  const baseBranch = await getCurrentBranch(repoPath);

  // Worker = the other registered provider; falls back to the lead (single-agent).
  const workerId = [...registry.keys()].find((id) => id !== leadId) ?? leadId;

  const capabilitiesByAgent = new Map<string, AgentCapabilities>();
  for (const [id, adapter] of registry) {
    capabilitiesByAgent.set(id, await adapter.getCapabilities());
  }

  logger?.info({ runId, leadId, workerId, repoPath }, "starting Bremio run");
  opts.hooks?.onLeadStart?.(leadId);

  const planningStarted = Date.now();
  let leadUsage: UsageSummary | undefined;
  const observedLeadModels = new Set<string>();
  const observedLeadReasoningLevels = new Set<ReasoningLevel>();
  const onLeadEvent = (event: AgentEvent): void => {
    if (event.type === "usage") {
      leadUsage = addUsage(leadUsage, event);
      if (event.model) observedLeadModels.add(event.model);
      if (event.reasoningLevel) observedLeadReasoningLevels.add(event.reasoningLevel);
    }
    opts.hooks?.onLeadEvent?.(event);
  };
  let plan: Plan;
  let attempts: number;
  try {
    ({ plan, attempts } = await createPlan(lead, {
      prompt,
      cwd: repoPath,
      runId,
      runDir,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningLevel ? { reasoningLevel: opts.reasoningLevel } : {}),
      ...(opts.taskTimeoutMs ? { timeoutMs: opts.taskTimeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onEvent: onLeadEvent,
    }));
  } catch (err) {
    await recordPlanningLedger({
      ledgerPath: ledgerPathFor(repoPath),
      runId,
      leadId,
      status: err instanceof LeadPlanError ? err.status : "failed",
      durationMs: Date.now() - planningStarted,
      ...(opts.model ? { requestedModel: opts.model } : {}),
      ...observedIdentity(observedLeadModels, observedLeadReasoningLevels),
      ...(opts.reasoningLevel
        ? { requestedReasoningLevel: opts.reasoningLevel }
        : {}),
      ...(leadUsage ? { usage: leadUsage } : {}),
    });
    throw err;
  }
  await recordPlanningLedger({
    ledgerPath: ledgerPathFor(repoPath),
    runId,
    leadId,
    status: "completed",
    durationMs: Date.now() - planningStarted,
    ...(opts.model ? { requestedModel: opts.model } : {}),
    ...observedIdentity(observedLeadModels, observedLeadReasoningLevels),
    ...(opts.reasoningLevel
      ? { requestedReasoningLevel: opts.reasoningLevel }
      : {}),
    ...(leadUsage ? { usage: leadUsage } : {}),
  });
  logger?.info({ tasks: plan.tasks.length, attempts }, "lead produced a plan");

  validatePlan(plan, capabilitiesByAgent);

  const capacityByAgent = opts.capacitySnapshots
    ? new Map(opts.capacitySnapshots.map((snapshot) => [snapshot.agentId, snapshot] as const))
    : undefined;
  const assign = assignAgents(plan, leadId, workerId, {
    ...(capacityByAgent ? { capacityByAgent } : {}),
    ...(opts.capacityPolicy ? { capacityPolicy: opts.capacityPolicy } : {}),
    ...(opts.modelByAgent ? { modelByAgent: opts.modelByAgent } : {}),
  });
  // Team remains a coordinated flow even if routing happens to assign every
  // planned task to one provider. Only runSingleAgent records single-agent.
  const flowMode = "multi-agent" as const;
  opts.hooks?.onPlan?.(plan, assign);
  logger?.info(
    { assignments: Object.fromEntries(assign) },
    "plan validated; tasks assigned",
  );

  const results = await runPlan({
    plan,
    assign,
    registry,
    workspace,
    runDir,
    runId,
    ledgerPath: ledgerPathFor(repoPath),
    ...(opts.taskTimeoutMs ? { taskTimeoutMs: opts.taskTimeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  });

  const report = buildReport({
    runId,
    prompt,
    leadAgentId: leadId,
    repoPath,
    runDir,
    baseBranch,
    plan,
    assign,
    results,
  });

  await fs.writeFile(
    path.join(runDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  await recordRunSummary({
    ledgerPath: ledgerPathFor(repoPath),
    report,
    flowMode,
    ...(opts.comparisonId ? { comparisonId: opts.comparisonId } : {}),
  });
  logger?.info({ summary: report.summary, runDir }, "run complete");

  return report;
}

export type { Task };

function addUsage(
  current: UsageSummary | undefined,
  event: Extract<AgentEvent, { type: "usage" }>,
): UsageSummary | undefined {
  const usage: UsageSummary = {
    ...(current?.inputTokens !== undefined || event.inputTokens !== undefined
      ? { inputTokens: (current?.inputTokens ?? 0) + (event.inputTokens ?? 0) }
      : {}),
    ...(current?.outputTokens !== undefined || event.outputTokens !== undefined
      ? { outputTokens: (current?.outputTokens ?? 0) + (event.outputTokens ?? 0) }
      : {}),
    ...(current?.costUsd !== undefined || event.costUsd !== undefined
      ? { costUsd: (current?.costUsd ?? 0) + (event.costUsd ?? 0) }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function singleObserved<T>(values: Set<T>): T | undefined {
  return values.size === 1 ? [...values][0] : undefined;
}

function observedIdentity(
  models: Set<string>,
  reasoningLevels: Set<ReasoningLevel>,
): Pick<PlanningLedgerInput, "actualModel" | "actualReasoningLevel"> {
  const actualModel = singleObserved(models);
  const actualReasoningLevel = singleObserved(reasoningLevels);
  return {
    ...(actualModel ? { actualModel } : {}),
    ...(actualReasoningLevel ? { actualReasoningLevel } : {}),
  };
}

interface PlanningLedgerInput {
  ledgerPath: string;
  runId: string;
  leadId: string;
  status: "completed" | "failed" | "cancelled";
  durationMs: number;
  requestedModel?: string;
  actualModel?: string;
  requestedReasoningLevel?: ReasoningLevel;
  actualReasoningLevel?: ReasoningLevel;
  usage?: UsageSummary;
}

interface RunSummaryLedgerInput {
  ledgerPath: string;
  report: RunReport;
  flowMode: "single-agent" | "multi-agent";
  comparisonId?: string;
}

/** Record orchestration overhead without ever masking the actual run outcome. */
async function recordPlanningLedger(input: PlanningLedgerInput): Promise<void> {
  try {
    await appendLedgerEntry(input.ledgerPath, {
      ts: new Date().toISOString(),
      runId: input.runId,
      taskId: `${input.runId}::lead`,
      scope: "coordination",
      provider: input.leadId,
      role: "planner",
      kind: "planning",
      status: input.status,
      filesChanged: 0,
      durationMs: input.durationMs,
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(input.actualModel ? { actualModel: input.actualModel } : {}),
      ...(input.requestedReasoningLevel
        ? { requestedReasoningLevel: input.requestedReasoningLevel }
        : {}),
      ...(input.actualReasoningLevel
        ? { actualReasoningLevel: input.actualReasoningLevel }
        : {}),
      ...(input.usage ? { usage: input.usage } : {}),
    });
  } catch {
    // measurement is best-effort; a ledger write must never replace the run result
  }
}

/** Record the objective run outcome used by the calibration gate. */
async function recordRunSummary(input: RunSummaryLedgerInput): Promise<void> {
  const { report } = input;
  const qualityGatePassed = report.qualityGate.status === "passed";
  const status = report.summary.cancelled > 0
    ? "cancelled"
    : report.summary.failed > 0 || !qualityGatePassed
      ? "failed"
      : "completed";
  try {
    await appendLedgerEntry(input.ledgerPath, {
      ts: new Date().toISOString(),
      runId: report.runId,
      taskId: `${report.runId}::summary`,
      scope: "run",
      provider: "bremio",
      role: "orchestrator",
      kind: "run-summary",
      status,
      filesChanged: 0,
      flowMode: input.flowMode,
      ...(input.comparisonId ? { comparisonId: input.comparisonId } : {}),
      qualityGatePassed,
      outcomeVerified: qualityGatePassed,
    });
  } catch {
    // calibration measurement is best-effort; it must never replace the run result
  }
}
