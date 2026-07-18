import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LedgerEntrySchema,
  appendLedgerEntry,
  computeStats,
  readLedger,
  type LedgerEntry,
} from "./ledger";

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: new Date().toISOString(),
    runId: "r1",
    taskId: "T1",
    provider: "codex",
    role: "implementer",
    kind: "implementation",
    status: "completed",
    filesChanged: 1,
    durationMs: 1000,
    ...over,
  };
}

describe("computeStats", () => {
  it("aggregates by provider, status, runs, files, and duration", () => {
    const stats = computeStats([
      entry({
        provider: "codex",
        status: "completed",
        filesChanged: 2,
        durationMs: 1000,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
      }),
      entry({ provider: "codex", status: "failed", filesChanged: 0, durationMs: 2000 }),
      entry({
        provider: "claude",
        status: "completed",
        filesChanged: 1,
        durationMs: 3000,
        runId: "r2",
        usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.12 },
      }),
    ]);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalTasks).toBe(3);
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.totalFilesChanged).toBe(3);
    expect(stats.avgDurationMs).toBe(2000);
    expect(stats.completionRate).toBeCloseTo(2 / 3);
    expect(stats.usageEntries).toBe(2);
    expect(stats.reportedInputTokens).toBe(150);
    expect(stats.reportedOutputTokens).toBe(30);
    expect(stats.reportedCostUsd).toBeCloseTo(0.12);
    expect(stats.reportedCostEntries).toBe(2);
    expect(stats.byProvider.codex).toEqual({ tasks: 2, completed: 1, failed: 1, cancelled: 0 });
    expect(stats.byProvider.claude?.completed).toBe(1);
  });

  it("handles an empty ledger without dividing by zero", () => {
    const stats = computeStats([]);
    expect(stats.totalTasks).toBe(0);
    expect(stats.completionRate).toBe(0);
    expect(stats.avgDurationMs).toBe(0);
  });

  it("counts coordination overhead without inflating task outcomes", () => {
    const stats = computeStats([
      entry({
        scope: "coordination",
        taskId: "r1::lead",
        kind: "planning",
        role: "planner",
        status: "failed",
        filesChanged: 0,
        usage: { inputTokens: 25 },
      }),
      entry({ taskId: "T1", status: "completed" }),
    ]);

    expect(stats.totalRuns).toBe(1);
    expect(stats.totalTasks).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.coordinationEntries).toBe(1);
    expect(stats.coordinationFailed).toBe(1);
    expect(stats.coordinationCancelled).toBe(0);
    expect(stats.reportedInputTokens).toBe(25);
  });

  it("counts run summaries without inflating task or coordination totals", () => {
    const stats = computeStats([
      entry({
        scope: "run",
        taskId: "r1::summary",
        provider: "bremio",
        role: "orchestrator",
        kind: "run-summary",
        flowMode: "multi-agent",
        qualityGatePassed: true,
        filesChanged: 0,
      }),
      entry({ taskId: "T1", status: "completed" }),
    ]);

    expect(stats.runEntries).toBe(1);
    expect(stats.qualityPassedRuns).toBe(1);
    expect(stats.totalTasks).toBe(1);
    expect(stats.coordinationEntries).toBe(0);
  });
});

describe("readLedger", () => {
  it("round-trips entries, skips malformed lines, and filters by since", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ledger-"));
    const ledger = path.join(dir, "ledger.jsonl");
    try {
      await appendLedgerEntry(ledger, entry({ ts: "2026-07-01T00:00:00.000Z", taskId: "OLD" }));
      await appendLedgerEntry(ledger, entry({ ts: "2026-07-10T00:00:00.000Z", taskId: "NEW" }));
      await fs.appendFile(ledger, "not json at all\n");
      await fs.appendFile(ledger, `${JSON.stringify({ bad: "shape" })}\n`);

      const all = await readLedger(ledger);
      expect(all.map((e) => e.taskId)).toEqual(["OLD", "NEW"]);

      const recent = await readLedger(ledger, { since: new Date("2026-07-05T00:00:00.000Z") });
      expect(recent.map((e) => e.taskId)).toEqual(["NEW"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the ledger does not exist", async () => {
    expect(await readLedger(path.join(os.tmpdir(), "bremio-nope", "ledger.jsonl"))).toEqual([]);
  });
});

describe("LedgerEntrySchema", () => {
  it("rejects an entry missing required fields", () => {
    expect(LedgerEntrySchema.safeParse({ runId: "r" }).success).toBe(false);
  });
  it("accepts a well-formed entry", () => {
    expect(LedgerEntrySchema.safeParse(entry()).success).toBe(true);
  });
  it("preserves requested and provider-confirmed execution identity", () => {
    const parsed = LedgerEntrySchema.parse(entry({
      requestedModel: "requested-model",
      actualModel: "actual-model",
      requestedReasoningLevel: "high",
      actualReasoningLevel: "medium",
    }));

    expect(parsed).toMatchObject({
      requestedModel: "requested-model",
      actualModel: "actual-model",
      requestedReasoningLevel: "high",
      actualReasoningLevel: "medium",
    });
  });
  it("accepts a calibration run summary", () => {
    expect(LedgerEntrySchema.safeParse(entry({
      scope: "run",
      flowMode: "single-agent",
      comparisonId: "case-1",
      qualityGatePassed: true,
    })).success).toBe(true);
  });
});
