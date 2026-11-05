import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterRuntimeCapabilities, AgentAdapter, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { RunRegistry, type RunEvent } from "./runs";
import { RunStore, isTerminal, type PersistedRun } from "./storage";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
});

/** Plans one implementation task; records every non-planning prompt. */
class PlanningMock implements AgentAdapter {
  readonly id = "mock";
  readonly provider = "mock";
  readonly workPrompts: string[] = [];
  async getCapabilities() {
    return {
      planning: true, structuredOutput: true, repositoryRead: true, repositoryWrite: true,
      shell: true, testing: true, browser: false, vision: false, resumableSessions: false,
      readOnlyEnforcement: "provider-native" as const,
    };
  }
  async listModels() { return []; }
  async healthCheck() { return { status: "ok" as const }; }
  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    if (req.prompt.includes("PLAN RULES")) {
      const plan = {
        summary: "Write B",
        leadAgentId: "mock",
        tasks: [{ id: "IMPL", title: "Write B", kind: "implementation", risk: "low", requiredCapabilities: ["repository.write"] }],
      };
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: JSON.stringify(plan) } };
      return;
    }
    this.workPrompts.push(req.prompt);
    await fs.writeFile(path.join(req.cwd, "B"), "b\n");
    yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed" } };
  }
  resumeRun(): AsyncIterable<AgentEvent> { throw new Error("no resume"); }
  async cancelRun() {}
  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id, transport: "cli", approval: "none", structuredToolEvents: false,
      contextMetrics: "estimated", manualCompact: false, mcp: false, webSearch: false, cancellation: false,
    };
  }
}

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ckpt-daemon-"));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  const adapter = new PlanningMock();
  const store = await RunStore.open(path.join(dir, "bremio.db"));
  const registry = new RunRegistry(store, undefined, () => [adapter]);
  cleanups.push(async () => {
    registry.cancelAll();
    await registry.awaitCancellations();
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });
  const branches = () =>
    execFileSync("git", ["branch", "--list", "bremio/*"], { cwd: repo, encoding: "utf8" }).trim();
  return { registry, store, repo, adapter, branches };
}

function watch(registry: RunRegistry, runId: string) {
  const seen: RunEvent[] = [];
  const waiters: Array<{ match: (e: RunEvent) => boolean; resolve: (e: RunEvent) => void }> = [];
  const unsubscribe = registry.subscribe(runId, (event) => {
    seen.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.match(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  cleanups.push(async () => unsubscribe());
  return {
    wait(match: (e: RunEvent) => boolean): Promise<RunEvent> {
      const already = seen.find(match);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

async function settled(store: RunStore, id: string, timeoutMs = 30_000): Promise<PersistedRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.getRun(id);
    if (run && isTerminal(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${id} never settled`);
}

const pendingCheckpoint = (e: RunEvent) =>
  e.kind === "plan-checkpoint" && typeof (e.data as { requestId?: string; plan?: unknown })?.plan === "object";

describe("P2-T2 plan checkpoint through the daemon", () => {
  it("a rejected plan fails the run before any worktree or worker run", async () => {
    const { registry, store, repo, adapter, branches } = await harness();
    const run = registry.start({ mode: "team", repoPath: repo, prompt: "write B", agentId: "mock", reviewPlan: true });
    const events = watch(registry, run.id);
    const checkpoint = await events.wait(pendingCheckpoint);
    const requestId = (checkpoint.data as { requestId: string }).requestId;
    expect(store.getRun(run.id)?.status).toBe("pending_approval");

    expect(registry.decideApprovalRequest({ id: requestId, decision: "rejected", decidedBy: "tester" })).toBeTruthy();
    expect(registry.resolvePendingApproval(requestId, "rejected")).toBe(true);

    const finished = await settled(store, run.id);
    expect(finished.status).toBe("failed");
    expect(finished.failureCode).toBe("plan_rejected");
    expect(adapter.workPrompts).toHaveLength(0);
    expect(branches()).toBe("");
    expect(registry.getApprovalRequest(requestId)?.state).toBe("rejected");
  }, 60_000);

  it("an edited plan executes and the request is recorded as approved-with-edit", async () => {
    const { registry, store, repo, adapter } = await harness();
    const run = registry.start({ mode: "team", repoPath: repo, prompt: "write B", agentId: "mock", reviewPlan: true });
    const events = watch(registry, run.id);
    const checkpoint = await events.wait(pendingCheckpoint);
    const { requestId, plan } = checkpoint.data as { requestId: string; plan: { tasks: Array<{ title: string }> } };
    plan.tasks[0]!.title = "Write B, edited";

    expect(registry.editPlanCheckpoint(requestId, plan, "tester")).toBe(true);
    await settled(store, run.id);
    expect(adapter.workPrompts.some((p) => p.includes("Write B, edited"))).toBe(true);
    const request = registry.getApprovalRequest(requestId);
    expect(request?.state).toBe("approved");
    expect(request?.reason).toMatch(/edited plan/);
    // a second answer to the same checkpoint is refused
    expect(registry.editPlanCheckpoint(requestId, plan, "tester")).toBe(false);
  }, 60_000);

  it("fails closed when nobody is subscribed to answer", async () => {
    const { registry, store, repo, adapter, branches } = await harness();
    const run = registry.start({ mode: "team", repoPath: repo, prompt: "write B", agentId: "mock", reviewPlan: true });
    const finished = await settled(store, run.id);
    expect(finished.status).toBe("failed");
    expect(finished.failureCode).toBe("plan_rejected");
    expect(finished.failureMessage).toMatch(/no client was connected/);
    expect(adapter.workPrompts).toHaveLength(0);
    expect(branches()).toBe("");
  }, 60_000);
});
