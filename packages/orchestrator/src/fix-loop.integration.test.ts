import { execFileSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AdapterRuntimeCapabilities,
  AgentAdapter,
  AgentCapabilities,
  AgentRunRequest,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import type { BremioRunReport, RunReport } from "./aggregator";
import { fixLoopPolicyBlock, fixLoopStopReason } from "./fix-loop";
import { ledgerPathFor, readLedger } from "./ledger";
import { createRegistry } from "./registry";
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

abstract class Base implements AgentAdapter {
  abstract readonly id: string;
  readonly provider = "test";
  async getCapabilities() { return CAPS; }
  async listModels() { return []; }
  async healthCheck() { return { status: "ok" as const }; }
  abstract startRun(req: AgentRunRequest): AsyncIterable<AgentEvent>;
  resumeRun(): AsyncIterable<AgentEvent> { throw new Error("no resume"); }
  async cancelRun() {}
  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id, transport: "cli", approval: "none", structuredToolEvents: true,
      contextMetrics: "none", manualCompact: false, mcp: false, webSearch: false, cancellation: true,
    };
  }
}

/** Plans IMPL → TEST, IMPL → REVIEW and performs the independent review. */
class Lead extends Base {
  readonly id = "claude";
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    if (req.prompt.includes("PLAN RULES")) {
      const plan = {
        summary: "Set VALUE to good",
        leadAgentId: "claude",
        tasks: [
          { id: "IMPL", title: "Write VALUE", kind: "implementation", risk: "low", requiredCapabilities: ["repository.write"], acceptanceCriteria: ["VALUE is good"] },
          { id: "TEST", title: "Verify VALUE", kind: "test", risk: "low", dependencies: ["IMPL"], requiredCapabilities: ["shell", "test"] },
          { id: "REVIEW", title: "Review VALUE", kind: "review", risk: "low", dependencies: ["IMPL"], requiredCapabilities: ["repository.read", "review"] },
        ],
      };
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: JSON.stringify(plan) } };
      return;
    }
    // reviewer: never blocks, so the gate hinges on the test command
    const review = { summary: "looks fine", findings: [] };
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", structured: review, finalText: JSON.stringify(review) } };
  }
}

/** Implements (bad first, good once it sees fix evidence) and runs the test. */
class Worker extends Base {
  readonly id = "codex";
  readonly prompts: string[] = [];
  constructor(private readonly behaviour: { fixes: boolean; implFails?: boolean }) { super(); }
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    this.prompts.push(req.prompt);
    const file = path.join(req.cwd, "VALUE");
    if (req.role === "tester") {
      const ok = existsSync(file) && readFileSync(file, "utf8").trim() === "good";
      yield { type: "tool_use", runId: req.runId, ts, name: "shell", input: { command: "check-value" } };
      yield { type: "tool_result", runId: req.runId, ts, name: "shell", ok, exitCode: ok ? 0 : 1 };
      yield { type: "usage", runId: req.runId, ts, costUsd: 0.01 };
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed" } };
      return;
    }
    if (this.behaviour.implFails) {
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "failed", error: "401 not logged in" } };
      return;
    }
    const isFix = req.prompt.includes("FAILURE EVIDENCE");
    await fs.writeFile(file, isFix && this.behaviour.fixes ? "good\n" : "bad\n");
    yield { type: "usage", runId: req.runId, ts, costUsd: 0.02 };
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: "wrote VALUE" } };
  }
}

const repos: string[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

async function freshRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-fix-"));
  repos.push(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "# fix loop\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}

function team(report: BremioRunReport): RunReport {
  expect(report.mode).toBe("team");
  return report as RunReport;
}

describe("P2-T3 Team fix loop (mock adapters, real git)", () => {
  it("turns a failed gate green with one fix iteration on top of the failing branch", async () => {
    const repo = await freshRepo();
    const worker = new Worker({ fixes: true });
    const report = team(await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "set value",
      registry: createRegistry([new Lead(), worker]),
      maxFixIterations: 2,
    }));

    expect(report.qualityGate.status).toBe("passed");
    expect(report.fixLoop?.status).toBe("passed");
    expect(report.fixLoop?.iterations).toHaveLength(1);
    expect(report.fixLoop?.superseded).toEqual(["TEST"]);
    expect(report.fixLoop?.iterations[0]?.reasonsBefore.join("\n")).toMatch(/TEST/);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.superseded).toBe(1);
    // P2-T6: the lead's criterion is evidenced by the fix chain's checks
    expect(report.definitionOfDone?.status).toBe("met");
    expect(report.definitionOfDone?.criteria.find((c) => c.taskId === "IMPL")?.evidence)
      .toEqual(expect.arrayContaining(["FIX-1-TEST: `check-value` exit 0"]));

    // the original failure stays visible; nothing completed was re-run
    const byId = new Map(report.tasks.map((t) => [t.task.id, t] as const));
    expect(byId.get("TEST")?.result.status).toBe("failed");
    expect(byId.get("TEST")?.result.errorCode).toBe("verification_failed");
    expect(worker.prompts.filter((p) => p.includes("YOUR TASK (IMPL "))).toHaveLength(1);

    const fix = byId.get("FIX-1");
    expect(fix?.task.dependencies).toEqual(["IMPL"]);
    expect(fix?.result.status).toBe("completed");
    expect(byId.get("FIX-1-TEST")?.result.status).toBe("completed");
    expect(byId.get("FIX-1-REVIEW")?.agentId).toBe("claude");

    // the fixer saw the failure evidence, including the failing command
    const fixPrompt = worker.prompts.find((p) => p.includes("FAILURE EVIDENCE"));
    expect(fixPrompt).toMatch(/check-value \(exit 1\)/);

    // the fix branch descends from the implementation branch
    const show = execFileSync("git", ["show", `${fix!.result.branch}:VALUE`], { cwd: repo, encoding: "utf8" });
    expect(show.trim()).toBe("good");

    // every fix task is in the ledger
    const ledger = await readLedger(ledgerPathFor(repo));
    const taskIds = ledger.filter((e) => e.scope === "task").map((e) => e.taskId);
    expect(taskIds).toEqual(expect.arrayContaining(["FIX-1", "FIX-1-TEST", "FIX-1-REVIEW"]));
    const summary = ledger.find((e) => e.scope === "run" && e.runId === report.runId);
    expect(summary?.qualityGatePassed).toBe(true);
  });

  it("stops with a named reason after maxFixIterations", async () => {
    const repo = await freshRepo();
    const report = team(await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "set value",
      registry: createRegistry([new Lead(), new Worker({ fixes: false })]),
      maxFixIterations: 2,
    }));
    expect(report.qualityGate.status).toBe("failed");
    expect(report.fixLoop?.status).toBe("exhausted");
    expect(report.fixLoop?.reason).toMatch(/maxFixIterations \(2\)/);
    expect(report.fixLoop?.iterations.map((it) => it.taskIds[0])).toEqual(["FIX-1", "FIX-2"]);
    // iteration 2 builds on iteration 1's fix, not on the original branch
    const fix2 = report.tasks.find((t) => t.task.id === "FIX-2");
    expect(fix2?.task.dependencies).toEqual(["FIX-1"]);
  });

  it("maxFixIterations 0 leaves the run exactly as before", async () => {
    const repo = await freshRepo();
    const worker = new Worker({ fixes: true });
    const report = team(await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "set value",
      registry: createRegistry([new Lead(), worker]),
      maxFixIterations: 0,
    }));
    expect(report.tasks.map((t) => t.task.id)).toEqual(["IMPL", "TEST", "REVIEW"]);
    expect(report.plan.tasks).toHaveLength(3);
    expect(report.fixLoop).toBeUndefined();
    expect(report.qualityGate.status).toBe("failed");
    expect(worker.prompts.some((p) => p.includes("FAILURE EVIDENCE"))).toBe(false);
  });

  it("does not try to fix a provider failure", async () => {
    const repo = await freshRepo();
    const report = team(await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "set value",
      registry: createRegistry([new Lead(), new Worker({ fixes: true, implFails: true })]),
      maxFixIterations: 2,
    }));
    expect(report.fixLoop?.status).toBe("not-fixable");
    expect(report.fixLoop?.reason).toMatch(/IMPL failed \(authentication_failed\)/);
    expect(report.tasks.some((t) => t.task.id.startsWith("FIX-"))).toBe(false);
  });
});

describe("P2-T3 fix loop bounds", () => {
  it("plan mode never runs fix iterations", () => {
    expect(fixLoopPolicyBlock("plan")).toMatch(/plan mode/);
    expect(fixLoopPolicyBlock("autopilot")).toBeUndefined();
    expect(fixLoopPolicyBlock("approve")).toBeUndefined(); // before-apply: the merge is the apply
  });

  it("a cost budget that cannot be measured stops the loop", () => {
    const base = { maxIterations: 5, maxCostUsd: 1, controlMode: "autopilot" as const };
    const it1 = { iteration: 1, addresses: [], basedOn: [], taskIds: [], reasonsBefore: [], gateAfter: { status: "failed" as const, testTaskIds: [], reviewTaskIds: [], reasons: [] } };
    expect(fixLoopStopReason(base, [it1])?.reason).toMatch(/not provider-reported/);
    expect(fixLoopStopReason(base, [{ ...it1, costUsd: 1.5 }])?.reason).toMatch(/budget exhausted/);
    expect(fixLoopStopReason(base, [{ ...it1, costUsd: 0.5 }])).toBeUndefined();
    expect(fixLoopStopReason({ ...base, stopRequested: () => true }, [])?.status).toBe("stopped");
  });
});
