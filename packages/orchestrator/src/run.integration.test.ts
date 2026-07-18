import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
  QuotaSnapshot,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { createRegistry } from "./registry";
import { runBremio } from "./run";

const FULL_CAPS: AgentCapabilities = {
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

/** Shared no-op adapter surface; each mock overrides id/provider/startRun. */
abstract class BaseMock implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly provider: string;
  async getCapabilities(): Promise<AgentCapabilities> {
    return FULL_CAPS;
  }
  async getQuota(): Promise<QuotaSnapshot> {
    return { status: "unknown" };
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
  async healthCheck(): Promise<AgentHealth> {
    return { status: "ok" };
  }
  abstract startRun(req: AgentRunRequest): AsyncIterable<AgentEvent>;
  resumeRun(): AsyncIterable<AgentEvent> {
    throw new Error("not implemented");
  }
  async cancelRun(): Promise<void> {}
}

/** Lead: plans implementation + quality gates, analyzes, and independently reviews. */
class MockLead extends BaseMock {
  readonly id = "claude";
  readonly provider = "anthropic";
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    yield { type: "started", runId: req.runId, ts };
    if (req.prompt.includes("PLAN RULES")) {
      yield { type: "tool_use", runId: req.runId, ts, name: "Read", input: { file_path: "README.md" } };
      const plan = {
        summary: "Add a GREETING file",
        leadAgentId: "claude",
        tasks: [
          { id: "TASK-001", title: "Analyze the repo", kind: "analysis", risk: "low" },
          {
            id: "TASK-002",
            title: "Create GREETING.txt",
            kind: "implementation",
            risk: "low",
            dependencies: ["TASK-001"],
            requiredCapabilities: ["repository.write"],
          },
          {
            id: "TASK-003",
            title: "Verify GREETING.txt",
            kind: "test",
            risk: "low",
            dependencies: ["TASK-002"],
            requiredCapabilities: ["shell", "test"],
          },
          {
            id: "TASK-004",
            title: "Independently review GREETING.txt",
            kind: "review",
            risk: "low",
            dependencies: ["TASK-003"],
            requiredCapabilities: ["repository.read", "review"],
          },
        ],
      };
      yield {
        type: "completed",
        runId: req.runId,
        ts,
        outcome: { status: "completed", finalText: JSON.stringify(plan) },
      };
    } else if (req.role === "reviewer") {
      const implementationPresent = existsSync(path.join(req.cwd, "GREETING.txt"));
      const review = {
        summary: implementationPresent ? "Independent review passed." : "Implementation missing.",
        findings: implementationPresent
          ? []
          : [{ severity: "blocker", message: "GREETING.txt is missing", status: "open" }],
      };
      yield {
        type: "completed",
        runId: req.runId,
        ts,
        outcome: { status: "completed", finalText: JSON.stringify(review), structured: review },
      };
    } else {
      yield { type: "message", runId: req.runId, ts, role: "assistant", text: "Analysis: looks fine." };
      yield {
        type: "completed",
        runId: req.runId,
        ts,
        outcome: { status: "completed", finalText: "Analysis complete." },
      };
    }
  }
}

/** Worker: writes the implementation or executes the read-only test gate. */
class MockWorker extends BaseMock {
  readonly id = "codex";
  readonly provider = "openai";
  constructor(private readonly delayMs = 0) {
    super();
  }
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    yield { type: "started", runId: req.runId, ts };
    if (req.role === "tester") {
      const command = "node -e verify-GREETING";
      const ok = existsSync(path.join(req.cwd, "GREETING.txt"));
      yield { type: "tool_use", runId: req.runId, ts, name: "shell", input: { command } };
      yield { type: "tool_result", runId: req.runId, ts, name: "shell", ok, exitCode: ok ? 0 : 1 };
    } else {
      yield { type: "tool_use", runId: req.runId, ts, name: "shell", input: { command: "echo hi" } };
      await fs.writeFile(path.join(req.cwd, "GREETING.txt"), "hello from codex\n");
    }
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) return resolve();
        const t = setTimeout(resolve, this.delayMs);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
    const cancelled = req.signal?.aborted === true;
    yield {
      type: "completed",
      runId: req.runId,
      ts: Date.now(),
        outcome: {
          status: cancelled ? "cancelled" : "completed",
          finalText: req.role === "tester" ? "Verified GREETING.txt" : "Created GREETING.txt",
        },
    };
  }
}

let repo: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-it-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "# Test repo\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe("runBremio end-to-end (mock adapters)", () => {
  it("plans, delegates to a different agent, edits code in a worktree, and aggregates", async () => {
    const registry = createRegistry([new MockLead(), new MockWorker()]);
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "add a greeting",
      registry,
    });

    // one prompt -> valid plan -> implementation + test + independent review
    expect(report.tasks).toHaveLength(4);

    // ≥1 task handed to a DIFFERENT agent than the lead
    const impl = report.tasks.find((t) => t.task.id === "TASK-002");
    expect(impl?.agentId).toBe("codex");
    expect(impl?.agentId).not.toBe(report.leadAgentId);

    // that agent edited code in its own worktree, and the diff was captured + committed
    expect(impl?.result.status).toBe("completed");
    expect(impl?.result.filesChanged).toContain("GREETING.txt");
    expect(impl?.result.commitHash).toBeTruthy();
    expect(impl?.result.branch).toBe("bremio/TASK-002-codex");
    expect(existsSync(impl?.result.worktreePath ?? "")).toBe(true);

    // analysis stayed on the lead (single-agent path within the same run)
    const analysis = report.tasks.find((t) => t.task.id === "TASK-001");
    expect(analysis?.agentId).toBe("claude");

    // logs exist for debugging; report.json written
    expect(existsSync(impl?.result.logsPath ?? "")).toBe(true);
    expect(existsSync(path.join(report.runDir, "report.json"))).toBe(true);

    // dependent gates inherit the implementation branch instead of testing HEAD
    const test = report.tasks.find((t) => t.task.id === "TASK-003");
    expect(test?.result.status).toBe("completed");
    expect(test?.result.tests.at(-1)?.exitCode).toBe(0);
    expect(existsSync(path.join(test?.result.worktreePath ?? "", "GREETING.txt"))).toBe(true);

    const review = report.tasks.find((t) => t.task.id === "TASK-004");
    expect(review?.agentId).toBe("claude");
    expect(review?.agentId).not.toBe(impl?.agentId);
    expect(review?.result.status).toBe("completed");
    expect(report.qualityGate.status).toBe("passed");

    expect(report.summary.completed).toBe(4);
    expect(report.summary.filesChanged).toBe(1);
  });

  it("cancels an in-flight task", async () => {
    const registry = createRegistry([new MockLead(), new MockWorker(2000)]);
    const ac = new AbortController();
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "add a greeting slowly",
      registry,
      signal: ac.signal,
      hooks: {
        onTaskStart: (task) => {
          if (task.kind === "implementation") setTimeout(() => ac.abort(), 50);
        },
      },
    });

    const impl = report.tasks.find((t) => t.task.id === "TASK-002");
    expect(impl?.result.status).toBe("cancelled");
    expect(report.summary.cancelled).toBeGreaterThanOrEqual(1);
  });

  it("times out an in-flight task and blocks its dependent quality gates", async () => {
    const registry = createRegistry([new MockLead(), new MockWorker(2000)]);
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "add a greeting with a short deadline",
      registry,
      taskTimeoutMs: 50,
    });

    const impl = report.tasks.find((t) => t.task.id === "TASK-002");
    expect(impl?.result.status).toBe("cancelled");
    expect(impl?.result.error).toMatch(/timed out after 50ms/);
    expect(report.tasks.find((t) => t.task.id === "TASK-003")?.result.error).toMatch(
      /blocked by unsuccessful dependencies/,
    );
    expect(report.qualityGate.status).toBe("failed");
  });
});
