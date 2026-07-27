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
import { RunRegistry, type RunEvent } from "./runs";
import { RunStore, isTerminal, type PersistedRun } from "./storage";

/**
 * S4-T10 bound the action digest to the real diff, but every test for it hashed
 * strings directly. Deleting the comparison in `#execute` left all 721 tests
 * green, so the property was asserted about SHA-256 rather than about Bremio.
 * These tests drive the production path instead: a run, a real worktree, a real
 * approval, and the merge that follows it.
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

/** Writes one file into whatever workspace it is given, then finishes. */
class ReviewMockAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly provider = "mock";

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
    const ts = Date.now();
    yield { type: "started", runId: request.runId, ts };
    await fs.writeFile(path.join(request.cwd, "FEATURE.txt"), "agent output\n", "utf8");
    yield {
      type: "completed",
      runId: request.runId,
      ts,
      outcome: { status: "completed", finalText: "wrote FEATURE.txt" },
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

async function harness(): Promise<{ registry: RunRegistry; store: RunStore; repo: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-review-"));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);

  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  git(["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);

  const store = await RunStore.open(path.join(dir, "bremio.db"));
  cleanups.push(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });

  return { registry: new RunRegistry(store, undefined, () => [new ReviewMockAdapter()]), store, repo };
}

/** Collects events and lets a test await one, replay included. */
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
    seen,
    wait(match: (e: RunEvent) => boolean): Promise<RunEvent> {
      const already = seen.find(match);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

/** Poll the store, for the cases that must work with nobody subscribed. */
async function settled(store: RunStore, id: string, timeoutMs = 30_000): Promise<PersistedRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.getRun(id);
    if (run && isTerminal(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${id} never settled (last status: ${store.getRun(id)?.status})`);
}

function start(registry: RunRegistry, repo: string) {
  return registry.start({
    mode: "single",
    repoPath: repo,
    prompt: "add a feature",
    agentId: "mock",
    workspaceStrategy: "isolated-worktree",
  });
}

describe("review-before-apply, driven through the run path", () => {
  it("merges the approved worktree into the working tree", async () => {
    const { registry, store, repo } = await harness();
    const run = start(registry, repo);
    const events = watch(registry, run.id);

    const review = await events.wait((e) => e.kind === "review-requested");
    const requestId = (review.data as { requestId: string }).requestId;
    expect(store.getRun(run.id)?.status).toBe("pending_approval");

    // Verify the approval request is filed under the run's session, not the run id.
    const approvalRequest = registry.getApprovalRequest(requestId);
    const runSessionId = store.getRun(run.id)?.sessionId;
    expect(approvalRequest?.sessionId).toBe(runSessionId);
    expect(approvalRequest?.sessionId).not.toBe(run.id);

    expect(registry.resolvePendingApproval(requestId, "approved")).toBe(true);
    const finished = await settled(store, run.id);

    expect(finished.status).toBe("completed");
    // The point of the whole flow: the change reaches the user's working tree.
    await expect(fs.readFile(path.join(repo, "FEATURE.txt"), "utf8")).resolves.toBe("agent output\n");
  }, 60_000);

  it("refuses to merge a worktree that changed after it was approved", async () => {
    const { registry, store, repo } = await harness();
    const run = start(registry, repo);
    const events = watch(registry, run.id);

    const review = await events.wait((e) => e.kind === "review-requested");
    const data = review.data as { requestId: string; worktreePath: string };

    // Substitute different content for what the user was shown. Without the
    // digest comparison in `#execute` this merges and the test fails.
    const git = (args: string[]) => execFileSync("git", args, { cwd: data.worktreePath, stdio: "pipe" });
    await fs.writeFile(path.join(data.worktreePath, "FEATURE.txt"), "substituted\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-q", "--no-verify", "-m", "tampered"]);

    expect(registry.resolvePendingApproval(data.requestId, "approved")).toBe(true);
    const finished = await settled(store, run.id);

    expect(finished.status).toBe("failed");
    expect(finished.failureCode).toBe("review_drifted");
    await expect(fs.readFile(path.join(repo, "FEATURE.txt"), "utf8")).rejects.toThrow();
  }, 60_000);

  it("discards the worktree a reviewer rejected", async () => {
    const { registry, store, repo } = await harness();
    const run = start(registry, repo);
    const events = watch(registry, run.id);

    const review = await events.wait((e) => e.kind === "review-requested");
    const requestId = (review.data as { requestId: string }).requestId;

    expect(registry.resolvePendingApproval(requestId, "rejected")).toBe(true);
    const finished = await settled(store, run.id);

    expect(finished.status).toBe("failed");
    expect(finished.failureCode).toBe("review_rejected");
    await expect(fs.readFile(path.join(repo, "FEATURE.txt"), "utf8")).rejects.toThrow();
  }, 60_000);

  it("settles an unattended run instead of waiting for a decision nobody can make", async () => {
    // Nothing subscribes here, so the fail-closed rule auto-denies the request.
    // It used to reject the request and then await a promise only a client
    // could resolve: the run stayed `pending_approval` for the life of the
    // daemon, holding its worktree, and shutdown blocked on the execution.
    const { registry, store, repo } = await harness();
    const run = start(registry, repo);

    const finished = await settled(store, run.id);

    expect(finished.status).toBe("failed");
    expect(finished.failureCode).toBe("review_unattended");
    // Nobody saw the changes, so nobody chose to discard them.
    expect(finished.failureMessage).toContain("bremio/");
    await expect(fs.readFile(path.join(repo, "FEATURE.txt"), "utf8")).rejects.toThrow();
  }, 60_000);
});
