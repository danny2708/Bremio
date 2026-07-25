import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterRuntimeCapabilities,
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import {
  createRegistry,
  ledgerPathFor,
  readLedger,
} from "@bremio/orchestrator";
import { collectComparison, printComparison } from "./compare";

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
  readOnlyEnforcement: "provider-native",
};

abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly provider: string;
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

  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id,
      transport: "cli",
      approval: "none",
      structuredToolEvents: false,
      contextMetrics: "estimated",
      manualCompact: false,
      mcp: false,
      webSearch: false,
      cancellation: false,
    };
  }
}

class ComparisonLead extends BaseAdapter {
  readonly id = "claude";
  readonly provider = "anthropic";
  private singleStartedResolve: (() => void) | undefined;
  readonly singleStarted = new Promise<void>((resolve) => {
    this.singleStartedResolve = resolve;
  });

  constructor(private readonly slowSingle = false) {
    super();
  }

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    const ts = Date.now();
    yield { type: "started", runId: request.runId, ts };

    if (request.metadata?.executionMode === "single") {
      this.singleStartedResolve?.();
      if (this.slowSingle) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "completed",
          runId: request.runId,
          ts: Date.now(),
          outcome: { status: "cancelled" },
        };
        return;
      }
      await fs.writeFile(path.join(request.cwd, "DIRECT.txt"), "single baseline\n", "utf8");
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
      yield usage(request.runId, 1);
      yield completed(request.runId, "Single baseline completed.");
      return;
    }

    if (request.prompt.includes("PLAN RULES")) {
      const plan = {
        summary: "Add and verify a greeting",
        leadAgentId: "claude",
        tasks: [
          { id: "TASK-001", title: "Analyze", kind: "analysis", risk: "low" },
          {
            id: "TASK-002",
            title: "Implement greeting",
            kind: "implementation",
            risk: "low",
            dependencies: ["TASK-001"],
            requiredCapabilities: ["repository.write"],
          },
          {
            id: "TASK-003",
            title: "Test greeting",
            kind: "test",
            risk: "low",
            dependencies: ["TASK-002"],
            requiredCapabilities: ["shell", "test"],
          },
          {
            id: "TASK-004",
            title: "Review greeting",
            kind: "review",
            risk: "low",
            dependencies: ["TASK-003"],
            requiredCapabilities: ["repository.read", "review"],
          },
        ],
      };
      yield usage(request.runId, 0.1);
      yield {
        type: "completed",
        runId: request.runId,
        ts: Date.now(),
        outcome: { status: "completed", finalText: JSON.stringify(plan) },
      };
      return;
    }

    if (request.role === "reviewer") {
      const review = { summary: "Review passed.", findings: [] };
      yield usage(request.runId, 0.05);
      yield {
        type: "completed",
        runId: request.runId,
        ts: Date.now(),
        outcome: {
          status: "completed",
          finalText: JSON.stringify(review),
          structured: review,
        },
      };
      return;
    }

    yield usage(request.runId, 0.05);
    yield completed(request.runId, "Analysis completed.");
  }
}

class ComparisonWorker extends BaseAdapter {
  readonly id = "codex";
  readonly provider = "openai";

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    const ts = Date.now();
    yield { type: "started", runId: request.runId, ts };
    if (request.role === "tester") {
      const ok = existsSync(path.join(request.cwd, "GREETING.txt"));
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
        ok,
        exitCode: ok ? 0 : 1,
      };
    } else {
      await fs.writeFile(path.join(request.cwd, "GREETING.txt"), "hello\n", "utf8");
    }
    yield usage(request.runId, 0.15);
    yield completed(request.runId, "Worker task completed.");
  }
}

function usage(runId: string, costUsd: number): AgentEvent {
  return {
    type: "usage",
    runId,
    ts: Date.now(),
    model: "mock-model",
    inputTokens: 10,
    outputTokens: 5,
    costUsd,
  };
}

function completed(runId: string, finalText: string): AgentEvent {
  return {
    type: "completed",
    runId,
    ts: Date.now(),
    outcome: { status: "completed", finalText },
  };
}

let repoPath: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, stdio: "pipe" }).toString().trim();
}

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-compare-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  git(["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(repoPath, "README.md"), "# comparison fixture\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
});

describe("collectComparison", () => {
  it("records both objective run summaries under one generated comparison id", async () => {
    const result = await collectComparison({
      repoPath,
      prompt: "add a greeting",
      registry: createRegistry([new ComparisonLead(), new ComparisonWorker()]),
      singleAgentId: "claude",
      teamLeadId: "claude",
      teamWorkerId: "codex",
    });

    const summaries = (await readLedger(ledgerPathFor(repoPath)))
      .filter((entry) => entry.scope === "run" && entry.comparisonId === result.comparisonId);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((entry) => entry.flowMode).sort())
      .toEqual(["multi-agent", "single-agent"]);
    expect(summaries.every((entry) => entry.outcomeVerified === true)).toBe(true);
    expect(result.netGain.status).toBe("known");
    expect(existsSync(path.join(repoPath, "DIRECT.txt"))).toBe(false);
    expect(git(["status", "--porcelain"])).toBe("");

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => output.push(String(line)));
    printComparison(result);
    expect(output.join("\n")).toContain("Single (claude)");
    expect(output.join("\n")).toContain("Team (claude lead)");
    expect(output.join("\n")).toMatch(/net gain: \$-?\d+\.\d{4}/);
  }, 30_000);

  it("refuses a dirty tree before either flow starts", async () => {
    const lead = new ComparisonLead();
    const worker = new ComparisonWorker();
    await fs.writeFile(path.join(repoPath, "DIRTY.txt"), "not controlled\n", "utf8");

    await expect(collectComparison({
      repoPath,
      prompt: "must not run",
      registry: createRegistry([lead, worker]),
      singleAgentId: "claude",
      teamLeadId: "claude",
      teamWorkerId: "codex",
    })).rejects.toThrow(/requires a clean working tree.*DIRTY\.txt/);

    expect(lead.requests).toHaveLength(0);
    expect(worker.requests).toHaveLength(0);
    expect(existsSync(path.join(repoPath, ".bremio"))).toBe(false);
  });

  it("keeps both ledger summaries coherent when the first side is cancelled", async () => {
    const lead = new ComparisonLead(true);
    const controller = new AbortController();
    const pending = collectComparison({
      repoPath,
      prompt: "cancel only the baseline",
      registry: createRegistry([lead, new ComparisonWorker()]),
      singleAgentId: "claude",
      teamLeadId: "claude",
      teamWorkerId: "codex",
      singleSignal: controller.signal,
    });
    await lead.singleStarted;
    controller.abort();
    const result = await pending;

    expect(result.single.result.status).toBe("cancelled");
    expect(result.team.qualityGate.status).toBe("passed");
    expect(result.netGain).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("single-agent baseline"),
    });
    const summaries = (await readLedger(ledgerPathFor(repoPath)))
      .filter((entry) => entry.scope === "run" && entry.comparisonId === result.comparisonId);
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        flowMode: "single-agent",
        status: "cancelled",
        outcomeVerified: false,
      }),
      expect.objectContaining({
        flowMode: "multi-agent",
        status: "completed",
        outcomeVerified: true,
      }),
    ]));
  }, 30_000);
});
