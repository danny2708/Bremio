import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { appendLedgerEntry, ledgerPathFor } from "./ledger";
import { createRegistry } from "./registry";
import { getDefaultRoutingConfig, type RoutingConfig } from "./routing-config";
import { runBremio } from "./run";

const CAPS: AgentCapabilities = {
  planning: true,
  structuredOutput: true,
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: true,
  browser: false,
  vision: false,
  resumableSessions: false,
  readOnlyEnforcement: "provider-native",
};

abstract class EfficiencyAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly provider: string;
  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPS;
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
  async healthCheck(): Promise<AgentHealth> {
    return { status: "ok" };
  }
  abstract startRun(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  resumeRun(): AsyncIterable<AgentEvent> {
    throw new Error("not implemented");
  }
  async cancelRun(): Promise<void> {}
}

class PlanningLead extends EfficiencyAdapter {
  readonly id = "claude";
  readonly provider = "anthropic";

  constructor(private readonly planningCostUsd: number | undefined) {
    super();
  }

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    yield { type: "started", runId: request.runId, ts };
    if (this.planningCostUsd !== undefined) {
      yield {
        type: "usage",
        runId: request.runId,
        ts,
        costUsd: this.planningCostUsd,
      };
    }
    const plan = {
      summary: "Implement one measured change",
      leadAgentId: this.id,
      tasks: [{
        id: "TASK-001",
        title: "Implement the change",
        kind: "implementation",
        risk: "low",
        dependencies: [],
        requiredCapabilities: ["repository.write"],
      }],
    };
    yield {
      type: "completed",
      runId: request.runId,
      ts,
      outcome: { status: "completed", finalText: JSON.stringify(plan) },
    };
  }
}

class DirectWorker extends EfficiencyAdapter {
  readonly id = "codex";
  readonly provider = "openai";
  teamRuns = 0;
  singleRuns = 0;

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    const teamTask = request.runId.startsWith("TASK-");
    if (teamTask) this.teamRuns += 1;
    else this.singleRuns += 1;
    yield { type: "started", runId: request.runId, ts };
    await fs.writeFile(
      path.join(request.cwd, teamTask ? "TEAM.txt" : "FALLBACK.txt"),
      teamTask ? "team\n" : "single fallback\n",
      "utf8",
    );
    if (!teamTask) {
      yield {
        type: "tool_use",
        runId: request.runId,
        ts,
        name: "shell",
        input: { command: "npm test" },
      };
      yield {
        type: "tool_result",
        runId: request.runId,
        ts,
        name: "shell",
        ok: true,
        exitCode: 0,
      };
    }
    yield { type: "usage", runId: request.runId, ts, costUsd: 0.1 };
    yield {
      type: "completed",
      runId: request.runId,
      ts,
      outcome: { status: "completed", finalText: "done" },
    };
  }
}

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-efficiency-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "# Efficiency test\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe("Team coordination kill-switch", () => {
  it("falls back before Team tasks when overhead exceeds the configured share", async () => {
    await seedReadyCalibration("case-high", 1);
    const worker = new DirectWorker();
    const report = await runBremio({
      leadId: "claude",
      workerId: "codex",
      repoPath: repo,
      prompt: "implement directly if Team is too expensive",
      registry: createRegistry([new PlanningLead(0.6), worker]),
      comparisonId: "case-high",
      routingConfig: configWithThreshold(0.5),
    });

    expect(report.mode).toBe("single");
    if (report.mode !== "single") throw new Error("expected Single fallback");
    expect(report.fallback).toMatchObject({
      fromMode: "team",
      baselineRunId: "case-high-single",
      baselineTaskCostUsd: 1,
      orchestrationCostUsd: 0.6,
      maxOrchestrationCostShare: 0.5,
    });
    expect(report.fallback?.reason).toContain("exceeded 50% of best Single baseline");
    expect(worker.teamRuns).toBe(0);
    expect(worker.singleRuns).toBe(1);
  });

  it("stays inert when provider-reported coordination cost is incomplete", async () => {
    await seedReadyCalibration("case-unknown", 1);
    const worker = new DirectWorker();
    const report = await runBremio({
      leadId: "claude",
      workerId: "codex",
      repoPath: repo,
      prompt: "do not estimate missing cost",
      registry: createRegistry([new PlanningLead(undefined), worker]),
      comparisonId: "case-unknown",
      routingConfig: configWithThreshold(0.1),
    });

    expect(report.mode).toBe("team");
    expect(worker.teamRuns).toBe(1);
    expect(worker.singleRuns).toBe(0);
  });

  it("leaves Team execution untouched when overhead is within the threshold", async () => {
    await seedReadyCalibration("case-low", 1);
    const worker = new DirectWorker();
    const report = await runBremio({
      leadId: "claude",
      workerId: "codex",
      repoPath: repo,
      prompt: "keep Team when coordination is affordable",
      registry: createRegistry([new PlanningLead(0.2), worker]),
      comparisonId: "case-low",
      routingConfig: configWithThreshold(0.25),
    });

    expect(report.mode).toBe("team");
    expect(worker.teamRuns).toBe(1);
    expect(worker.singleRuns).toBe(0);
  });

  it("surfaces the exact fallback reason through the hook and persisted report", async () => {
    await seedReadyCalibration("case-report", 1);
    const reasons: string[] = [];
    const report = await runBremio({
      leadId: "claude",
      workerId: "codex",
      repoPath: repo,
      prompt: "surface the fallback",
      registry: createRegistry([new PlanningLead(0.3), new DirectWorker()]),
      comparisonId: "case-report",
      routingConfig: configWithThreshold(0.2),
      hooks: { onFallback: (reason) => reasons.push(reason) },
    });

    expect(report.mode).toBe("single");
    if (report.mode !== "single" || !report.fallback) {
      throw new Error("expected fallback metadata");
    }
    expect(reasons).toEqual([report.fallback.reason]);
    const stored = JSON.parse(
      await fs.readFile(path.join(report.runDir, "report.json"), "utf8"),
    ) as { fallback?: { reason?: string } };
    expect(stored.fallback?.reason).toBe(report.fallback.reason);
  });
});

async function seedReadyCalibration(comparisonId: string, costUsd: number): Promise<void> {
  const ids = [comparisonId, "calibration-2", "calibration-3", "calibration-4", "calibration-5"];
  for (const id of ids) {
    await seedPair(id, id === comparisonId ? costUsd : 1);
  }
}

async function seedPair(comparisonId: string, singleCostUsd: number): Promise<void> {
  const runId = `${comparisonId}-single`;
  const ledgerPath = ledgerPathFor(repo);
  await appendLedgerEntry(ledgerPath, {
    ts: "2026-07-22T00:00:00.000Z",
    runId,
    taskId: `${runId}::single`,
    scope: "task",
    provider: "codex",
    role: "implementer",
    kind: "single-run",
    status: "completed",
    filesChanged: 1,
    actualModel: "codex-measured",
    usage: { costUsd: singleCostUsd },
    flowMode: "single-agent",
    comparisonId,
  });
  await appendLedgerEntry(ledgerPath, {
    ts: "2026-07-22T00:00:00.000Z",
    runId,
    taskId: `${runId}::summary`,
    scope: "run",
    provider: "bremio",
    role: "orchestrator",
    kind: "run-summary",
    status: "completed",
    filesChanged: 0,
    flowMode: "single-agent",
    comparisonId,
    outcomeVerified: true,
  });
  const multiRunId = `${comparisonId}-historical-team`;
  await appendLedgerEntry(ledgerPath, {
    ts: "2026-07-22T00:00:00.000Z",
    runId: multiRunId,
    taskId: `${multiRunId}::task`,
    scope: "task",
    provider: "codex",
    role: "implementer",
    kind: "implementation",
    status: "completed",
    filesChanged: 1,
    actualModel: "codex-measured",
    usage: { costUsd: 0.5 },
  });
  await appendLedgerEntry(ledgerPath, {
    ts: "2026-07-22T00:00:00.000Z",
    runId: multiRunId,
    taskId: `${multiRunId}::lead`,
    scope: "coordination",
    provider: "claude",
    role: "planner",
    kind: "planning",
    status: "completed",
    filesChanged: 0,
    actualModel: "claude-measured",
    usage: { costUsd: 0.1 },
  });
  await appendLedgerEntry(ledgerPath, {
    ts: "2026-07-22T00:00:00.000Z",
    runId: multiRunId,
    taskId: `${multiRunId}::summary`,
    scope: "run",
    provider: "bremio",
    role: "orchestrator",
    kind: "run-summary",
    status: "completed",
    filesChanged: 0,
    flowMode: "multi-agent",
    comparisonId,
    qualityGatePassed: true,
    outcomeVerified: true,
  });
}

function configWithThreshold(maxOrchestrationCostShare: number): RoutingConfig {
  return {
    ...getDefaultRoutingConfig(),
    efficiency: { maxOrchestrationCostShare },
  };
}

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}
