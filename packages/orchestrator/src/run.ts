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
import {
  assessCapacity,
  type AgentCapacitySnapshot,
  type CapacityRoutingPolicyInput,
} from "@bremio/quota";
import { WorktreeManager, getCurrentBranch } from "@bremio/workspace";
import { buildReport, type BremioRunReport, type RunReport } from "./aggregator";
import { evaluateCalibrationReadiness } from "./calibration";
import { createPlan, LeadPlanError } from "./lead-manager";
import { appendLedgerEntry, ledgerPathFor, readLedger } from "./ledger";
import { findBestSingleAgentBaseline } from "./net-gain";
import type { AgentRegistry } from "./registry";
import { assignAgents } from "./router";
import {
  getDefaultRoutingConfig,
  loadRoutingConfig,
  type RoutingConfig,
} from "./routing-config";
import { runPlan, type SchedulerHooks } from "./scheduler";
import type { SingleRunFallback } from "./single-run";
import { validatePlan } from "./validator";

export interface RunBremioHooks extends SchedulerHooks {
  onLeadStart?(leadId: string): void;
  onLeadEvent?(event: AgentEvent): void;
  onPlan?(plan: Plan, assign: Map<string, string>): void;
  onFallback?(reason: string, agentId: string): void;
}

export interface RunBremioOptions {
  leadId: string;
  /** Explicit Team worker. Defaults to the first registered non-lead adapter. */
  workerId?: string;
  repoPath: string;
  prompt: string;
  registry: AgentRegistry;
  /** Model for the lead's planning run (workers use their adapter defaults). */
  model?: string;
  /** Reasoning level for the lead; workers keep their adapter/config defaults. */
  reasoningLevel?: ReasoningLevel;
  /** Hard timeout for each lead attempt and worker task. */
  taskTimeoutMs?: number;
  /** How many independent tasks may execute at once (default 2). */
  maxConcurrency?: number;
  /** Optional canonical snapshots used by the opt-in capacity-aware router. */
  capacitySnapshots?: readonly AgentCapacitySnapshot[];
  capacityPolicy?: CapacityRoutingPolicyInput;
  /** Provider-confirmed model id for model-scoped capacity selection. */
  modelByAgent?: ReadonlyMap<string, string>;
  /** Links controlled single/multi runs of the same request for calibration. */
  comparisonId?: string;
  /** Parsed policy override; otherwise config/routing.yaml (or its defaults) is used. */
  routingConfig?: RoutingConfig;
  /** Why this flow mode was chosen (set by --mode auto resolution). */
  autoModeReason?: string;
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
export async function runBremio(opts: RunBremioOptions): Promise<BremioRunReport> {
  const { leadId, prompt, registry, logger } = opts;
  const repoPath = path.resolve(opts.repoPath);
  const efficiency = opts.routingConfig?.efficiency ?? (
    opts.comparisonId
      ? (await loadRoutingConfig()).efficiency
      : getDefaultRoutingConfig().efficiency
  );
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

  // Worker defaults to the first other provider; an explicit worker enables
  // deterministic three-provider Team runs.
  const workerId = opts.workerId ?? [...registry.keys()].find((id) => id !== leadId) ?? leadId;
  if (!registry.has(workerId)) {
    throw new Error(
      `worker "${workerId}" is not registered (available: ${[...registry.keys()].join(", ") || "none"})`,
    );
  }
  if (workerId === leadId && registry.size > 1) {
    throw new Error("Team worker must be different from the lead");
  }

  const workspace = new WorktreeManager(repoPath, { runToken: runId.slice(-6) });
  await workspace.assertUsable();
  const baseBranch = await getCurrentBranch(repoPath);

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
      validate: (candidate) => validatePlan(candidate, capabilitiesByAgent),
      onEvent: onLeadEvent,
    }));
  } catch (err) {
    const status = err instanceof LeadPlanError ? err.status : "failed";
    await recordPlanningLedger({
      ledgerPath: ledgerPathFor(repoPath),
      runId,
      leadId,
      status,
      durationMs: Date.now() - planningStarted,
      ...(opts.model ? { requestedModel: opts.model } : {}),
      ...observedIdentity(observedLeadModels, observedLeadReasoningLevels),
      ...(opts.reasoningLevel
        ? { requestedReasoningLevel: opts.reasoningLevel }
        : {}),
      ...(leadUsage ? { usage: leadUsage } : {}),
    });
    await recordInterruptedTeamSummary({
      ledgerPath: ledgerPathFor(repoPath),
      runId,
      status,
      ...(opts.comparisonId ? { comparisonId: opts.comparisonId } : {}),
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

  // This is the only meaningful kill-switch point: planning has finished, its
  // provider-reported coordination cost is durable, and no task worktree or
  // worker run exists yet. Once assign/runPlan starts we never re-evaluate or
  // restart the original prompt, because that would double-pay completed work.
  if (opts.comparisonId) {
    const decision = await evaluateCoordinationFallback({
      ledgerPath: ledgerPathFor(repoPath),
      comparisonId: opts.comparisonId,
      teamRunId: runId,
      maxOrchestrationCostShare: efficiency.maxOrchestrationCostShare,
      registry,
      capabilitiesByAgent,
    });
    if (decision.status === "triggered") {
      const fallback: SingleRunFallback = {
        fromMode: "team",
        teamRunId: runId,
        reason: decision.reason,
        baselineRunId: decision.baselineRunId,
        baselineTaskCostUsd: decision.baselineTaskCostUsd,
        orchestrationCostUsd: decision.orchestrationCostUsd,
        maxOrchestrationCostShare: efficiency.maxOrchestrationCostShare,
      };
      logger?.warn({ fallback, agentId: decision.agentId }, "Team fell back to Single");
      opts.hooks?.onFallback?.(decision.reason, decision.agentId);

      // Dynamic import avoids making single-run.ts <-> run.ts a runtime cycle;
      // single-run reuses createRunId from this module.
      const { runSingleAgent } = await import("./single-run");
      const singleReport = await runSingleAgent({
        primaryAgentId: decision.agentId,
        repoPath,
        prompt,
        registry,
        ...(opts.taskTimeoutMs ? { timeoutMs: opts.taskTimeoutMs } : {}),
        comparisonId: opts.comparisonId,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const report = { ...singleReport, fallback };
      await fs.writeFile(
        path.join(report.runDir, "report.json"),
        JSON.stringify(report, null, 2),
        "utf8",
      );
      return report;
    }
    logger?.debug({ reason: decision.reason }, "coordination kill-switch inert");
  }

  const capacityByAgent = opts.capacitySnapshots
    ? new Map(opts.capacitySnapshots.map((snapshot) => [snapshot.agentId, snapshot] as const))
    : undefined;
  const assign = assignAgents(plan, leadId, workerId, {
    capabilitiesByAgent,
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

  const reasonByTask = new Map<string, string>();
  const capacityPolicy = getDefaultRoutingConfig().capacityPolicy;
  for (const [taskId, agentId] of assign) {
    const snapshot = capacityByAgent?.get(agentId);
    const assessment = snapshot
      ? assessCapacity(snapshot, {
          policy: capacityPolicy,
          ...(opts.modelByAgent?.get(agentId)
            ? { modelId: opts.modelByAgent.get(agentId) }
            : {}),
        })
      : undefined;
    reasonByTask.set(
      taskId,
      assessment?.reason ?? (agentId === leadId ? "lead (deterministic)" : "worker (deterministic)"),
    );
  }

  const results = await runPlan({
    plan,
    assign,
    registry,
    workspace,
    runDir,
    runId,
    ledgerPath: ledgerPathFor(repoPath),
    ...(opts.taskTimeoutMs ? { taskTimeoutMs: opts.taskTimeoutMs } : {}),
    ...(opts.maxConcurrency ? { maxConcurrency: opts.maxConcurrency } : {}),
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
    reasonByTask,
    ...(opts.autoModeReason ? { autoModeReason: opts.autoModeReason } : {}),
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

interface InterruptedTeamSummaryInput {
  ledgerPath: string;
  runId: string;
  status: "failed" | "cancelled";
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

/** Preserve an objective negative outcome when Team stops during planning. */
async function recordInterruptedTeamSummary(
  input: InterruptedTeamSummaryInput,
): Promise<void> {
  try {
    await appendLedgerEntry(input.ledgerPath, {
      ts: new Date().toISOString(),
      runId: input.runId,
      taskId: `${input.runId}::summary`,
      scope: "run",
      provider: "bremio",
      role: "orchestrator",
      kind: "run-summary",
      status: input.status,
      filesChanged: 0,
      flowMode: "multi-agent",
      ...(input.comparisonId ? { comparisonId: input.comparisonId } : {}),
      qualityGatePassed: false,
      outcomeVerified: false,
    });
  } catch {
    // calibration measurement is best-effort; never replace the planning error
  }
}

interface EvaluateFallbackInput {
  ledgerPath: string;
  comparisonId: string;
  teamRunId: string;
  maxOrchestrationCostShare: number;
  registry: AgentRegistry;
  capabilitiesByAgent: ReadonlyMap<string, AgentCapabilities>;
}

interface TriggeredFallback {
  status: "triggered";
  reason: string;
  agentId: string;
  baselineRunId: string;
  baselineTaskCostUsd: number;
  orchestrationCostUsd: number;
}

interface InertFallback {
  status: "inert";
  reason: string;
}

type FallbackDecision = TriggeredFallback | InertFallback;

async function evaluateCoordinationFallback(
  input: EvaluateFallbackInput,
): Promise<FallbackDecision> {
  const entries = await readLedger(input.ledgerPath);
  const calibration = evaluateCalibrationReadiness(entries);
  if (calibration.status !== "ready") {
    return {
      status: "inert",
      reason: `calibration gate is not ready: ${calibration.blockers.join("; ")}`,
    };
  }
  const baseline = findBestSingleAgentBaseline(entries, input.comparisonId);
  if (baseline.status === "unknown") {
    return { status: "inert", reason: baseline.reason };
  }
  if (!input.registry.has(baseline.agentId)) {
    return {
      status: "inert",
      reason: `best Single baseline provider "${baseline.agentId}" is not registered`,
    };
  }
  const baselineCapabilities = input.capabilitiesByAgent.get(baseline.agentId);
  if (!baselineCapabilities?.repositoryRead || !baselineCapabilities.repositoryWrite) {
    return {
      status: "inert",
      reason: `best Single baseline provider "${baseline.agentId}" cannot run with workspace-write access`,
    };
  }

  const coordinationEntries = entries.filter((entry) =>
    entry.runId === input.teamRunId && entry.scope === "coordination");
  if (coordinationEntries.length === 0) {
    return { status: "inert", reason: "current Team run has no coordination entries" };
  }
  const missingCoordinationCost = coordinationEntries.find(
    (entry) => entry.usage?.costUsd === undefined,
  );
  if (missingCoordinationCost) {
    return {
      status: "inert",
      reason: `coordination entry "${missingCoordinationCost.taskId}" is missing provider-reported costUsd`,
    };
  }
  const orchestrationCostUsd = coordinationEntries.reduce(
    (total, entry) => total + (entry.usage?.costUsd ?? 0),
    0,
  );
  const costLimitUsd = baseline.costUsd * input.maxOrchestrationCostShare;
  if (orchestrationCostUsd <= costLimitUsd) {
    return {
      status: "inert",
      reason: `coordination cost $${orchestrationCostUsd.toFixed(4)} is within the configured limit $${costLimitUsd.toFixed(4)}`,
    };
  }

  const reason =
    `Team fallback: coordination cost $${orchestrationCostUsd.toFixed(4)} exceeded ` +
    `${formatPercent(input.maxOrchestrationCostShare)} of best Single baseline ` +
    `$${baseline.costUsd.toFixed(4)} (run ${baseline.runId})`;
  return {
    status: "triggered",
    reason,
    agentId: baseline.agentId,
    baselineRunId: baseline.runId,
    baselineTaskCostUsd: baseline.costUsd,
    orchestrationCostUsd,
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
