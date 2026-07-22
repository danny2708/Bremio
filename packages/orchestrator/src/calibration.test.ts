import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./ledger";
import {
  evaluateCalibrationReadiness,
  resolveCalibrationPolicy,
} from "./calibration";

function summary(
  runId: string,
  comparisonId: string,
  flowMode: "single-agent" | "multi-agent",
  outcomeVerified = true,
): LedgerEntry {
  return {
    ts: "2026-07-18T00:00:00.000Z",
    runId,
    taskId: `${runId}::summary`,
    scope: "run",
    provider: "bremio",
    role: "orchestrator",
    kind: "run-summary",
    status: outcomeVerified ? "completed" : "failed",
    filesChanged: 0,
    flowMode,
    comparisonId,
    outcomeVerified,
    ...(flowMode === "multi-agent" ? { qualityGatePassed: outcomeVerified } : {}),
  };
}

function execution(runId: string, scope: "task" | "coordination" = "task"): LedgerEntry {
  return {
    ts: "2026-07-18T00:00:00.000Z",
    runId,
    taskId: scope === "task" ? `${runId}::task` : `${runId}::lead`,
    scope,
    provider: scope === "task" ? "codex" : "claude",
    role: scope === "task" ? "implementer" : "planner",
    kind: scope === "task" ? "implementation" : "planning",
    status: "completed",
    filesChanged: 0,
    actualModel: scope === "task" ? "codex-model" : "claude-model",
    usage: { costUsd: 0.01 },
  };
}

function pair(id: string, multiPassed = true): LedgerEntry[] {
  const singleRun = `${id}-single`;
  const multiRun = `${id}-multi`;
  return [
    summary(singleRun, id, "single-agent"),
    execution(singleRun),
    summary(multiRun, id, "multi-agent", multiPassed),
    execution(multiRun),
    execution(multiRun, "coordination"),
  ];
}

describe("evaluateCalibrationReadiness", () => {
  it("fails closed when no paired evidence exists", () => {
    const result = evaluateCalibrationReadiness([]);

    expect(result).toMatchObject({
      status: "insufficient-evidence",
      recommendation: "single-agent",
      pairedComparisons: 0,
    });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("paired passing baselines 0/5"),
      expect.stringContaining("provider-reported cost coverage 0%/80%"),
    ]));
  });

  it("becomes ready only from matched, fully observed non-inferior pairs", () => {
    const entries = Array.from({ length: 5 }, (_, index) => pair(`case-${index}`)).flat();
    const result = evaluateCalibrationReadiness(entries);

    expect(result).toMatchObject({
      status: "ready",
      recommendation: "controlled-multi-agent",
      pairedComparisons: 5,
      evaluableComparisons: 5,
      nonInferiorComparisons: 5,
      actualModelCoverage: 1,
      reportedCostCoverage: 1,
      coordinationCoverage: 1,
      blockers: [],
    });
  });

  it("does not count a failed single-agent baseline as evaluable", () => {
    const entries = pair("case");
    const single = entries.find((entry) => entry.flowMode === "single-agent");
    if (single) single.outcomeVerified = false;

    const result = evaluateCalibrationReadiness(entries, { minimumPairedComparisons: 1 });
    expect(result.pairedComparisons).toBe(1);
    expect(result.evaluableComparisons).toBe(0);
    expect(result.status).toBe("insufficient-evidence");
  });

  it("blocks readiness when multi-agent quality is inferior", () => {
    const result = evaluateCalibrationReadiness(pair("case", false), {
      minimumPairedComparisons: 1,
    });

    expect(result.evaluableComparisons).toBe(1);
    expect(result.nonInferiorRate).toBe(0);
    expect(result.blockers).toContain(
      "multi-agent non-inferior rate 0%/90% (0/1); " +
        "need 9 additional non-inferior comparisons",
    );
  });

  it("requires provider-reported cost instead of estimating missing entries", () => {
    const entries = pair("case");
    const task = entries.find((entry) => entry.scope === "task");
    if (task) task.usage = undefined;

    const result = evaluateCalibrationReadiness(entries, { minimumPairedComparisons: 1 });
    expect(result.reportedCostCoverage).toBeCloseTo(2 / 3);
    expect(result.blockers).toContain(
      "provider-reported cost coverage 67%/80% (2/3); " +
        "need 2 additional cost-reported ledger entries",
    );
    expect(result.recommendation).toBe("single-agent");
  });
});

describe("resolveCalibrationPolicy", () => {
  it("validates sample counts and coverage thresholds", () => {
    expect(() => resolveCalibrationPolicy({ minimumPairedComparisons: 0 }))
      .toThrow(/positive integer/);
    expect(() => resolveCalibrationPolicy({ minimumReportedCostCoverage: 1.1 }))
      .toThrow(/between 0 and 1/);
  });
});
