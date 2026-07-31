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
import { RunStore, isTerminal, type PersistedRun } from "./storage";

/**
 * The prompt queue (S10-T2), driven through `RunRegistry.start` rather than
 * through the storage helpers underneath it — the queue's whole purpose is what
 * happens to a *second* prompt while a first one is in flight, and that only
 * exists on the run path.
 */

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

/**
 * Finishes only when the test lets it, so a turn can be held "in flight".
 *
 * `startCount` rather than the prompt text: a session continuation reaches the
 * adapter through `prepareTurnExecution`, which composes the request, so
 * `request.prompt` is not the string the user typed. What each test needs is
 * *how many* turns actually reached an agent, and the store says which.
 */
class GatedAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly provider = "mock";
  startCount = 0;
  #release!: () => void;
  #gate = new Promise<void>((resolve) => { this.#release = resolve; });

  release(): void { this.#release(); }

  async getCapabilities(): Promise<AgentCapabilities> { return CAPABILITIES; }
  async listModels(): Promise<ModelDescriptor[]> { return []; }
  async healthCheck(): Promise<AgentHealth> { return { status: "ok" }; }

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.startCount += 1;
    yield { type: "started", runId: request.runId, ts: Date.now() };
    await this.#gate;
    yield {
      type: "completed",
      runId: request.runId,
      ts: Date.now(),
      outcome: { status: "completed", finalText: "done" },
    };
  }

  async *resumeRun(_s: string, request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield* this.startRun(request);
  }

  async cancelRun(): Promise<void> {}

  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id, transport: "cli", approval: "none",
      structuredToolEvents: false, contextMetrics: "estimated", manualCompact: false,
      mcp: false, webSearch: false, cancellation: false,
    };
  }
}

async function harness(adapter: AgentAdapter): Promise<{
  registry: RunRegistry;
  store: RunStore;
  repo: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-queue-"));
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
  cleanups.push(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });
  return { registry: new RunRegistry(store, undefined, () => [adapter]), store, repo };
}

/** Wait until a predicate holds, so tests never sleep a fixed duration. */
async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition never held");
}

function settled(store: RunStore, id: string): Promise<PersistedRun> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    const tick = () => {
      const run = store.getRun(id);
      if (run && isTerminal(run.status)) return resolve(run);
      if (Date.now() > deadline) return reject(new Error(`run ${id} never settled`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("a prompt sent while a turn is running is queued, not refused", () => {
  it("queues the second prompt and runs it when the first completes", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;

    const second = registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });

    // Accepted, not refused — and not running alongside the first.
    expect(store.getRun(second.id)?.status).toBe("queued");
    expect(registry.queuedRuns(sessionId).map((r) => r.id)).toEqual([second.id]);
    expect(adapter.startCount).toBe(1);

    adapter.release();
    await settled(store, first.id);
    await settled(store, second.id);

    expect(store.getRun(second.id)?.status).toBe("completed");
    expect(adapter.startCount).toBe(2);
    expect(registry.queuedRuns(sessionId)).toHaveLength(0);
  }, 60_000);

  it("keeps queued prompts in the order they were submitted", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;

    registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });
    registry.start({ mode: "single", repoPath: repo, prompt: "three", agentId: "mock", sessionId });

    const queued = registry.queuedRuns(sessionId);
    expect(queued.map((r) => r.prompt)).toEqual(["two", "three"]);
    // turn_index is what orders them, and it was already assigned on insert.
    expect(queued.map((r) => r.turnIndex)).toEqual([1, 2]);
  }, 60_000);

  it("does not queue anything for a run with no session", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const a = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    const b = registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock" });

    // Separate sessions, so neither waits for the other.
    await until(() => store.getRun(a.id)?.status === "running" && store.getRun(b.id)?.status === "running");
    expect(store.getRun(a.id)?.sessionId).not.toBe(store.getRun(b.id)?.sessionId);
    adapter.release();
  }, 60_000);
});

describe("a queued prompt is never run silently after a turn that did not complete", () => {
  it("holds the queue when the running turn is cancelled", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;
    const second = registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });

    registry.cancel(first.id);
    adapter.release();
    const cancelled = await settled(store, first.id);
    expect(cancelled.status).not.toBe("completed");

    // The queued prompt was written expecting the previous turn to work. It
    // stays queued and visible rather than executing against a state the user
    // just cancelled — and rather than being thrown away.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(store.getRun(second.id)?.status).toBe("queued");
    expect(adapter.startCount).toBe(1);
    expect(registry.queuedRuns(sessionId).map((r) => r.id)).toEqual([second.id]);
  }, 60_000);

  it("lets the user release a held prompt explicitly", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;
    const second = registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });

    registry.cancel(first.id);
    adapter.release();
    await settled(store, first.id);

    expect(registry.releaseQueuedRun(second.id)).toEqual({ ok: true });
    await settled(store, second.id);
    expect(adapter.startCount).toBe(2);
  }, 60_000);

  it("refuses to release a prompt that is not next in line", async () => {
    // The panel only offers Run on the head, but enforcing order there alone
    // would leave the route able to reorder a conversation.
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;
    registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });
    const third = registry.start({ mode: "single", repoPath: repo, prompt: "three", agentId: "mock", sessionId });

    registry.cancel(first.id);
    adapter.release();
    await settled(store, first.id);

    const result = registry.releaseQueuedRun(third.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("not next in the queue");
    expect(store.getRun(third.id)?.status).toBe("queued");
  }, 60_000);

  it("refuses to release while another turn is in flight", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;
    const second = registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });

    const result = registry.releaseQueuedRun(second.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("already has a turn in flight");
    adapter.release();
  }, 60_000);
});

describe("queued prompts can be removed before they run", () => {
  it("removes a queued prompt and leaves the rest in order", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;
    const second = registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });
    const third = registry.start({ mode: "single", repoPath: repo, prompt: "three", agentId: "mock", sessionId });

    expect(registry.removeQueuedRun(second.id)).toBe(true);
    expect(registry.queuedRuns(sessionId).map((r) => r.id)).toEqual([third.id]);

    adapter.release();
    await settled(store, first.id);
    await settled(store, third.id);
    expect(adapter.startCount).toBe(2);
  }, 60_000);

  it("refuses to remove a run that already executed", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);

    // A run that executed owns history; deleting it would put a hole in the
    // transcript, which is why `deleteQueuedRun` is scoped to `queued`.
    expect(registry.removeQueuedRun(first.id)).toBe(false);
    expect(store.getRun(first.id)).toBeDefined();
    adapter.release();
  }, 60_000);
});

describe("a restart does not discard prompts that never started", () => {
  it("leaves queued runs queued through reconciliation", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;
    const second = registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });

    // A fresh registry over the same store is what a restart looks like.
    const restarted = new RunRegistry(store, undefined, () => [adapter]);
    const reconciled = restarted.reconcileOnStartup();

    // The running turn is stranded and reported as such; the queued prompt was
    // never started, so nothing about it was interrupted.
    expect(reconciled.map((r) => r.id)).toContain(first.id);
    expect(reconciled.map((r) => r.id)).not.toContain(second.id);
    expect(store.getRun(second.id)?.status).toBe("queued");
    expect(restarted.queuedRuns(sessionId).map((r) => r.id)).toEqual([second.id]);
    adapter.release();
  }, 60_000);

  it("refuses to auto-run a prompt whose submitted arguments were lost", async () => {
    const adapter = new GatedAdapter();
    const { registry, store, repo } = await harness(adapter);

    const first = registry.start({ mode: "single", repoPath: repo, prompt: "one", agentId: "mock" });
    await until(() => adapter.startCount === 1);
    const sessionId = store.getRun(first.id)!.sessionId!;
    const second = registry.start({ mode: "single", repoPath: repo, prompt: "two", agentId: "mock", sessionId });

    // The restarted registry has no memory of how the prompt was submitted —
    // model, reasoning level and workspace strategy have nowhere to live in the
    // run row. Reconstructing them would be a guess, so it refuses.
    const restarted = new RunRegistry(store, undefined, () => [adapter]);
    restarted.reconcileOnStartup(); // clears the stranded turn, as a real restart does
    const result = restarted.releaseQueuedRun(second.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("daemon restarted");
    adapter.release();
  }, 60_000);
});
