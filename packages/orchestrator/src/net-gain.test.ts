import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./ledger";
import { computeNetGain } from "./net-gain";

function summary(
  runId: string,
  comparisonId: string,
  flowMode: "single-agent" | "multi-agent",
): LedgerEntry {
  return {
    ts: "2026-07-22T00:00:00.000Z",
    runId,
    taskId: `${runId}::summary`,
    scope: "run",
    provider: "bremio",
    role: "orchestrator",
    kind: "run-summary",
    status: "completed",
    filesChanged: 0,
    flowMode,
    comparisonId,
    outcomeVerified: true,
    ...(flowMode === "multi-agent" ? { qualityGatePassed: true } : {}),
  };
}

function costEntry(
  runId: string,
  taskId: string,
  costUsd: number | undefined,
  scope: "task" | "coordination" = "task",
): LedgerEntry {
  return {
    ts: "2026-07-22T00:00:00.000Z",
    runId,
    taskId,
    scope,
    provider: scope === "task" ? "codex" : "claude",
    role: scope === "task" ? "implementer" : "planner",
    kind: scope === "task" ? "implementation" : "planning",
    status: "completed",
    filesChanged: 0,
    ...(costUsd === undefined ? {} : { usage: { costUsd } }),
  };
}

describe("computeNetGain", () => {
  it("computes provider-reported savings minus all orchestration cost", () => {
    const result = computeNetGain([
      summary("single-1", "case-1", "single-agent"),
      costEntry("single-1", "single-1::single", 1),
      summary("multi-1", "case-1", "multi-agent"),
      costEntry("multi-1", "TASK-1", 0.25),
      costEntry("multi-1", "TASK-2", 0.25),
      costEntry("multi-1", "multi-1::lead", 0.125, "coordination"),
      costEntry("multi-1", "multi-1::handoff", 0.125, "coordination"),
    ], "case-1");

    expect(result).toEqual({
      status: "known",
      comparisonId: "case-1",
      multiRunId: "multi-1",
      baselineRunId: "single-1",
      baselineCostUsd: 1,
      multiAgentTaskCostUsd: 0.5,
      quotaSavedVsBaselineUsd: 0.5,
      orchestrationCostUsd: 0.25,
      netGainUsd: 0.25,
    });
  });

  it("returns unknown with the specific blocker when any cost is missing", () => {
    const result = computeNetGain([
      summary("single-1", "case-1", "single-agent"),
      costEntry("single-1", "single-1::single", 1),
      summary("multi-1", "case-1", "multi-agent"),
      costEntry("multi-1", "TASK-1", 0.4),
      costEntry("multi-1", "multi-1::lead", undefined, "coordination"),
    ], "case-1");

    expect(result).toEqual({
      status: "unknown",
      comparisonId: "case-1",
      multiRunId: "multi-1",
      reason: "coordination entry \"multi-1::lead\" in run \"multi-1\" is missing provider-reported costUsd",
    });
  });

  it("returns unknown when the comparison has no Single baseline", () => {
    const result = computeNetGain([
      summary("multi-1", "case-1", "multi-agent"),
      costEntry("multi-1", "TASK-1", 0.4),
      costEntry("multi-1", "multi-1::lead", 0.1, "coordination"),
    ], "case-1");

    expect(result).toMatchObject({
      status: "unknown",
      comparisonId: "case-1",
      multiRunId: "multi-1",
      reason: expect.stringContaining("no single-agent baseline"),
    });
  });

  it("uses the cheapest verified Single run instead of averaging baselines", () => {
    const result = computeNetGain([
      summary("single-expensive", "case-1", "single-agent"),
      costEntry("single-expensive", "single-expensive::single", 1.5),
      summary("single-best", "case-1", "single-agent"),
      costEntry("single-best", "single-best::single", 1),
      summary("multi-1", "case-1", "multi-agent"),
      costEntry("multi-1", "TASK-1", 0.5),
      costEntry("multi-1", "multi-1::lead", 0.25, "coordination"),
    ], "case-1");

    expect(result).toMatchObject({
      status: "known",
      baselineRunId: "single-best",
      baselineCostUsd: 1,
      quotaSavedVsBaselineUsd: 0.5,
      orchestrationCostUsd: 0.25,
      netGainUsd: 0.25,
    });
  });
});
