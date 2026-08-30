import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AdapterRuntimeCapabilities,
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { RunRegistry } from "./runs";
import { RunStore } from "./storage";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
});

const CAPABILITIES: AgentCapabilities = {
  planning: true,
  structuredOutput: true,
  repositoryRead: true,
  repositoryWrite: true,
  shell: false,
  testing: false,
  browser: false,
  vision: false,
  resumableSessions: false,
  readOnlyEnforcement: "provider-native",
};

/** Stays running until the test releases it, so a run can be observed mid-flight. */
class BlockingAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly provider = "mock";
  #release!: () => void;
  readonly started: Promise<void>;
  #announceStarted!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.#announceStarted = resolve;
    });
  }

  release(): void {
    this.#release?.();
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPABILITIES;
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
  async healthCheck(): Promise<AgentHealth> {
    return { status: "ok" };
  }

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "started", runId: request.runId, ts: Date.now() };
    this.#announceStarted();
    await new Promise<void>((resolve) => {
      this.#release = resolve;
      request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield {
      type: "completed",
      runId: request.runId,
      ts: Date.now(),
      outcome: { status: "completed", finalText: "done" },
    };
  }

  async *resumeRun(_sessionId: string, request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield* this.startRun(request);
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

async function harness(): Promise<{
  registry: RunRegistry;
  store: RunStore;
  repo: string;
  adapter: BlockingAdapter;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-active-"));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);

  const store = await RunStore.open(path.join(dir, "bremio.db"));
  const adapter = new BlockingAdapter();
  const registry = new RunRegistry(store, undefined, () => [adapter]);
  cleanups.push(async () => {
    adapter.release();
    registry.cancelAll();
    await registry.awaitCancellations();
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });

  return { registry, store, repo, adapter };
}

describe("activeRuns reports who is working (S10-T4)", () => {
  it("reports nothing when the daemon is idle", async () => {
    const { registry } = await harness();
    expect(registry.activeRuns()).toEqual([]);
  });

  it("reports a live run with its lead and workers", async () => {
    const { registry, store, repo, adapter } = await harness();
    const run = registry.start({
      mode: "single",
      repoPath: repo,
      prompt: "build the thing",
      agentId: "mock",
      workerId: "codex",
    });
    await adapter.started;

    const active = registry.activeRuns();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      runId: run.id,
      repositoryPath: repo,
      status: "running",
      prompt: "build the thing",
      leadProvider: "mock",
      workerProviders: ["codex"],
    });
    void store;
  }, 30_000);

  it("counts a task as in flight from its start until its completion", async () => {
    const { registry, store, repo, adapter } = await harness();
    const run = registry.start({
      mode: "single",
      repoPath: repo,
      prompt: "p",
      agentId: "mock",
    });
    await adapter.started;

    // The events the orchestrator's task hooks write. Asserting on the
    // derivation is the point: a second in-memory copy of "what is each agent
    // doing" could disagree with the transcript the user reads afterwards.
    store.appendEvent(run.id, "task-start", { taskId: "T1", agentId: "codex", message: "write the parser" });
    store.appendEvent(run.id, "task-start", { taskId: "T2", agentId: "antigravity", message: "write the tests" });

    let tasks = registry.activeRuns()[0]!.tasksInFlight;
    expect(tasks.map((t) => t.taskId)).toEqual(["T1", "T2"]);
    expect(tasks[0]).toMatchObject({ agentId: "codex", title: "write the parser" });
    expect(tasks[0]!.since).toBeGreaterThan(0);

    store.appendEvent(run.id, "task-complete", { taskId: "T1", agentId: "codex", message: "completed" });

    tasks = registry.activeRuns()[0]!.tasksInFlight;
    expect(tasks.map((t) => t.taskId)).toEqual(["T2"]);
  }, 30_000);

  it("reports a task whose agent the events never named, rather than guessing one", async () => {
    const { registry, store, repo, adapter } = await harness();
    const run = registry.start({ mode: "single", repoPath: repo, prompt: "p", agentId: "mock" });
    await adapter.started;

    store.appendEvent(run.id, "task-start", { taskId: "T1", message: "unattributed work" });

    const [task] = registry.activeRuns()[0]!.tasksInFlight;
    expect(task).toMatchObject({ taskId: "T1", title: "unattributed work" });
    // Attributing it to the lead would put a name on the transcript that the
    // events never supported.
    expect(task!.agentId).toBeUndefined();
  }, 30_000);

  it("stops reporting a run once it finishes", async () => {
    const { registry, repo, adapter } = await harness();
    registry.start({ mode: "single", repoPath: repo, prompt: "p", agentId: "mock" });
    await adapter.started;
    expect(registry.activeRuns()).toHaveLength(1);

    adapter.release();
    const deadline = Date.now() + 20_000;
    while (registry.activeRuns().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(registry.activeRuns()).toEqual([]);
  }, 30_000);
});
