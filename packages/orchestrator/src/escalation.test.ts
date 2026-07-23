import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
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
import { ledgerPathFor, readLedger } from "./ledger";
import { createRegistry } from "./registry";
import { runBremio } from "./run";
import { runSingleAgent, shouldEscalate } from "./single-run";

const FULL_CAPABILITIES: AgentCapabilities = {
  planning: true,
  structuredOutput: true,
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: true,
  browser: false,
  vision: false,
  resumableSessions: true,
};

abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: string;
  readonly requests: AgentRunRequest[] = [];

  async getCapabilities(): Promise<AgentCapabilities> {
    return FULL_CAPABILITIES;
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

class VerifyingSingle extends BaseAdapter {
  readonly id = "single-agent";
  readonly provider = "test";
  private failVerification: boolean;

  constructor(failVerification = true) {
    super();
    this.failVerification = failVerification;
  }

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    const ts = Date.now();
    yield { type: "started", runId: request.runId, ts };
    yield {
      type: "tool_use",
      runId: request.runId,
      ts,
      name: "shell",
      input: { command: "pnpm test" },
    };
    yield {
      type: "tool_result",
      runId: request.runId,
      ts,
      name: "shell",
      ok: !this.failVerification,
      exitCode: this.failVerification ? 1 : 0,
    };
    yield {
      type: "usage",
      runId: request.runId,
      ts: Date.now(),
      model: "mock-model",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02,
    };
    yield {
      type: "completed",
      runId: request.runId,
      ts: Date.now(),
      outcome: { status: "completed", finalText: "Single run output." },
    };
  }
}

class EscalationLead extends BaseAdapter {
  readonly id = "claude";
  readonly provider = "anthropic";

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    yield { type: "started", runId: request.runId, ts: Date.now() };
    const plan = {
      summary: "Fix verification failure",
      leadAgentId: "claude",
      tasks: [
        { id: "TASK-001", title: "Fix issue", kind: "implementation", risk: "low" },
        { id: "TASK-002", title: "Verify fix", kind: "test", risk: "low", dependencies: ["TASK-001"] },
      ],
    };
    yield {
      type: "usage",
      runId: request.runId,
      ts: Date.now(),
      model: "mock-model",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.05,
    };
    yield {
      type: "completed",
      runId: request.runId,
      ts: Date.now(),
      outcome: { status: "completed", finalText: JSON.stringify(plan) },
    };
  }
}

class EscalationWorker extends BaseAdapter {
  readonly id = "codex";
  readonly provider = "openai";

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    const ts = Date.now();
    yield { type: "started", runId: request.runId, ts };
    if (request.role === "tester") {
      yield {
        type: "tool_use",
        runId: request.runId,
        ts,
        name: "shell",
        input: { command: "pnpm test" },
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
    yield {
      type: "usage",
      runId: request.runId,
      ts: Date.now(),
      model: "mock-model",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.15,
    };
    yield {
      type: "completed",
      runId: request.runId,
      ts: Date.now(),
      outcome: { status: "completed", finalText: "Worker completed." },
    };
  }
}

let repoPath: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, stdio: "pipe" }).toString().trim();
}

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-escalation-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  git(["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(repoPath, "README.md"), "# escalation fixture\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
});

describe("shouldEscalate", () => {
  it("returns false for a passing Single run", () => {
    const report = {
      mode: "single" as const,
      runId: "run-pass",
      createdAt: new Date().toISOString(),
      prompt: "test",
      primaryAgentId: "claude",
      repoPath,
      runDir: "/tmp",
      result: {
        status: "completed" as const,
        summary: "ok",
        filesChanged: [],
        commandsExecuted: [],
        tests: [],
        logsPath: "/tmp/log",
        durationMs: 100,
      },
      verification: { status: "passed" as const, reasons: [] },
      workspace: { dirtyBefore: [], dirtyAfter: [] },
    };
    expect(shouldEscalate(report)).toBe(false);
  });

  it("returns true for a completed run with failed verification", () => {
    const report = {
      mode: "single" as const,
      runId: "run-fail",
      createdAt: new Date().toISOString(),
      prompt: "test",
      primaryAgentId: "claude",
      repoPath,
      runDir: "/tmp",
      result: {
        status: "completed" as const,
        summary: "done",
        filesChanged: [],
        commandsExecuted: [],
        tests: [{ command: "pnpm test", exitCode: 1 }],
        logsPath: "/tmp/log",
        durationMs: 100,
      },
      verification: { status: "failed" as const, reasons: ["verification command exited 1: pnpm test"] },
      workspace: { dirtyBefore: [], dirtyAfter: [] },
    };
    expect(shouldEscalate(report)).toBe(true);
  });

  it("returns false when the run itself did not complete", () => {
    const report = {
      mode: "single" as const,
      runId: "run-crashed",
      createdAt: new Date().toISOString(),
      prompt: "test",
      primaryAgentId: "claude",
      repoPath,
      runDir: "/tmp",
      result: {
        status: "failed" as const,
        summary: "crashed",
        filesChanged: [],
        commandsExecuted: [],
        tests: [],
        logsPath: "/tmp/log",
        durationMs: 50,
        error: "agent failed",
      },
      verification: { status: "failed" as const, reasons: ["agent run failed"] },
      workspace: { dirtyBefore: [], dirtyAfter: [] },
    };
    expect(shouldEscalate(report)).toBe(false);
  });
});

describe("escalation integration", () => {
  it("no approval — Single run with failed verification does not escalate (non-interactive, no --escalate)", async () => {
    const agent = new VerifyingSingle(true);
    const report = await runSingleAgent({
      primaryAgentId: "single-agent",
      repoPath,
      prompt: "add a failing test",
      registry: createRegistry([agent]),
    });

    expect(report.verification.status).toBe("failed");
    expect(shouldEscalate(report)).toBe(true);
    // Without approval, the caller does NOT call runBremio.
    // The single report and its artifacts are the only result.
    expect(existsSync(path.join(repoPath, ".bremio", "runs", report.runId, "report.json"))).toBe(true);
  }, 15_000);

  it("approval — Team run shares the comparison id with the original Single run", async () => {
    const singleAgent = new VerifyingSingle(true);
    const lead = new EscalationLead();
    const worker = new EscalationWorker();
    const registry = createRegistry([singleAgent, lead, worker]);
    const comparisonId = `esc-test-${Date.now()}`;

    const report = await runSingleAgent({
      primaryAgentId: "single-agent",
      repoPath,
      prompt: "fix the build",
      registry,
      comparisonId,
    });

    expect(report.verification.status).toBe("failed");

    // Approve escalation: run Team with the same comparisonId
    const teamReport = await runBremio({
      leadId: "claude",
      workerId: "codex",
      repoPath,
      prompt: "fix the build",
      registry,
      comparisonId,
    });

    expect(teamReport.mode).toBe("team" as const);
    // Both attempts used the same comparisonId
    const entries = (await readLedger(ledgerPathFor(repoPath)))
      .filter((e) => e.comparisonId === comparisonId && e.scope === "run");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const flowModes = [...new Set(entries.map((e) => e.flowMode))].sort();
    expect(flowModes).toEqual(["multi-agent", "single-agent"]);
  }, 30_000);

  it("both attempts' costs are recorded in one comparison group", async () => {
    const singleAgent = new VerifyingSingle(true);
    const lead = new EscalationLead();
    const worker = new EscalationWorker();
    const registry = createRegistry([singleAgent, lead, worker]);
    const comparisonId = `esc-cost-${Date.now()}`;

    await runSingleAgent({
      primaryAgentId: "single-agent",
      repoPath,
      prompt: "fix the tests",
      registry,
      comparisonId,
    });

    await runBremio({
      leadId: "claude",
      workerId: "codex",
      repoPath,
      prompt: "fix the tests",
      registry,
      comparisonId,
    });

    const allEntries = await readLedger(ledgerPathFor(repoPath));
    const groupEntries = allEntries.filter((e) => e.comparisonId === comparisonId);

    const singleEntries = groupEntries.filter((e) => e.flowMode === "single-agent");
    const multiEntries = groupEntries.filter((e) => e.flowMode === "multi-agent");

    expect(singleEntries.length).toBeGreaterThanOrEqual(1);
    expect(multiEntries.length).toBeGreaterThanOrEqual(1);

    const allHaveCost = groupEntries
      .filter((e) => e.scope !== "run")
      .every((e) => e.usage?.costUsd !== undefined);
    expect(allHaveCost).toBe(true);
  }, 30_000);

  it("a passing Single run is never offered escalation", () => {
    const report = {
      mode: "single" as const,
      runId: "run-pass-2",
      createdAt: new Date().toISOString(),
      prompt: "add a passing test",
      primaryAgentId: "claude",
      repoPath,
      runDir: "/tmp",
      result: {
        status: "completed" as const,
        summary: "all good",
        filesChanged: [],
        commandsExecuted: [],
        tests: [{ command: "pnpm test", exitCode: 0 }],
        logsPath: "/tmp/log",
        durationMs: 100,
      },
      verification: { status: "passed" as const, reasons: [] },
      workspace: { dirtyBefore: [], dirtyAfter: [] },
    };
    expect(shouldEscalate(report)).toBe(false);
  });
});
