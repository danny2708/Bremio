import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterRuntimeCapabilities, AgentAdapter, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import type { RunReport } from "./aggregator";
import { createRegistry } from "./registry";
import { runBremio } from "./run";

abstract class Base implements AgentAdapter {
  abstract readonly id: string;
  readonly provider = "test";
  async getCapabilities() {
    return {
      planning: true, structuredOutput: true, repositoryRead: true, repositoryWrite: true,
      shell: true, testing: true, browser: false, vision: false, resumableSessions: false,
      readOnlyEnforcement: "provider-native" as const,
    };
  }
  async listModels() { return []; }
  async healthCheck() { return { status: "ok" as const }; }
  resumeRun(): AsyncIterable<AgentEvent> { throw new Error("no resume"); }
  async cancelRun() {}
  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id, transport: "cli", approval: "none", structuredToolEvents: true,
      contextMetrics: "none", manualCompact: false, mcp: false, webSearch: false, cancellation: true,
    };
  }
  abstract startRun(req: AgentRunRequest): AsyncIterable<AgentEvent>;
}

const ORIGINAL = {
  summary: "Ship C",
  leadAgentId: "claude",
  tasks: [
    { id: "ANALYSIS", title: "Look around", kind: "analysis", risk: "low", requiredCapabilities: ["repository.read"] },
    { id: "IMPL-B", title: "Approach B", kind: "implementation", risk: "low", dependencies: ["ANALYSIS"], requiredCapabilities: ["repository.write"] },
    { id: "TEST", title: "Check", kind: "test", risk: "low", dependencies: ["IMPL-B"], requiredCapabilities: ["shell", "test"] },
    { id: "REVIEW", title: "Review", kind: "review", risk: "low", dependencies: ["IMPL-B"], requiredCapabilities: ["repository.read", "review"] },
  ],
};

const REPLAN = {
  summary: "Ship C another way",
  leadAgentId: "claude",
  tasks: [
    { id: "IMPL-C", title: "Approach C", kind: "implementation", risk: "low", dependencies: ["ANALYSIS"], requiredCapabilities: ["repository.write"] },
    { id: "TEST-C", title: "Check C", kind: "test", risk: "low", dependencies: ["IMPL-C"], requiredCapabilities: ["shell", "test"] },
    { id: "REVIEW-C", title: "Review C", kind: "review", risk: "low", dependencies: ["IMPL-C"], requiredCapabilities: ["repository.read", "review"] },
  ],
};

class Lead extends Base {
  readonly id = "claude";
  readonly planningPrompts: string[] = [];
  constructor(private readonly replan: unknown = REPLAN) { super(); }
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    if (req.prompt.includes("PLAN RULES")) {
      this.planningPrompts.push(req.prompt);
      const plan = req.prompt.includes("--- RE-PLAN") ? this.replan : ORIGINAL;
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: JSON.stringify(plan) } };
      return;
    }
    if (req.role === "reviewer") {
      const review = { summary: "ok", findings: [] };
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", structured: review } };
      return;
    }
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: "analysed" } };
  }
}

class Worker extends Base {
  readonly id = "codex";
  readonly ran: string[] = [];
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    const taskId = req.runId.split("::")[0]!;
    this.ran.push(taskId);
    if (taskId === "IMPL-B") {
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "failed", error: "gave up: approach B is impossible" } };
      return;
    }
    if (req.role === "tester") {
      yield { type: "tool_use", runId: req.runId, ts, name: "shell", input: { command: "check" } };
      yield { type: "tool_result", runId: req.runId, ts, name: "shell", ok: true, exitCode: 0 };
    } else {
      await fs.writeFile(path.join(req.cwd, "C"), "c\n");
    }
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed" } };
  }
}

const repos: string[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

async function freshRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-replan-"));
  repos.push(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "# replan\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}

describe("P2-T5 re-plan on blocker", () => {
  it("re-plans only the remaining graph and never re-runs completed work", async () => {
    const repo = await freshRepo();
    const lead = new Lead();
    const worker = new Worker();
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "ship C",
      registry: createRegistry([lead, worker]),
      maxReplans: 1,
    }) as RunReport;

    expect(report.replan?.status).toBe("replanned");
    const record = report.replan!.replans[0]!;
    expect(record.blockers).toEqual([
      expect.objectContaining({ taskId: "IMPL-B", errorCode: "unknown" }),
    ]);
    expect(record.replaced.sort()).toEqual(["IMPL-B", "REVIEW", "TEST"]);
    expect(record.kept).toEqual(["ANALYSIS"]);
    expect(record.added).toEqual(["IMPL-C", "TEST-C", "REVIEW-C"]);

    // the lead was told what is done and what failed
    expect(lead.planningPrompts).toHaveLength(2);
    expect(lead.planningPrompts[1]).toMatch(/ANALYSIS \[analysis\] Look around/);
    expect(lead.planningPrompts[1]).toMatch(/IMPL-B \[unknown\] Approach B: gave up/);

    // ANALYSIS (run by the lead) ran once; IMPL-B was not retried
    expect(worker.ran.filter((id) => id === "IMPL-B")).toHaveLength(1);
    expect(worker.ran).toEqual(expect.arrayContaining(["IMPL-C", "TEST-C"]));

    expect(report.qualityGate.status).toBe("passed");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.superseded).toBe(3);
    expect(report.tasks.find((t) => t.task.id === "IMPL-B")?.result.status).toBe("failed");
  });

  it("maxReplans 0 (default) leaves the run as before", async () => {
    const repo = await freshRepo();
    const lead = new Lead();
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "ship C",
      registry: createRegistry([lead, new Worker()]),
    }) as RunReport;
    expect(report.replan).toBeUndefined();
    expect(lead.planningPrompts).toHaveLength(1);
    expect(report.qualityGate.status).toBe("failed");
  });

  it("a re-plan that reuses an id is refused, with a named reason", async () => {
    const repo = await freshRepo();
    const reusing = { ...REPLAN, tasks: [{ ...REPLAN.tasks[0]!, id: "IMPL-B" }] };
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "ship C",
      registry: createRegistry([new Lead(reusing), new Worker()]),
      maxReplans: 1,
    }) as RunReport;
    expect(report.replan?.status).toBe("stopped");
    expect(report.replan?.reason).toMatch(/task id IMPL-B is already used/);
    expect(report.qualityGate.status).toBe("failed");
  });
});
