import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

/** Records every request it receives and completes immediately. */
class RecordingAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly provider = "mock";
  readonly requests: AgentRunRequest[] = [];

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
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
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
  async healthCheck(): Promise<AgentHealth> {
    return { status: "ok" };
  }
  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    yield { type: "started", runId: request.runId, ts: Date.now() };
    yield { type: "completed", runId: request.runId, ts: Date.now(), outcome: { status: "completed", finalText: "ok" } };
  }
  async *resumeRun(_s: string, request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield* this.startRun(request);
  }
  async cancelRun(): Promise<void> {}
  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id,
      transport: "cli",
      approval: "per-action",
      structuredToolEvents: true,
      contextMetrics: "estimated",
      manualCompact: false,
      mcp: true,
      mcpTransports: ["stdio"],
      webSearch: false,
      cancellation: true,
    };
  }
}

async function harness(manifest?: unknown) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-ext-"));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  if (manifest !== undefined) {
    await fs.mkdir(path.join(repo, ".bremio"), { recursive: true });
    await fs.writeFile(path.join(repo, ".bremio", "mcp-servers.json"), JSON.stringify(manifest));
  }
  const store = await RunStore.open(path.join(dir, "bremio.db"));
  const adapter = new RecordingAdapter();
  const registry = new RunRegistry(store, undefined, () => [adapter]);
  cleanups.push(async () => {
    registry.cancelAll();
    await registry.awaitCancellations();
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });
  return { registry, store, repo, adapter };
}

async function settle(store: RunStore, id: string) {
  for (let i = 0; i < 250; i++) {
    const run = store.getRun(id);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await delay(20);
  }
  throw new Error(`run ${id} did not settle`);
}

const DOCS = { id: "docs", name: "Docs", transport: { type: "stdio", command: "docs-mcp", args: [] } };

describe("daemon runs carry docs/17 P3 extensions", () => {
  it("gives every adapter request the run's MCP policy gate", async () => {
    const { registry, store, repo, adapter } = await harness();
    const run = registry.start({ mode: "single", repoPath: repo, prompt: "hi", agentId: "mock" });
    await settle(store, run.id);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.mcpToolGate!("mcp__x__y")).toMatchObject({ allowed: true, approvalRequired: "none" });
    expect(adapter.requests[0]!.mcpServers).toBeUndefined();
  });

  it("attaches servers the run opted into from .bremio/mcp-servers.json", async () => {
    const { registry, store, repo, adapter } = await harness([DOCS]);
    const run = registry.start({ mode: "single", repoPath: repo, prompt: "hi", agentId: "mock", mcpServers: ["docs"] });
    expect((await settle(store, run.id)).status).toBe("completed");
    expect(adapter.requests[0]!.mcpServers).toEqual([DOCS]);
  });

  it("fails a run that asks for an undeclared server, naming it, without calling the agent", async () => {
    const { registry, store, repo, adapter } = await harness([DOCS]);
    const run = registry.start({ mode: "single", repoPath: repo, prompt: "hi", agentId: "mock", mcpServers: ["web"] });
    const settled = await settle(store, run.id);
    expect(settled.status).toBe("failed");
    expect(JSON.stringify(registry.events(run.id))).toMatch(/MCP server \\"web\\" is not declared/);
    expect(adapter.requests).toHaveLength(0);
  });
});

describe("daemon apply honours pre-apply hooks (P3-T2)", () => {
  it("refuses to apply when a pre-apply hook vetoes, before reading the run", async () => {
    const { applyRunPatch } = await import("./apply");
    const { repo } = await harness();
    await fs.mkdir(path.join(repo, ".bremio"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".bremio", "hooks.json"),
      JSON.stringify([
        {
          id: "freeze",
          point: "run:pre-apply",
          command: process.execPath,
          args: ["-e", "console.error('code freeze');process.exit(3)"],
        },
      ]),
    );
    const result = await applyRunPatch({ repoPath: repo, runId: "run-that-does-not-exist" });
    expect(result).toEqual({ ok: false, error: 'run:pre-apply hook "freeze" vetoed: code freeze' });
  });
});
