import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendLedgerEntry,
  ledgerPathFor,
  type LedgerEntry,
} from "@bremio/orchestrator";
import { statsCommand } from "./stats";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("statsCommand", () => {
  it("shows a coordination-only failed run instead of claiming the ledger is empty", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-stats-"));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => lines.push(String(line)));
    try {
      await appendLedgerEntry(ledgerPathFor(repo), {
        ts: new Date().toISOString(),
        runId: "run-failed-plan",
        taskId: "run-failed-plan::lead",
        scope: "coordination",
        provider: "claude",
        role: "planner",
        kind: "planning",
        status: "failed",
        filesChanged: 0,
        usage: { inputTokens: 10 },
      });

      expect(await statsCommand({ repoPath: repo })).toBe(0);
      expect(lines.join("\n")).toContain("tasks:           0");
      expect(lines.join("\n")).toContain("coordination:    1 planning run(s) (1 failed)");
      expect(lines.join("\n")).toContain("calibration: insufficient-evidence");
      expect(lines.join("\n")).toContain("recommendation: single-agent");
      expect(lines.join("\n")).not.toContain("no ledger entries");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("renders known zero and unknown net-gain groups without conflating them", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-stats-"));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => lines.push(String(line)));
    try {
      const entries = [
        ...comparison("known-zero", 1, 0.75, 0.25),
        ...comparison("unknown-cost", 1, 0.5, undefined),
      ];
      for (const entry of entries) await appendLedgerEntry(ledgerPathFor(repo), entry);

      expect(await statsCommand({ repoPath: repo })).toBe(0);
      const output = lines.join("\n");
      expect(output).toContain("known-zero: $0.0000 (1 Team run)");
      expect(output).toContain(
        "unknown-cost: unknown - run unknown-cost-multi: coordination entry",
      );
      expect(output).toContain("is missing provider-reported costUsd");
      expect(output).toContain("aggregate: unknown - 1/2 comparison groups unknown");
      expect(output).not.toContain("unknown-cost: $0.0000");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("names each missing calibration dimension and its sample deficit", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-stats-"));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => lines.push(String(line)));
    try {
      expect(await statsCommand({ repoPath: repo })).toBe(0);
      const output = lines.join("\n");
      expect(output).toContain(
        "paired passing baselines 0/5; need 5 more evaluable comparisons",
      );
      expect(output).toContain(
        "actual-model coverage 0%/80% (0/0); need 1 additional model-reported ledger entry",
      );
      expect(output).toContain(
        "provider-reported cost coverage 0%/80% (0/0); " +
          "need 1 additional cost-reported ledger entry",
      );
      expect(output).toContain(
        "coordination coverage 0%/100% (0/0); " +
          "need 1 more Team run with coordination evidence",
      );
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps the single-agent recommendation while cost coverage is below threshold", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-stats-"));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => lines.push(String(line)));
    try {
      const entries = Array.from({ length: 5 }, (_, index) =>
        comparison(`case-${index}`, 1, 0.5, 0.25)).flat();
      for (const entry of entries.filter((entry) => entry.scope !== "run").slice(0, 4)) {
        entry.usage = undefined;
      }
      for (const entry of entries) await appendLedgerEntry(ledgerPathFor(repo), entry);

      expect(await statsCommand({ repoPath: repo })).toBe(0);
      const output = lines.join("\n");
      expect(output).toContain("provider-reported cost coverage 73%/80% (11/15)");
      expect(output).toContain("calibration: insufficient-evidence");
      expect(output).toContain("recommendation: single-agent");
      expect(output).not.toContain("recommendation: controlled-multi-agent");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

function comparison(
  comparisonId: string,
  baselineCostUsd: number,
  taskCostUsd: number,
  coordinationCostUsd: number | undefined,
): LedgerEntry[] {
  const singleRunId = `${comparisonId}-single`;
  const multiRunId = `${comparisonId}-multi`;
  return [
    runSummary(singleRunId, comparisonId, "single-agent"),
    execution(singleRunId, `${singleRunId}::task`, "task", baselineCostUsd),
    runSummary(multiRunId, comparisonId, "multi-agent"),
    execution(multiRunId, `${multiRunId}::task`, "task", taskCostUsd),
    execution(multiRunId, `${multiRunId}::lead`, "coordination", coordinationCostUsd),
  ];
}

function runSummary(
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

function execution(
  runId: string,
  taskId: string,
  scope: "task" | "coordination",
  costUsd: number | undefined,
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
    actualModel: `${scope}-model`,
    ...(costUsd === undefined ? {} : { usage: { costUsd } }),
  };
}
