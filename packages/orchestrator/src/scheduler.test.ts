import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent, Plan, Task, TaskResult } from "@bremio/protocol";
import type { CollectResult, TaskWorktree, WorktreeManager } from "@bremio/workspace";
import { readLedger } from "./ledger";
import { runPlan } from "./scheduler";

const CAPS: AgentCapabilities = {
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

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    kind: "implementation",
    requiredCapabilities: [],
    preferredAgents: [],
    risk: "low",
    dependencies: [],
    acceptanceCriteria: [],
    ...over,
  };
}

function plan(tasks: Task[]): Plan {
  return { summary: "test plan", leadAgentId: "claude", tasks };
}

/**
 * Adapter that records concurrency: it reports how many runs are in flight when
 * each task starts, which is what proves parallelism actually happened.
 */
class TrackingAdapter implements AgentAdapter {
  readonly id = "worker";
  readonly provider = "test";
  inFlight = 0;
  peakInFlight = 0;
  readonly startOrder: string[] = [];
  readonly cancelled: string[] = [];

  // The hold must dominate the fake git delay below: git work is serialized, so
  // a short hold would let each task finish before the next one even starts and
  // no overlap could be observed (Windows timers are ~15ms granular).
  constructor(
    private readonly holdMs = 120,
    private readonly failTaskIds: ReadonlySet<string> = new Set(),
  ) {}

  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPS;
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
  async healthCheck(): Promise<AgentHealth> {
    return { status: "ok" };
  }
  resumeRun(): AsyncIterable<AgentEvent> {
    throw new Error("not implemented");
  }
  async cancelRun(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }

  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const taskId = req.runId.split("::")[0] ?? req.runId;
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    this.startOrder.push(taskId);
    const ts = Date.now();
    yield { type: "started", runId: req.runId, ts };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.holdMs);
        req.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    } catch {
      yield {
        type: "completed",
        runId: req.runId,
        ts: Date.now(),
        outcome: { status: "cancelled", error: "aborted" },
      };
      this.inFlight -= 1;
      return;
    }
    this.inFlight -= 1;
    yield {
      type: "completed",
      runId: req.runId,
      ts: Date.now(),
      outcome: this.failTaskIds.has(taskId)
        ? { status: "failed", error: "mock failure" }
        : { status: "completed", finalText: `${taskId} done` },
    };
  }
}

/**
 * Fake worktree manager that asserts the scheduler never overlaps git work:
 * `create`/`collect` increment a counter that must never exceed 1.
 */
class FakeWorkspace {
  concurrentGitOps = 0;
  maxConcurrentGitOps = 0;

  async #serialSection<T>(fn: () => Promise<T>): Promise<T> {
    this.concurrentGitOps += 1;
    this.maxConcurrentGitOps = Math.max(this.maxConcurrentGitOps, this.concurrentGitOps);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return await fn();
    } finally {
      this.concurrentGitOps -= 1;
    }
  }

  async create(taskId: string, agentId: string): Promise<TaskWorktree> {
    return this.#serialSection(async () => ({
      taskId,
      agentId,
      branch: `bremio/${taskId}-${agentId}`,
      path: path.join(os.tmpdir(), "bremio-fake", `${taskId}-${agentId}`),
    }));
  }

  async collect(): Promise<CollectResult> {
    return this.#serialSection(async () => ({
      filesChanged: ["a.txt"],
      commitHash: "abc123",
      committed: true,
    }));
  }
}

const tempDirs: string[] = [];
async function tempRunDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-sched-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

interface HarnessOptions {
  tasks: Task[];
  maxConcurrency?: number;
  holdMs?: number;
  failTaskIds?: ReadonlySet<string>;
  ledgerPath?: string;
  signal?: AbortSignal;
}

async function run(opts: HarnessOptions): Promise<{
  results: TaskResult[];
  adapter: TrackingAdapter;
  workspace: FakeWorkspace;
}> {
  const adapter = new TrackingAdapter(opts.holdMs ?? 120, opts.failTaskIds ?? new Set());
  const workspace = new FakeWorkspace();
  const runDir = await tempRunDir();
  const p = plan(opts.tasks);
  const results = await runPlan({
    plan: p,
    assign: new Map(p.tasks.map((t) => [t.id, "worker"] as const)),
    registry: new Map([["worker", adapter as AgentAdapter]]),
    workspace: workspace as unknown as WorktreeManager,
    runDir,
    runId: "run-test",
    ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
    ...(opts.ledgerPath ? { ledgerPath: opts.ledgerPath } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { results, adapter, workspace };
}

describe("parallel scheduler", () => {
  it("runs independent tasks concurrently up to the limit", async () => {
    const { results, adapter } = await run({
      tasks: [task("TASK-001"), task("TASK-002"), task("TASK-003"), task("TASK-004")],
      maxConcurrency: 2,
    });

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(adapter.peakInFlight).toBe(2);
  });

  it("defaults to running two tasks at once", async () => {
    const { adapter } = await run({
      tasks: [task("TASK-001"), task("TASK-002"), task("TASK-003")],
    });
    expect(adapter.peakInFlight).toBe(2);
  });

  it("never overlaps git operations even while tasks run in parallel", async () => {
    const { workspace, adapter } = await run({
      tasks: [task("TASK-001"), task("TASK-002"), task("TASK-003"), task("TASK-004")],
      maxConcurrency: 4,
    });

    expect(adapter.peakInFlight).toBe(4);
    expect(workspace.maxConcurrentGitOps).toBe(1);
  });

  it("holds a dependent task until its dependency completes", async () => {
    const { results, adapter } = await run({
      tasks: [
        task("TASK-001"),
        task("TASK-002", { dependencies: ["TASK-001"] }),
        task("TASK-003", { dependencies: ["TASK-002"] }),
      ],
      maxConcurrency: 3,
    });

    expect(adapter.startOrder).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    // A fully serial dependency chain must never overlap, whatever the limit.
    expect(adapter.peakInFlight).toBe(1);
    expect(results.map((r) => r.taskId)).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
  });

  it("runs a diamond's independent middle tasks in parallel", async () => {
    const { results, adapter } = await run({
      tasks: [
        task("TASK-001"),
        task("TASK-002", { dependencies: ["TASK-001"] }),
        task("TASK-003", { dependencies: ["TASK-001"] }),
        task("TASK-004", { dependencies: ["TASK-002", "TASK-003"] }),
      ],
      maxConcurrency: 3,
    });

    expect(adapter.startOrder[0]).toBe("TASK-001");
    expect(adapter.startOrder.at(-1)).toBe("TASK-004");
    expect(adapter.peakInFlight).toBe(2); // only TASK-002 + TASK-003 overlap
    expect(results.every((r) => r.status === "completed")).toBe(true);
  });

  it("blocks dependents of a failed task without blocking independent work", async () => {
    const { results } = await run({
      tasks: [
        task("TASK-001"),
        task("TASK-002", { dependencies: ["TASK-001"] }),
        task("TASK-003"),
      ],
      maxConcurrency: 2,
      failTaskIds: new Set(["TASK-001"]),
    });

    const byId = new Map(results.map((r) => [r.taskId, r] as const));
    expect(byId.get("TASK-001")?.status).toBe("failed");
    expect(byId.get("TASK-002")?.status).toBe("failed");
    expect(byId.get("TASK-002")?.error).toContain("blocked by unsuccessful dependencies: TASK-001");
    expect(byId.get("TASK-003")?.status).toBe("completed");
  });

  it("returns results in topological order regardless of completion order", async () => {
    const { results } = await run({
      tasks: [task("TASK-001"), task("TASK-002"), task("TASK-003")],
      maxConcurrency: 3,
    });
    expect(results.map((r) => r.taskId)).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
  });

  it("cancels in-flight tasks and marks the unstarted ones cancelled", async () => {
    const ac = new AbortController();
    const pending = run({
      tasks: [task("TASK-001"), task("TASK-002"), task("TASK-003"), task("TASK-004")],
      maxConcurrency: 2,
      holdMs: 400,
      signal: ac.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    ac.abort();

    const { results } = await pending;
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.status === "cancelled")).toBe(true);
    // The two that never started must say so explicitly.
    expect(results.filter((r) => r.error?.includes("cancelled before this task started"))).toHaveLength(2);
  });

  it("writes one intact ledger line per task under concurrent appends", async () => {
    const dir = await tempRunDir();
    const ledgerPath = path.join(dir, "ledger.jsonl");
    const tasks = Array.from({ length: 8 }, (_, i) =>
      task(`TASK-${String(i + 1).padStart(3, "0")}`),
    );

    await run({ tasks, maxConcurrency: 8, holdMs: 5, ledgerPath });

    const raw = await fs.readFile(ledgerPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(8);
    // readLedger skips malformed lines, so an equal count proves none tore.
    const entries = await readLedger(ledgerPath);
    expect(entries).toHaveLength(8);
    expect(new Set(entries.map((e) => e.taskId)).size).toBe(8);
  });
});
