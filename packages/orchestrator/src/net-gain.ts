import type { LedgerEntry } from "./ledger";

export interface KnownNetGain {
  status: "known";
  comparisonId: string;
  multiRunId: string;
  baselineRunId: string;
  baselineCostUsd: number;
  multiAgentTaskCostUsd: number;
  quotaSavedVsBaselineUsd: number;
  orchestrationCostUsd: number;
  netGainUsd: number;
}

export interface UnknownNetGain {
  status: "unknown";
  comparisonId: string;
  multiRunId: string;
  reason: string;
}

export type NetGainResult = KnownNetGain | UnknownNetGain;

export interface KnownSingleBaseline {
  status: "known";
  agentId: string;
  runId: string;
  costUsd: number;
}

export interface UnknownSingleBaseline {
  status: "unknown";
  reason: string;
}

export type SingleBaselineResult = KnownSingleBaseline | UnknownSingleBaseline;

/**
 * Find the cheapest verified single-agent run for a comparison group.
 * Returns unknown when no evaluable single-agent run exists.
 */
export function findBestSingleAgentBaseline(
  entries: readonly LedgerEntry[],
  comparisonId: string,
): SingleBaselineResult {
  const singleRunIds = collectFlowRunIds(entries, comparisonId, "single-agent");
  if (singleRunIds.length === 0) {
    return { status: "unknown", reason: `no single-agent baseline for comparison "${comparisonId}"` };
  }

  const candidates: { runId: string; costUsd: number }[] = [];
  for (const runId of singleRunIds) {
    const taskCost = sumCostForEntries(entries, runId, "task");
    if (taskCost === undefined) continue;
    candidates.push({ runId, costUsd: taskCost });
  }

  if (candidates.length === 0) {
    return {
      status: "unknown",
      reason: `no single-agent baseline for comparison "${comparisonId}" has provider-reported costUsd`,
    };
  }

  candidates.sort((a, b) => a.costUsd - b.costUsd);
  const best = candidates[0]!;
  const agentId = findAgentId(entries, best.runId);
  if (!agentId) {
    return {
      status: "unknown",
      reason: `best single-agent baseline "${best.runId}" has no task entries to determine provider`,
    };
  }
  return { status: "known", agentId, runId: best.runId, costUsd: best.costUsd };
}

/**
 * Compute net_gain = baseline - (multi_task + coordination) for a comparison group.
 * Returns unknown when any required cost is missing.
 */
export function computeNetGain(
  entries: readonly LedgerEntry[],
  comparisonId: string,
  multiRunId?: string,
): NetGainResult {
  const allMultiRunIds = collectFlowRunIds(entries, comparisonId, "multi-agent");
  const multiRunIds = multiRunId
    ? (allMultiRunIds.includes(multiRunId) ? [multiRunId] : [])
    : allMultiRunIds;
  const firstMultiRun = multiRunIds[0];
  if (!firstMultiRun) {
    return {
      status: "unknown",
      comparisonId,
      multiRunId: multiRunId ?? "",
      reason: `no multi-agent run for comparison "${comparisonId}"`,
    };
  }

  const baseline = findBestSingleAgentBaseline(entries, comparisonId);
  if (baseline.status === "unknown") {
    return {
      status: "unknown",
      comparisonId,
      multiRunId: firstMultiRun,
      reason: baseline.reason,
    };
  }

  const missingCoordination = findMissingCostEntry(entries, multiRunIds, "coordination");
  if (missingCoordination) {
    return {
      status: "unknown",
      comparisonId,
      multiRunId: firstMultiRun,
      reason: `coordination entry "${missingCoordination.taskId}" in run "${missingCoordination.runId}" is missing provider-reported costUsd`,
    };
  }
  const missingTask = findMissingCostEntry(entries, multiRunIds, "task");
  if (missingTask) {
    return {
      status: "unknown",
      comparisonId,
      multiRunId: firstMultiRun,
      reason: `task entry "${missingTask.taskId}" in run "${missingTask.runId}" is missing provider-reported costUsd`,
    };
  }
  const multiTaskCost = sumCostForEntries(entries, multiRunIds, "task")!;
  const multiCoordinationCost = sumCostForEntries(entries, multiRunIds, "coordination")!;

  const multiTotal = multiTaskCost + multiCoordinationCost;
  const saved = baseline.costUsd - multiTaskCost;
  const netGain = baseline.costUsd - multiTotal;

  return {
    status: "known",
    comparisonId,
    multiRunId: firstMultiRun,
    baselineRunId: baseline.runId,
    baselineCostUsd: baseline.costUsd,
    multiAgentTaskCostUsd: multiTaskCost,
    quotaSavedVsBaselineUsd: saved,
    orchestrationCostUsd: multiCoordinationCost,
    netGainUsd: netGain,
  };
}

function collectFlowRunIds(
  entries: readonly LedgerEntry[],
  comparisonId: string,
  flowMode: "single-agent" | "multi-agent",
): string[] {
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (
      entry.scope === "run" &&
      entry.comparisonId === comparisonId &&
      entry.flowMode === flowMode
    ) {
      runIds.add(entry.runId);
    }
  }
  return [...runIds];
}

function sumCostForEntries(
  entries: readonly LedgerEntry[],
  runIds: string | string[],
  scope: "task" | "coordination",
): number | undefined {
  const runIdSet = new Set(typeof runIds === "string" ? [runIds] : runIds);
  let total = 0;
  let anyMissing = false;
  for (const entry of entries) {
    const entryScope = entry.scope ?? "task";
    if (entryScope !== scope) continue;
    if (!runIdSet.has(entry.runId)) continue;
    if (entry.usage?.costUsd === undefined) {
      anyMissing = true;
      continue;
    }
    total += entry.usage.costUsd;
  }
  if (anyMissing) return undefined;
  return total;
}

function findMissingCostEntry(
  entries: readonly LedgerEntry[],
  runIds: string[],
  scope: "task" | "coordination",
): { taskId: string; runId: string } | undefined {
  const runIdSet = new Set(runIds);
  for (const entry of entries) {
    const entryScope = entry.scope ?? "task";
    if (entryScope !== scope) continue;
    if (!runIdSet.has(entry.runId)) continue;
    if (entry.usage?.costUsd === undefined) {
      return { taskId: entry.taskId, runId: entry.runId };
    }
  }
  return undefined;
}

function findAgentId(entries: readonly LedgerEntry[], runId: string): string | undefined {
  for (const entry of entries) {
    if (entry.runId === runId && (entry.scope ?? "task") === "task") {
      return entry.provider;
    }
  }
  return undefined;
}
