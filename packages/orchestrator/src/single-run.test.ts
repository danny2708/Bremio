import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterRuntimeCapabilities,
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import type { AgentEvent } from "@bremio/protocol";
import { ledgerPathFor, readLedger } from "./ledger";
import { createRegistry } from "./registry";
import { runSingleAgent } from "./single-run";

const FULL_CAPABILITIES: AgentCapabilities = {
  planning: true,
  structuredOutput: true,
  repositoryRead: true,
  repositoryWrite: true,
  shell: true,
  testing: true,
  browser: false,
  vision: false,
  resumableSessions: true,
  readOnlyEnforcement: "provider-native",
};

class SingleMockAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly provider = "openai";
  readonly requests: AgentRunRequest[] = [];
  readonly cancelledRuns: string[] = [];

  constructor(private readonly emitShellEvidence = true) {}

  async getCapabilities(): Promise<AgentCapabilities> {
    return FULL_CAPABILITIES;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async healthCheck(): Promise<AgentHealth> {
    return { status: "ok" };
  }

  async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    const ts = Date.now();
    yield { type: "started", runId: request.runId, ts };
    await fs.writeFile(path.join(request.cwd, "DIRECT.txt"), "single mode\n", "utf8");
    if (this.emitShellEvidence) {
      yield {
        type: "tool_use",
        runId: request.runId,
        ts,
        name: "shell",
        input: { command: "pnpm test" },
      };
      yield {
        type: "tool_result",
        runId: request.runId,
        ts,
        name: "shell",
        ok: true,
        exitCode: 0,
      };
    }
    yield {
      type: "usage",
      runId: request.runId,
      ts,
      model: "gpt-actual",
      reasoningLevel: "high",
      inputTokens: 10,
      outputTokens: 5,
    };
    yield {
      type: "completed",
      runId: request.runId,
      ts,
      outcome: {
        status: "completed",
        finalText: "Implemented and verified directly.",
        sessionId: "session-1",
      },
    };
  }

  async *resumeRun(sessionId: string, request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield* this.startRun(request);
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelledRuns.push(runId);
  }

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

class SlowSingleMockAdapter extends SingleMockAdapter {
  override async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    yield { type: "started", runId: request.runId, ts: Date.now() };
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) return resolve();
      request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    yield {
      type: "completed",
      runId: request.runId,
      ts: Date.now(),
      outcome: { status: "cancelled" },
    };
  }
}

class RetryingVerificationAdapter extends SingleMockAdapter {
  override async *startRun(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    const ts = Date.now();
    yield { type: "started", runId: request.runId, ts };
    const first = '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'npm test\'';
    yield { type: "tool_use", runId: request.runId, ts, name: "shell", input: { command: first } };
    yield { type: "tool_result", runId: request.runId, ts, name: "shell", ok: false, exitCode: 1 };
    const retry = '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'npm.cmd test\'';
    yield { type: "tool_use", runId: request.runId, ts, name: "shell", input: { command: retry } };
    yield { type: "tool_result", runId: request.runId, ts, name: "shell", ok: true, exitCode: 0 };
    yield {
      type: "completed",
      runId: request.runId,
      ts,
      outcome: { status: "completed", finalText: "Recovered with npm.cmd test." },
    };
  }
}

let repoPath: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, stdio: "pipe" }).toString().trim();
}

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-single-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@bremio.local"]);
  git(["config", "user.name", "Bremio Test"]);
  git(["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(repoPath, "README.md"), "# test\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
});

describe("runSingleAgent", () => {
  it("rejects a non-git workspace before invoking the adapter", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-not-git-"));
    const adapter = new SingleMockAdapter();
    try {
      await expect(runSingleAgent({
        primaryAgentId: "codex",
        repoPath: workspace,
        prompt: "edit directly",
        registry: createRegistry([adapter]),
      })).rejects.toThrow("workspace is not a git repository");
      expect(adapter.requests).toHaveLength(0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes the original request directly to exactly one adapter run", async () => {
    const adapter = new SingleMockAdapter();
    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath,
      prompt: "make the smallest valid change",
      registry: createRegistry([adapter]),
      model: "gpt-requested",
      reasoningLevel: "medium",
      comparisonId: "direct-case",
    });

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({
      role: "implementer",
      prompt: "make the smallest valid change",
      cwd: repoPath,
      permission: "workspace-write",
      model: "gpt-requested",
      reasoningLevel: "medium",
      metadata: { executionMode: "single" },
    });
    expect(adapter.requests[0]?.prompt).not.toContain("PLAN RULES");

    expect(report).toMatchObject({
      mode: "single",
      primaryAgentId: "codex",
      repoPath,
      result: {
        status: "completed",
        summary: "Implemented and verified directly.",
        requestedModel: "gpt-requested",
        actualModel: "gpt-actual",
        requestedReasoningLevel: "medium",
        actualReasoningLevel: "high",
        usage: { inputTokens: 10, outputTokens: 5 },
        sessionId: "session-1",
      },
      verification: { status: "passed", reasons: [] },
      workspace: { dirtyBefore: [] },
    });
    expect(report.result.filesChanged).toContain("DIRECT.txt");
    expect(report.result.tests.at(-1)).toMatchObject({
      command: "pnpm test",
      exitCode: 0,
    });
    await expect(fs.access(path.join(repoPath, ".bremio", "worktrees"))).rejects.toThrow();
    await expect(fs.access(path.join(report.runDir, "report.json"))).resolves.toBeUndefined();

    const entries = (await readLedger(ledgerPathFor(repoPath))).filter(
      (entry) => entry.runId === report.runId,
    );
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.scope === "task")).toMatchObject({
      provider: "codex",
      role: "implementer",
      flowMode: "single-agent",
      comparisonId: "direct-case",
      actualModel: "gpt-actual",
    });
    expect(entries.find((entry) => entry.scope === "run")).toMatchObject({
      provider: "bremio",
      flowMode: "single-agent",
      outcomeVerified: true,
    });
    expect(entries.some((entry) => entry.scope === "coordination")).toBe(false);
  });

  it("warns about pre-existing dirty files and does not fake verification", async () => {
    await fs.writeFile(path.join(repoPath, "README.md"), "# dirty\n", "utf8");
    await fs.writeFile(path.join(repoPath, "dirty name.txt"), "pre-existing\n", "utf8");
    const adapter = new SingleMockAdapter(false);
    let observedDirty: readonly string[] = [];

    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath,
      prompt: "edit directly",
      registry: createRegistry([adapter]),
      hooks: { onWorkspaceReady: (files) => { observedDirty = files; } },
    });

    expect(observedDirty).toContain("README.md");
    expect(observedDirty).toContain("dirty name.txt");
    expect(report.workspace.dirtyBefore).toContain("README.md");
    expect(report.result.status).toBe("completed");
    expect(report.verification).toEqual({
      status: "unverified",
      reasons: ["agent completed without recognizable test, lint, build, or check evidence"],
    });
    const summary = (await readLedger(ledgerPathFor(repoPath))).find(
      (entry) => entry.runId === report.runId && entry.scope === "run",
    );
    expect(summary?.outcomeVerified).toBe(false);
    expect(summary?.qualityGatePassed).toBeUndefined();
  });

  it("propagates a hard timeout to the selected adapter", async () => {
    const adapter = new SlowSingleMockAdapter();

    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath,
      prompt: "run slowly",
      registry: createRegistry([adapter]),
      timeoutMs: 20,
    });

    expect(report.result.status).toBe("cancelled");
    expect(report.result.error).toBe("single-agent run timed out after 20ms");
    expect(report.verification.status).toBe("failed");
    expect(adapter.cancelledRuns).toEqual([report.runId]);
  });

  it("uses the final recognized verification retry as authoritative evidence", async () => {
    const adapter = new RetryingVerificationAdapter();

    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath,
      prompt: "verify with a Windows command wrapper",
      registry: createRegistry([adapter]),
    });

    expect(report.result.tests.map((test) => test.exitCode)).toEqual([1, 0]);
    expect(report.verification).toEqual({ status: "passed", reasons: [] });
  });

  it("runs a follow-up turn in Single mode seeing prior turns and recorded mechanism decision", async () => {
    const adapter = new SingleMockAdapter();
    const registry = createRegistry([adapter]);

    const turn0 = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath,
      prompt: "Create initial structure",
      registry,
    });

    expect(turn0.result.status).toBe("completed");

    const turn1 = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath,
      prompt: "Add error handling to initial structure",
      registry,
      sessionId: turn0.runId,
      turnIndex: 1,
      priorTurns: [
        {
          turnIndex: 0,
          prompt: turn0.prompt,
          finalText: turn0.result.summary,
        },
      ],
      providerSessionId: turn0.result.sessionId,
    });

    expect(turn1.result.status).toBe("completed");
    expect(turn1.turnIndex).toBe(1);
    expect(turn1.mechanismDecision?.mechanism).toBe("resume");
    expect(turn1.mechanismDecision?.reason).toContain("resumableSessions is true");
  });

  // ── Safety fixtures (docs/15 §6) ─────────────────────────────────────
  it("ignored-file write: detects changes to gitignored files via --ignored flag", async () => {
    await fs.writeFile(path.join(repoPath, ".gitignore"), "*.log\n", "utf8");
    git(["add", ".gitignore"]);
    git(["commit", "-q", "-m", "add gitignore"]);

    const adapter = new SingleMockAdapter();
    // Override startRun to write a gitignored file
    const origStart = adapter.startRun.bind(adapter);
    adapter.startRun = async function* (request: AgentRunRequest) {
      this.requests.push(request);
      yield { type: "started", runId: request.runId, ts: Date.now() };
      await fs.writeFile(path.join(request.cwd, "agent.log"), "ignored output\n", "utf8");
      yield { type: "completed", runId: request.runId, ts: Date.now(), outcome: { status: "completed", finalText: "done" } };
    };

    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath,
      prompt: "write a log file",
      registry: createRegistry([adapter]),
    });

    expect(report.result.filesChanged).toContain("agent.log");
    expect(report.workspace.dirtyAfter).toContain("agent.log");
  });

  it("outside-workspace sentinel: an agent that writes outside the repo is not detected by Bremio's own reporting", async () => {
    // This fixture documents a *limitation*, deliberately.
    //
    // Its previous form created a sentinel outside the repo, never told the
    // adapter where it was, and asserted the sentinel was unchanged. The
    // adapter could not have written there even in principle, so the test
    // passed with the plan-mode gate removed entirely — a green light that
    // proved nothing, which is worse than no fixture at all.
    //
    // What is actually true: Bremio does not sandbox the filesystem. Keeping an
    // agent inside the workspace is the provider's sandbox (`codex --sandbox`,
    // `agy --mode plan`), and `captureWorkspaceState` only ever looks inside
    // repoPath. So a write outside it is invisible to Bremio's reporting. That
    // residual risk is pinned here rather than papered over, per docs/15 §6
    // ("known limitations documented").
    const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-sentinel-"));
    const sentinelFile = path.join(sentinelDir, "sentinel.txt");
    await fs.writeFile(sentinelFile, "pristine\n", "utf8");

    try {
      const adapter = new SingleMockAdapter();
      const origStart = adapter.startRun.bind(adapter);
      adapter.startRun = async function* (request: AgentRunRequest) {
        this.requests.push(request);
        yield { type: "started", runId: request.runId, ts: Date.now() };
        // An unsandboxed adapter really can reach outside the workspace.
        await fs.writeFile(sentinelFile, "tampered\n", "utf8");
        yield {
          type: "completed",
          runId: request.runId,
          ts: Date.now(),
          outcome: { status: "completed", finalText: "done" },
        };
      };
      void origStart;

      const report = await runSingleAgent({
        primaryAgentId: "codex",
        repoPath,
        prompt: "plan mode task",
        registry: createRegistry([adapter]),
        controlMode: "plan",
      });

      // The write really happened — so this fixture is not vacuous.
      expect(await fs.readFile(sentinelFile, "utf8")).toBe("tampered\n");

      // And Bremio saw none of it. If this assertion ever starts failing,
      // Bremio has gained outside-workspace detection and this fixture should
      // become a real containment test rather than a limitation record.
      expect(report.result.filesChanged).not.toContain(sentinelFile);
      expect(report.workspace.dirtyAfter).not.toContain(sentinelFile);
    } finally {
      await fs.rm(sentinelDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("home-dir sentinel: adapter that cannot back plan mode is rejected, home dir unchanged", async () => {
    const homeSentinel = path.join(os.homedir(), ".bremio-safety-test");
    await fs.writeFile(homeSentinel, "pristine\n", "utf8");

    try {
      // Adapter with advisory readOnlyEnforcement — cannot back plan mode
      const weakAdapter = new SingleMockAdapter();
      const origCaps = weakAdapter.getCapabilities.bind(weakAdapter);
      weakAdapter.getCapabilities = async () => ({
        ...(await origCaps()),
        readOnlyEnforcement: "advisory",
      });

      await expect(runSingleAgent({
        primaryAgentId: "codex",
        repoPath,
        prompt: "plan mode task with weak adapter",
        registry: createRegistry([weakAdapter]),
        controlMode: "plan",
      })).rejects.toThrow("cannot run in plan mode");

      // Home sentinel must be unchanged
      const content = await fs.readFile(homeSentinel, "utf8");
      expect(content).toBe("pristine\n");
    } finally {
      await fs.rm(homeSentinel, { force: true }).catch(() => {});
    }
  });

  it("runs a Single agent in an isolated worktree when workspaceStrategy is isolated-worktree", async () => {
    const adapter = new SingleMockAdapter();
    const registry = createRegistry([adapter]);

    const report = await runSingleAgent({
      primaryAgentId: "codex",
      repoPath,
      prompt: "isolated edit",
      registry,
      workspaceStrategy: "isolated-worktree",
    });

    expect(report.result.status).toBe("completed");
    expect(report.workspaceStrategy).toBe("isolated-worktree");
    expect(report.worktree).toBeDefined();
    expect(report.worktree?.branch).toMatch(/^bremio\/SOLO-codex/);
    expect(report.result.filesChanged).toContain("DIRECT.txt");

    // Main workspace remains clean because the edit landed in the isolated worktree
    await expect(fs.access(path.join(repoPath, "DIRECT.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(report.worktree!.path, "DIRECT.txt"))).resolves.toBeUndefined();
  });
});
