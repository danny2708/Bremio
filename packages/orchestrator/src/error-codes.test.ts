import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunRequest } from "@bremio/adapter-sdk";
import type { AgentEvent, Plan, Task } from "@bremio/protocol";
import type { CollectResult, TaskWorktree, WorktreeManager } from "@bremio/workspace";
import { collectRun } from "./stream";
import { runPlan } from "./scheduler";

async function* events(...items: AgentEvent[]): AsyncIterable<AgentEvent> {
  yield* items;
}

describe("P2-T1: every non-completed outcome carries a classified code", () => {
  it("classifies a provider message once, in the collector", async () => {
    const run = await collectRun(events({
      type: "completed",
      runId: "r",
      ts: 1,
      outcome: { status: "failed", error: "HTTP 429 Too Many Requests" },
    }));
    expect(run.outcome.errorCode).toBe("rate_limited");
  });

  it("keeps an adapter's own classification", async () => {
    const run = await collectRun(events({
      type: "completed",
      runId: "r",
      ts: 1,
      outcome: { status: "failed", error: "429", errorCode: "quota_exhausted" },
    }));
    expect(run.outcome.errorCode).toBe("quota_exhausted");
  });

  it("codes cancellation as cancelled and leaves completed runs uncoded", async () => {
    const cancelled = await collectRun(events({
      type: "completed",
      runId: "r",
      ts: 1,
      outcome: { status: "cancelled", error: "whatever" },
    }));
    expect(cancelled.outcome.errorCode).toBe("cancelled");
    const ok = await collectRun(events({
      type: "completed",
      runId: "r",
      ts: 1,
      outcome: { status: "completed" },
    }));
    expect(ok.outcome.errorCode).toBeUndefined();
  });

  it("codes a stream that ended without a completed event", async () => {
    const run = await collectRun(events());
    expect(run.outcome.status).toBe("failed");
    expect(run.outcome.errorCode).toBeDefined();
  });
});

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    kind: "implementation",
    requiredCapabilities: [],
    preferredAgents: [],
    risk: "low",
    dependencies: [],
    expectedArtifacts: [],
    acceptanceCriteria: [],
    ...over,
  };
}

/** Emits a shell test that exits with `exitCode` for test tasks. */
function scriptedAdapter(script: (req: AgentRunRequest) => AgentEvent[]): AgentAdapter {
  return {
    id: "worker",
    provider: "test",
    getCapabilities: async () => ({
      planning: true, structuredOutput: true, repositoryRead: true, repositoryWrite: true,
      shell: true, testing: true, browser: false, vision: false, resumableSessions: false,
      readOnlyEnforcement: "provider-native",
    }),
    getRuntimeCapabilities: async () => ({
      adapterId: "worker", transport: "cli", approval: "none", structuredToolEvents: true,
      contextMetrics: "none", manualCompact: false, mcp: false, webSearch: false, cancellation: true,
    }),
    listModels: async () => [],
    healthCheck: async () => ({ status: "ok" }),
    async *startRun(req) {
      yield* script(req);
    },
    resumeRun: () => { throw new Error("no resume"); },
    cancelRun: async () => {},
  } as AgentAdapter;
}

const fakeWorkspace = {
  async create(taskId: string, agentId: string): Promise<TaskWorktree> {
    return { taskId, agentId, branch: `bremio/${taskId}-${agentId}`, path: os.tmpdir() };
  },
  async collect(): Promise<CollectResult> {
    return { filesChanged: [], committed: false };
  },
} as unknown as WorktreeManager;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("P2-T1: the scheduler codes Bremio's own judgements", () => {
  it("codes a non-zero test command, a dependency block and a provider failure", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-codes-"));
    dirs.push(runDir);
    const adapter = scriptedAdapter((req) => {
      const id = req.runId.split("::")[0];
      if (id === "TEST") {
        return [
          { type: "tool_use", runId: req.runId, ts: 1, name: "bash", input: { command: "npm test" } },
          { type: "tool_result", runId: req.runId, ts: 2, name: "bash", ok: false, exitCode: 1 },
          { type: "completed", runId: req.runId, ts: 3, outcome: { status: "completed" } },
        ];
      }
      if (id === "IMPL-B") {
        return [{
          type: "completed", runId: req.runId, ts: 1,
          outcome: { status: "failed", error: "Invalid API key" },
        }];
      }
      return [{ type: "completed", runId: req.runId, ts: 1, outcome: { status: "completed" } }];
    });
    const plan: Plan = {
      summary: "codes",
      leadAgentId: "worker",
      tasks: [
        task("IMPL"),
        task("TEST", { kind: "test", dependencies: ["IMPL"] }),
        task("IMPL-B"),
        task("AFTER-B", { dependencies: ["IMPL-B"] }),
      ],
    };
    const results = await runPlan({
      plan,
      assign: new Map(plan.tasks.map((t) => [t.id, "worker"])),
      registry: new Map([["worker", adapter]]),
      workspace: fakeWorkspace,
      runDir,
      runId: "run-codes",
    });
    const byId = new Map(results.map((r) => [r.taskId, r]));
    expect(byId.get("IMPL")?.errorCode).toBeUndefined();
    expect(byId.get("TEST")?.errorCode).toBe("verification_failed");
    expect(byId.get("IMPL-B")?.errorCode).toBe("authentication_failed");
    expect(byId.get("AFTER-B")?.errorCode).toBe("blocked_by_dependency");
  });
});
