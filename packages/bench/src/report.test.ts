import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareBench,
  formatBenchReport,
  formatComparison,
  formatCost,
  listBenchResults,
  loadBenchResult,
} from "./report";
import { summarize } from "./runner";
import type { BenchCaseResult, BenchRunResult } from "./schema";

function caseResult(caseId: string, resolved: boolean, costUsd: number | null, over: Partial<BenchCaseResult> = {}): BenchCaseResult {
  return {
    caseId,
    title: caseId,
    category: "bug-fix",
    language: "javascript",
    resolved,
    runStatus: "completed",
    qualityGate: "n/a",
    verification: { ok: resolved, commands: [] },
    wallTimeMs: 1000,
    usage: { entries: 1, entriesWithUsage: costUsd === null ? 0 : 1, costUsd },
    overBudget: null,
    ...over,
  };
}

function run(id: string, createdAt: string, cases: BenchCaseResult[], over: Partial<BenchRunResult> = {}): BenchRunResult {
  return {
    schemaVersion: 1,
    benchRunId: id,
    createdAt,
    mode: "single",
    agentId: "codex",
    cases,
    summary: summarize(cases),
    ...over,
  };
}

describe("summarize", () => {
  it("computes rates and keeps unknown cost unknown", () => {
    const s = summarize([caseResult("a", true, 0.1), caseResult("b", false, null), caseResult("c", true, 0.2)]);
    expect(s).toMatchObject({
      cases: 3,
      resolved: 2,
      totalCostUsd: null,
      knownCostUsd: 0.3,
      casesWithKnownCost: 2,
      totalWallTimeMs: 3000,
      gatePassRate: null,
    });
    expect(s.resolveRate).toBeCloseTo(2 / 3);
  });

  it("reports a total only when every case's cost is known", () => {
    expect(summarize([caseResult("a", true, 0.1), caseResult("b", false, 0.05)]).totalCostUsd).toBeCloseTo(0.15);
  });

  it("counts gate pass rate over cases whose gate ran", () => {
    const s = summarize([
      caseResult("a", true, 0, { qualityGate: "passed" }),
      caseResult("b", false, 0, { qualityGate: "failed" }),
      caseResult("c", false, 0, { qualityGate: "not-run" }),
    ]);
    expect(s.gatePassRate).toBe(0.5);
  });

  it("handles an empty run without dividing by zero", () => {
    expect(summarize([])).toMatchObject({ cases: 0, resolveRate: 0, totalCostUsd: null, gatePassRate: null });
  });
});

describe("compareBench", () => {
  const before = run("bench-a", "2026-11-01T00:00:00.000Z", [
    caseResult("x", false, 0.1),
    caseResult("y", true, 0.1),
    caseResult("z", true, 0.1),
  ]);
  const after = run("bench-b", "2026-11-02T00:00:00.000Z", [
    caseResult("x", true, 0.2),
    caseResult("y", false, 0.1),
    caseResult("z", true, 0.1),
  ]);

  it("names fixed and regressed cases", () => {
    const cmp = compareBench(before, after);
    expect(cmp.cases).toEqual([
      { caseId: "x", before: false, after: true, change: "fixed" },
      { caseId: "y", before: true, after: false, change: "regressed" },
      { caseId: "z", before: true, after: true, change: "same" },
    ]);
    expect(cmp.resolveRateDelta).toBeCloseTo(0);
    expect(cmp.costDeltaUsd).toBeCloseTo(0.1);
  });

  it("leaves the cost delta unknown when either side is unknown", () => {
    const unknown = run("bench-c", "2026-11-03T00:00:00.000Z", [caseResult("x", true, null)]);
    const cmp = compareBench(before, unknown);
    expect(cmp.costDeltaUsd).toBeNull();
    expect(formatComparison(cmp)).toContain("delta unknown");
    expect(formatComparison(cmp)).toContain("different cases");
  });
});

describe("formatting", () => {
  it("never prints an unknown cost as a number", () => {
    expect(formatCost(null)).toBe("unknown");
    expect(formatCost(null, { knownCostUsd: 0.3, casesWithKnownCost: 2, cases: 3 }))
      .toBe("unknown (known for 2/3 cases: $0.3000)");
    expect(formatCost(0.25)).toBe("$0.2500");
  });

  it("renders a report with every case", () => {
    const text = formatBenchReport(run("bench-a", "2026-11-01T00:00:00.000Z", [caseResult("x", true, null)]));
    expect(text).toContain("resolved:   1/1  (100.0%)");
    expect(text).toContain("cost:       unknown");
    expect(text).toContain("x");
  });
});

describe("result storage", () => {
  it("loads the newest by default, a named one on request, and skips junk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-bench-report-"));
    try {
      const older = run("bench-1", "2026-11-01T00:00:00.000Z", [caseResult("x", true, 0)]);
      const newer = run("bench-2", "2026-11-02T00:00:00.000Z", [caseResult("x", false, 0)]);
      await fs.writeFile(path.join(dir, "bench-1.json"), JSON.stringify(older));
      await fs.writeFile(path.join(dir, "bench-2.json"), JSON.stringify(newer));
      await fs.writeFile(path.join(dir, "bench-junk.json"), "{ not json");
      expect((await listBenchResults(dir)).map((r) => r.benchRunId)).toEqual(["bench-1", "bench-2"]);
      expect((await loadBenchResult(dir)).benchRunId).toBe("bench-2");
      expect((await loadBenchResult(dir, "bench-1")).benchRunId).toBe("bench-1");
      await expect(loadBenchResult(dir, "bench-9")).rejects.toThrow(/not found/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("says so when there are no results", async () => {
    await expect(loadBenchResult(path.join(os.tmpdir(), "bremio-bench-none-xyz"))).rejects.toThrow(/no bench results/);
  });
});
