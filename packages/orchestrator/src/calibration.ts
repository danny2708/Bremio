import type { LedgerEntry } from "./ledger";

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
  pairedComparisons: number;
  evaluableComparisons: number;
  nonInferiorComparisons: number;
  nonInferiorRate: number;
  actualModelCoverage: number;
  reportedCostCoverage: number;
  coordinationCoverage: number;
  blockers: string[];
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
  const actualModelCoverage = ratio(
    executionEntries.filter((entry) => entry.actualModel !== undefined).length,
    executionEntries.length,
  );
  const reportedCostCoverage = ratio(
    executionEntries.filter((entry) => entry.usage?.costUsd !== undefined).length,
    executionEntries.length,
  );
  const runsWithCoordination = new Set(
    executionEntries
      .filter((entry) => entry.scope === "coordination")
      .map((entry) => entry.runId),
  );
  const coordinationCoverage = ratio(
    [...runsWithCoordination].filter((runId) => relevantMultiRunIds.has(runId)).length,
    relevantMultiRunIds.size,
  );

  const blockers: string[] = [];
  if (evaluable.length < policy.minimumPairedComparisons) {
    blockers.push(
      `paired passing baselines ${evaluable.length}/${policy.minimumPairedComparisons}`,
    );
  }
  if (nonInferiorRate < policy.minimumNonInferiorRate) {
    blockers.push(
      `multi-agent non-inferior rate ${formatPercent(nonInferiorRate)}/${formatPercent(policy.minimumNonInferiorRate)}`,
    );
  }
  if (actualModelCoverage < policy.minimumActualModelCoverage) {
    blockers.push(
      `actual-model coverage ${formatPercent(actualModelCoverage)}/${formatPercent(policy.minimumActualModelCoverage)}`,
    );
  }
  if (reportedCostCoverage < policy.minimumReportedCostCoverage) {
    blockers.push(
      `provider-reported cost coverage ${formatPercent(reportedCostCoverage)}/${formatPercent(policy.minimumReportedCostCoverage)}`,
    );
  }
  if (coordinationCoverage < policy.minimumCoordinationCoverage) {
    blockers.push(
      `coordination coverage ${formatPercent(coordinationCoverage)}/${formatPercent(policy.minimumCoordinationCoverage)}`,
    );
  }

  const ready = blockers.length === 0;
  return {
    status: ready ? "ready" : "insufficient-evidence",
    recommendation: ready ? "controlled-multi-agent" : "single-agent",
    pairedComparisons: paired.length,
    evaluableComparisons: evaluable.length,
    nonInferiorComparisons: nonInferior.length,
    nonInferiorRate,
    actualModelCoverage,
    reportedCostCoverage,
    coordinationCoverage,
    blockers,
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

function isOutcomeVerified(summary: LedgerEntry): boolean {
  return summary.outcomeVerified ?? summary.qualityGatePassed ?? false;
}
