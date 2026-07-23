import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./ledger";
import { resolveAutoMode } from "./auto-mode";

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

function pair(id: string): LedgerEntry[] {
  return [
    summary(`${id}-single`, id, "single-agent"),
    execution(`${id}-single`),
    summary(`${id}-multi`, id, "multi-agent"),
    execution(`${id}-multi`),
    execution(`${id}-multi`, "coordination"),
  ];
}

describe("resolveAutoMode", () => {
  it("returns Single with calibration reason on empty ledger across task shapes", () => {
    const result = resolveAutoMode([]);
    expect(result.mode).toBe("single");
    expect(result.reason).toContain("calibration");
  });

  it("returns Team when calibration is ready", () => {
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < 5; i++) entries.push(...pair(`case-${i}`));
    const result = resolveAutoMode(entries);
    expect(result.mode).toBe("team");
    expect(result.reason).toContain("ready");
  });

  it("returns Single when no paired comparisons are evaluable", () => {
    const entries: LedgerEntry[] = [
      summary("single-1", "case-1", "single-agent", false),
      summary("multi-1", "case-1", "multi-agent", false),
    ];
    const result = resolveAutoMode(entries);
    expect(result.mode).toBe("single");
    expect(result.reason).toContain("calibration");
  });

  it("returns Single when preferTeamWhenReady is disabled", () => {
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < 5; i++) entries.push(...pair(`case-${i}`));
    const result = resolveAutoMode(entries, { preferTeamWhenReady: false });
    expect(result.mode).toBe("single");
    expect(result.reason).toContain("preferTeamWhenReady");
  });
});
