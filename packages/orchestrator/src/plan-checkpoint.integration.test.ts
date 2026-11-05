import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterRuntimeCapabilities, AgentAdapter, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent, Plan } from "@bremio/protocol";
import type { RunReport } from "./aggregator";
import { ledgerPathFor, readLedger } from "./ledger";
import { PlanCheckpointError, planDigest } from "./plan-checkpoint";
import { createRegistry } from "./registry";
import { runBremio } from "./run";

abstract class Base implements AgentAdapter {
  abstract readonly id: string;
  readonly provider = "test";
  readonly prompts: string[] = [];
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

const PLAN: Plan = {
  summary: "Write A",
  leadAgentId: "claude",
  tasks: [
    { id: "IMPL", title: "Write A", kind: "implementation", risk: "low", requiredCapabilities: ["repository.write"], preferredAgents: [], dependencies: [], expectedArtifacts: [], acceptanceCriteria: [] },
    { id: "TEST", title: "Check A", kind: "test", risk: "low", requiredCapabilities: ["shell", "test"], preferredAgents: [], dependencies: ["IMPL"], expectedArtifacts: [], acceptanceCriteria: [] },
    { id: "REVIEW", title: "Review A", kind: "review", risk: "low", requiredCapabilities: ["repository.read", "review"], preferredAgents: [], dependencies: ["IMPL"], expectedArtifacts: [], acceptanceCriteria: [] },
  ],
};

class Lead extends Base {
  readonly id = "claude";
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.prompts.push(req.prompt);
    const ts = Date.now();
    if (req.prompt.includes("PLAN RULES")) {
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: JSON.stringify(PLAN) } };
      return;
    }
    const review = { summary: "ok", findings: [] };
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", structured: review } };
  }
}

class Worker extends Base {
  readonly id = "codex";
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.prompts.push(req.prompt);
    const ts = Date.now();
    if (req.role === "tester") {
      yield { type: "tool_use", runId: req.runId, ts, name: "shell", input: { command: "check" } };
      yield { type: "tool_result", runId: req.runId, ts, name: "shell", ok: true, exitCode: 0 };
    } else {
      await fs.writeFile(path.join(req.cwd, "A"), "a\n");
    }
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed" } };
  }
}

const repos: string[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

async function freshRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ckpt-"));
  repos.push(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "# ckpt\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  return repo;
}

function bremioBranches(repo: string): string[] {
  return execFileSync("git", ["branch", "--list", "bremio/*"], { cwd: repo, encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter(Boolean);
}

describe("P2-T2 plan checkpoint", () => {
  it("reject stops before any worktree, branch or worker run exists", async () => {
    const repo = await freshRepo();
    const worker = new Worker();
    let seen: { plan: Plan; digest: string } | undefined;
    const run = runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "write A",
      registry: createRegistry([new Lead(), worker]),
      onPlanReady: async (plan, ctx) => {
        seen = { plan, digest: ctx.digest };
        return { decision: "reject", reason: "not this plan", decidedBy: "tester" };
      },
    });
    await expect(run).rejects.toThrow(PlanCheckpointError);
    await expect(run).rejects.toThrow(/not this plan/);
    expect(seen?.plan.tasks.map((t) => t.id)).toEqual(["IMPL", "TEST", "REVIEW"]);
    expect(seen?.digest).toBe(planDigest(seen!.plan));
    expect(worker.prompts).toHaveLength(0);
    expect(bremioBranches(repo)).toEqual([]);
    expect(existsSync(path.join(repo, ".bremio", "worktrees"))).toBe(false);
    const ledger = await readLedger(ledgerPathFor(repo));
    expect(ledger.find((e) => e.scope === "run")?.status).toBe("cancelled");
  });

  it("an invalid edit is rejected by the same validator as the lead's plan", async () => {
    const repo = await freshRepo();
    const worker = new Worker();
    // dependency on a task that does not exist → semantic validation failure
    const broken = { ...PLAN, tasks: [{ ...PLAN.tasks[0]!, dependencies: ["GHOST"] }] };
    const run = runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "write A",
      registry: createRegistry([new Lead(), worker]),
      onPlanReady: async () => ({ decision: "edit", plan: broken }),
    });
    await expect(run).rejects.toMatchObject({ code: "plan_edit_invalid" });
    expect(worker.prompts).toHaveLength(0);
    expect(bremioBranches(repo)).toEqual([]);

    const shapeless = runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "write A",
      registry: createRegistry([new Lead(), worker]),
      onPlanReady: async () => ({ decision: "edit", plan: { tasks: "nope" } }),
    });
    await expect(shapeless).rejects.toMatchObject({ code: "plan_edit_invalid" });
  });

  it("a valid edit executes the edited plan and records both digests", async () => {
    const repo = await freshRepo();
    const worker = new Worker();
    const edited: Plan = {
      ...PLAN,
      tasks: PLAN.tasks.map((t) => t.id === "IMPL" ? { ...t, title: "Write A carefully" } : t),
    };
    const report = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "write A",
      registry: createRegistry([new Lead(), worker]),
      onPlanReady: async () => ({ decision: "edit", plan: edited, decidedBy: "tester" }),
    }) as RunReport;
    expect(report.plan.tasks[0]?.title).toBe("Write A carefully");
    expect(worker.prompts.some((p) => p.includes("Write A carefully"))).toBe(true);
    expect(report.planCheckpoint).toMatchObject({ decision: "edited", decidedBy: "tester" });
    expect(report.planCheckpoint?.executedDigest).not.toBe(report.planCheckpoint?.proposedDigest);
  });

  it("approve runs the lead's plan unchanged; no hook means no checkpoint", async () => {
    const repo = await freshRepo();
    const approved = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "write A",
      registry: createRegistry([new Lead(), new Worker()]),
      onPlanReady: async () => ({ decision: "approve" }),
    }) as RunReport;
    expect(approved.planCheckpoint?.decision).toBe("approved");
    expect(approved.qualityGate.status).toBe("passed");

    const unchecked = await runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "write A",
      registry: createRegistry([new Lead(), new Worker()]),
    }) as RunReport;
    expect(unchecked.planCheckpoint).toBeUndefined();
  });

  it("a hook that throws fails closed", async () => {
    const repo = await freshRepo();
    const worker = new Worker();
    const run = runBremio({
      leadId: "claude",
      repoPath: repo,
      prompt: "write A",
      registry: createRegistry([new Lead(), worker]),
      onPlanReady: async () => { throw new Error("prompt unavailable"); },
    });
    await expect(run).rejects.toThrow(/failed closed: prompt unavailable/);
    expect(worker.prompts).toHaveLength(0);
  });
});
