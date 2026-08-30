import type { LedgerEntry } from "./ledger";
import { summarizeNetGain, type NetGainSummary } from "./net-gain";

export interface CalibrationPolicy {
  minimumPairedComparisons: number;
  minimumNonInferiorRate: number;
  minimumActualModelCoverage: number;
  minimumReportedCostCoverage: number;
  minimumCoordinationCoverage: number;
}

export type CalibrationPolicyInput = Partial<CalibrationPolicy>;

export const DEFAULT_CALIBRATION_POLICY: Readonly<CalibrationPolicy> = {
  minimumPairedComparisons: 5,
  minimumNonInferiorRate: 0.9,
  minimumActualModelCoverage: 0.8,
  minimumReportedCostCoverage: 0.8,
  minimumCoordinationCoverage: 1,
};

export interface CalibrationReadiness {
  status: "ready" | "insufficient-evidence";
  recommendation: "single-agent" | "controlled-multi-agent";
  expansionStatus: "enabled" | "disabled";
  pairedComparisons: number;
  evaluableComparisons: number;
  nonInferiorComparisons: number;
  nonInferiorRate: number;
  actualModelCoverage: number;
  reportedCostCoverage: number;
  coordinationCoverage: number;
  netGainSummary: NetGainSummary;
  blockers: string[];
  expansionBlockers: string[];
}

interface ComparisonGroup {
  single: LedgerEntry[];
  multi: LedgerEntry[];
}

/**
 * Determine whether observed, paired evidence is sufficient to permit a
 * controlled multi-agent experiment. No quota, price, or outcome is inferred:
 * cost must be provider-reported and outcomes must be objectively verified by
 * the execution mode (Single verification or Team quality gate).
 */
export function evaluateCalibrationReadiness(
  entries: readonly LedgerEntry[],
  input: CalibrationPolicyInput = {},
): CalibrationReadiness {
  const policy = resolveCalibrationPolicy(input);
  const runSummaries = entries.filter(
    (entry) => entry.scope === "run" && entry.comparisonId && entry.flowMode,
  );
  const groups = new Map<string, ComparisonGroup>();
  for (const summary of runSummaries) {
    const group = groups.get(summary.comparisonId as string) ?? { single: [], multi: [] };
    if (summary.flowMode === "single-agent") group.single.push(summary);
    else group.multi.push(summary);
    groups.set(summary.comparisonId as string, group);
  }

  const paired = [...groups.values()].filter(
    (group) => group.single.length > 0 && group.multi.length > 0,
  );
  // A multi-agent result is comparable only when every matching Single
  // baseline passed its mode-appropriate objective verification.
  const evaluable = paired.filter((group) =>
    group.single.every(isOutcomeVerified));
  const nonInferior = evaluable.filter((group) =>
    group.multi.every(isOutcomeVerified));
  const nonInferiorRate = ratio(nonInferior.length, evaluable.length);

  const relevantRunIds = new Set(
    evaluable.flatMap((group) => [...group.single, ...group.multi].map((entry) => entry.runId)),
  );
  const relevantMultiRunIds = new Set(
    evaluable.flatMap((group) => group.multi.map((entry) => entry.runId)),
  );
  const executionEntries = entries.filter((entry) =>
    relevantRunIds.has(entry.runId) &&
    (entry.scope === "task" || entry.scope === "coordination" || entry.scope === undefined));
  const actualModelEntries = executionEntries.filter(
    (entry) => entry.actualModel !== undefined,
  ).length;
  const reportedCostEntries = executionEntries.filter(
    (entry) => entry.usage?.costUsd !== undefined,
  ).length;
  const actualModelCoverage = ratio(actualModelEntries, executionEntries.length);
  const reportedCostCoverage = ratio(reportedCostEntries, executionEntries.length);
  const runsWithCoordination = new Set(
    executionEntries
      .filter((entry) => entry.scope === "coordination")
      .map((entry) => entry.runId),
  );
  const coordinatedRuns = [...runsWithCoordination]
    .filter((runId) => relevantMultiRunIds.has(runId)).length;
  const coordinationCoverage = ratio(coordinatedRuns, relevantMultiRunIds.size);

  const blockers: string[] = [];
  if (evaluable.length < policy.minimumPairedComparisons) {
    const missing = policy.minimumPairedComparisons - evaluable.length;
    blockers.push(
      `paired passing baselines ${evaluable.length}/${policy.minimumPairedComparisons}; ` +
        `need ${formatCount(missing, "more evaluable comparison")}`,
    );
  }
  if (nonInferiorRate < policy.minimumNonInferiorRate) {
    const missing = additionalCoveredSamplesNeeded(
      nonInferior.length,
      evaluable.length,
      policy.minimumNonInferiorRate,
    );
    blockers.push(
      `multi-agent non-inferior rate ${formatPercent(nonInferiorRate)}/` +
        `${formatPercent(policy.minimumNonInferiorRate)} ` +
        `(${nonInferior.length}/${evaluable.length}); ` +
        `need ${formatCount(missing, "additional non-inferior comparison")}`,
    );
  }
  if (actualModelCoverage < policy.minimumActualModelCoverage) {
    const missing = additionalCoveredSamplesNeeded(
      actualModelEntries,
      executionEntries.length,
      policy.minimumActualModelCoverage,
    );
    blockers.push(
      `actual-model coverage ${formatPercent(actualModelCoverage)}/` +
        `${formatPercent(policy.minimumActualModelCoverage)} ` +
        `(${actualModelEntries}/${executionEntries.length}); ` +
        `need ${formatCount(
          missing,
          "additional model-reported ledger entry",
          "additional model-reported ledger entries",
        )}`,
    );
  }
  if (reportedCostCoverage < policy.minimumReportedCostCoverage) {
    const missing = additionalCoveredSamplesNeeded(
      reportedCostEntries,
      executionEntries.length,
      policy.minimumReportedCostCoverage,
    );
    blockers.push(
      `provider-reported cost coverage ${formatPercent(reportedCostCoverage)}/` +
        `${formatPercent(policy.minimumReportedCostCoverage)} ` +
        `(${reportedCostEntries}/${executionEntries.length}); ` +
        `need ${formatCount(
          missing,
          "additional cost-reported ledger entry",
          "additional cost-reported ledger entries",
        )}`,
    );
  }
  if (coordinationCoverage < policy.minimumCoordinationCoverage) {
    const missing = policy.minimumCoordinationCoverage === 1
      ? Math.max(1, relevantMultiRunIds.size - coordinatedRuns)
      : additionalCoveredSamplesNeeded(
          coordinatedRuns,
          relevantMultiRunIds.size,
          policy.minimumCoordinationCoverage,
        );
    blockers.push(
      `coordination coverage ${formatPercent(coordinationCoverage)}/` +
        `${formatPercent(policy.minimumCoordinationCoverage)} ` +
        `(${coordinatedRuns}/${relevantMultiRunIds.size}); ` +
        `need ${formatCount(
          missing,
          "more Team run with coordination evidence",
          "more Team runs with coordination evidence",
        )}`,
    );
  }

  const ready = blockers.length === 0;
  const netGainSummary = summarizeNetGain(entries);
  const expansionBlockers: string[] = [...blockers];
  if (netGainSummary.aggregate.status === "unknown") {
    expansionBlockers.push(`net gain is unknown: ${netGainSummary.aggregate.reason}`);
  } else if (netGainSummary.aggregate.netGainUsd <= 0) {
    expansionBlockers.push(
      `net gain is non-positive ($${netGainSummary.aggregate.netGainUsd.toFixed(4)})`,
    );
  }

  const expansionStatus: "enabled" | "disabled" =
    ready && expansionBlockers.length === 0 ? "enabled" : "disabled";

  return {
    status: ready ? "ready" : "insufficient-evidence",
    recommendation: ready ? "controlled-multi-agent" : "single-agent",
    expansionStatus,
    pairedComparisons: paired.length,
    evaluableComparisons: evaluable.length,
    nonInferiorComparisons: nonInferior.length,
    nonInferiorRate,
    actualModelCoverage,
    reportedCostCoverage,
    coordinationCoverage,
    netGainSummary,
    blockers,
    expansionBlockers,
  };
}

export function resolveCalibrationPolicy(
  input: CalibrationPolicyInput = {},
): CalibrationPolicy {
  const policy = { ...DEFAULT_CALIBRATION_POLICY, ...input };
  if (!Number.isInteger(policy.minimumPairedComparisons) || policy.minimumPairedComparisons <= 0) {
    throw new Error("minimumPairedComparisons must be a positive integer");
  }
  for (const [name, value] of [
    ["minimumNonInferiorRate", policy.minimumNonInferiorRate],
    ["minimumActualModelCoverage", policy.minimumActualModelCoverage],
    ["minimumReportedCostCoverage", policy.minimumReportedCostCoverage],
    ["minimumCoordinationCoverage", policy.minimumCoordinationCoverage],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be between 0 and 1`);
    }
  }
  return policy;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Minimum number of fully observed new samples needed for a ratio to reach its
 * threshold. At 100%, new samples cannot repair an existing uncovered sample;
 * callers must instead name the number of existing samples that need evidence.
 */
function additionalCoveredSamplesNeeded(
  covered: number,
  total: number,
  threshold: number,
): number {
  if (threshold <= 0) return 0;
  if (total === 0) return 1;
  if (threshold === 1) return Math.max(1, total - covered);
  const numerator = threshold * total - covered;
  return Math.max(1, Math.ceil((numerator / (1 - threshold)) - 1e-12));
}

function formatCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isOutcomeVerified(summary: LedgerEntry): boolean {
  return summary.outcomeVerified ?? summary.qualityGatePassed ?? false;
}
