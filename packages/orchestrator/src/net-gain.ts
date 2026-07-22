import type { LedgerEntry } from "./ledger";

export interface KnownNetGain {
  status: "known";
  comparisonId: string;
  multiRunId: string;
  baselineRunId: string;
  /** Best objectively verified Single run, using provider-reported cost only. */
  baselineCostUsd: number;
  /** Multi-agent task execution cost, excluding coordination entries. */
  multiAgentTaskCostUsd: number;
  quotaSavedVsBaselineUsd: number;
  /** Every scope:"coordination" entry for the measured multi-agent run. */
  orchestrationCostUsd: number;
  netGainUsd: number;
}

export interface UnknownNetGain {
  status: "unknown";
  comparisonId: string;
  multiRunId?: string;
  reason: string;
}

export type NetGainResult = KnownNetGain | UnknownNetGain;

export interface KnownSingleBaseline {
  status: "known";
  runId: string;
  agentId: string;
  costUsd: number;
}

export interface UnknownSingleBaseline {
  status: "unknown";
  reason: string;
}

export type SingleBaselineResult = KnownSingleBaseline | UnknownSingleBaseline;

interface CostResult {
  status: "known";
  costUsd: number;
}

interface UnknownCost {
  status: "unknown";
  reason: string;
}

/**
 * Compute net gain for one multi-agent run against the best verified Single
 * baseline carrying the same comparisonId.
 *
 * `costUsd` is the ledger's only comparable cost unit. It must be reported on
 * every included entry; token counts and subscription quota percentages are
 * deliberately ignored.
 */
export function computeNetGain(
  entries: readonly LedgerEntry[],
  comparisonId: string,
  multiRunId?: string,
): NetGainResult {
  const summaries = entries.filter((entry) =>
    entry.scope === "run" && entry.comparisonId === comparisonId && entry.flowMode);
  const multiSummaries = uniqueRuns(
    summaries.filter((entry) => entry.flowMode === "multi-agent"),
  );
  const multiSummary = resolveMultiSummary(multiSummaries, comparisonId, multiRunId);
  if (multiSummary.status === "unknown") return multiSummary;

  if (!isOutcomeVerified(multiSummary.summary)) {
    return unknown(
      comparisonId,
      `multi-agent run "${multiSummary.summary.runId}" is not objectively verified`,
      multiSummary.summary.runId,
    );
  }

  const baseline = findBestSingleAgentBaseline(entries, comparisonId);
  if (baseline.status === "unknown") {
    return unknown(
      comparisonId,
      baseline.reason,
      multiSummary.summary.runId,
    );
  }

  const taskCost = executionCost(entries, multiSummary.summary.runId, "task");
  if (taskCost.status === "unknown") {
    return unknown(comparisonId, taskCost.reason, multiSummary.summary.runId);
  }
  const orchestrationCost = executionCost(
    entries,
    multiSummary.summary.runId,
    "coordination",
  );
  if (orchestrationCost.status === "unknown") {
    return unknown(comparisonId, orchestrationCost.reason, multiSummary.summary.runId);
  }

  const quotaSavedVsBaselineUsd = baseline.costUsd - taskCost.costUsd;
  return {
    status: "known",
    comparisonId,
    multiRunId: multiSummary.summary.runId,
    baselineRunId: baseline.runId,
    baselineCostUsd: baseline.costUsd,
    multiAgentTaskCostUsd: taskCost.costUsd,
    quotaSavedVsBaselineUsd,
    orchestrationCostUsd: orchestrationCost.costUsd,
    netGainUsd: quotaSavedVsBaselineUsd - orchestrationCost.costUsd,
  };
}

/** Select the cheapest fully measured, objectively verified direct Single run. */
export function findBestSingleAgentBaseline(
  entries: readonly LedgerEntry[],
  comparisonId: string,
): SingleBaselineResult {
  const singleSummaries = uniqueRuns(entries.filter((entry) =>
    entry.scope === "run" &&
    entry.flowMode === "single-agent" &&
    entry.comparisonId === comparisonId));
  if (singleSummaries.length === 0) {
    return {
      status: "unknown",
      reason: `comparison "${comparisonId}" has no single-agent baseline`,
    };
  }
  const verifiedSingles = singleSummaries.filter(isOutcomeVerified);
  if (verifiedSingles.length === 0) {
    return {
      status: "unknown",
      reason: `comparison "${comparisonId}" has no objectively verified single-agent baseline`,
    };
  }

  const baselines: KnownSingleBaseline[] = [];
  for (const summary of verifiedSingles) {
    const taskEntries = entries.filter((entry) =>
      entry.runId === summary.runId && (entry.scope ?? "task") === "task");
    const cost = executionCost(entries, summary.runId, "task");
    if (cost.status === "unknown") return cost;
    const providers = [...new Set(taskEntries.map((entry) => entry.provider))];
    const agentId = providers[0];
    if (providers.length !== 1 || !agentId) {
      return {
        status: "unknown",
        reason: `single-agent baseline "${summary.runId}" has no unambiguous provider`,
      };
    }
    baselines.push({
      status: "known",
      runId: summary.runId,
      agentId,
      costUsd: cost.costUsd,
    });
  }
  return baselines.reduce((best, candidate) =>
    candidate.costUsd < best.costUsd ? candidate : best);
}

function resolveMultiSummary(
  summaries: LedgerEntry[],
  comparisonId: string,
  requestedRunId: string | undefined,
): { status: "known"; summary: LedgerEntry } | UnknownNetGain {
  if (requestedRunId) {
    const summary = summaries.find((entry) => entry.runId === requestedRunId);
    return summary
      ? { status: "known", summary }
      : unknown(
          comparisonId,
          `comparison "${comparisonId}" has no multi-agent run "${requestedRunId}"`,
          requestedRunId,
        );
  }
  if (summaries.length === 0) {
    return unknown(comparisonId, `comparison "${comparisonId}" has no multi-agent run`);
  }
  if (summaries.length > 1) {
    return unknown(
      comparisonId,
      `comparison "${comparisonId}" has multiple multi-agent runs; specify multiRunId`,
    );
  }
  const summary = summaries[0];
  if (!summary) return unknown(comparisonId, `comparison "${comparisonId}" has no multi-agent run`);
  return { status: "known", summary };
}

function executionCost(
  entries: readonly LedgerEntry[],
  runId: string,
  scope: "task" | "coordination",
): CostResult | UnknownCost {
  const matching = entries.filter((entry) =>
    entry.runId === runId && (entry.scope ?? "task") === scope);
  if (matching.length === 0) {
    return {
      status: "unknown",
      reason: `${scope === "task" ? "run" : "multi-agent run"} "${runId}" has no ${scope} entries`,
    };
  }
  let costUsd = 0;
  for (const entry of matching) {
    if (entry.usage?.costUsd === undefined) {
      return {
        status: "unknown",
        reason: `${scope} entry "${entry.taskId}" in run "${runId}" is missing provider-reported costUsd`,
      };
    }
    costUsd += entry.usage.costUsd;
  }
  return { status: "known", costUsd };
}

function uniqueRuns(entries: LedgerEntry[]): LedgerEntry[] {
  return [...new Map(entries.map((entry) => [entry.runId, entry])).values()];
}

function isOutcomeVerified(summary: LedgerEntry): boolean {
  return summary.outcomeVerified ?? summary.qualityGatePassed ?? false;
}

function unknown(
  comparisonId: string,
  reason: string,
  multiRunId?: string,
): UnknownNetGain {
  return {
    status: "unknown",
    comparisonId,
    ...(multiRunId ? { multiRunId } : {}),
    reason,
  };
}
