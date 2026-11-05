import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AdapterRuntimeCapabilities,
  AgentAdapter,
  AgentCapabilities,
  AgentHealth,
  AgentRunRequest,
  ModelDescriptor,
} from "@bremio/adapter-sdk";
import { createRegistry, readLedger } from "@bremio/orchestrator";
import type { AgentEvent } from "@bremio/protocol";
import { listFiles, loadCases } from "./cases";
import { benchResultPath, runBench } from "./runner";
import { BenchRunResultSchema, HIDDEN_DIR, type LoadedCase } from "./schema";

const CASES_DIR = fileURLToPath(new URL("../../../bench/cases", import.meta.url));

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

/** What the fake agent could see while it ran — the guard under test. */
interface Observation {
  cwd: string;
  sawHiddenDir: boolean;
  sawHiddenFile: string[];
  promptMentionsHidden: boolean;
}

/**
 * A provider stand-in. `behaviour` decides what it does to the workspace;
 * every run records what was visible so a test can prove hidden verification
 * never reached the agent.
 */
class FakeAgent implements AgentAdapter {
  readonly provider = "fake";
  readonly observations: Observation[] = [];
  constructor(
    readonly id: string,
    private readonly benchCase: LoadedCase,
    private readonly behaviour: "solve" | "noop" | "plant",
    private readonly costUsd: number | null = 0.02,
  ) {}
  async healthCheck(): Promise<AgentHealth> {
    return { status: "ok" };
  }
  async getCapabilities(): Promise<AgentCapabilities> {
    return CAPS;
  }
  async getRuntimeCapabilities(): Promise<AdapterRuntimeCapabilities> {
    return {
      adapterId: this.id,
      transport: "cli",
      approval: "none",
      structuredToolEvents: false,
      contextMetrics: "none",
      manualCompact: false,
      mcp: false,
      webSearch: false,
      cancellation: false,
    };
  }
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }
  resumeRun(): AsyncIterable<AgentEvent> {
    throw new Error("not supported");
  }
  async cancelRun(): Promise<void> {}

  protected async observe(req: AgentRunRequest): Promise<void> {
    const hiddenFiles = await listFiles(this.benchCase.hiddenDir);
    this.observations.push({
      cwd: req.cwd,
      sawHiddenDir: existsSync(path.join(req.cwd, HIDDEN_DIR)),
      sawHiddenFile: hiddenFiles.filter((f) => existsSync(path.join(req.cwd, f))),
      promptMentionsHidden: req.prompt.includes(HIDDEN_DIR) || req.prompt.includes(this.benchCase.hiddenDir),
    });
  }

  protected async act(cwd: string): Promise<void> {
    if (this.behaviour === "solve") {
      await fs.cp(this.benchCase.solutionDir, cwd, { recursive: true, force: true });
    } else if (this.behaviour === "plant") {
      // Try to game verification by writing a passing "hidden" test.
      const hiddenFiles = await listFiles(this.benchCase.hiddenDir);
      for (const rel of hiddenFiles) {
        await fs.mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
        await fs.writeFile(path.join(cwd, rel), 'import { test } from "node:test"; test("ok", () => {});\n');
      }
    }
  }

  protected usage(runId: string): AgentEvent {
    return {
      type: "usage",
      runId,
      ts: Date.now(),
      inputTokens: 100,
      outputTokens: 20,
      ...(this.costUsd !== null ? { costUsd: this.costUsd } : {}),
    };
  }

  async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "started", runId: req.runId, ts: Date.now() };
    await this.observe(req);
    await this.act(req.cwd);
    yield this.usage(req.runId);
    yield { type: "completed", runId: req.runId, ts: Date.now(), outcome: { status: "completed", finalText: "done" } };
  }
}

/** Team lead: plans implementation → test → review and reviews independently. */
class FakeLead extends FakeAgent {
  override async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    yield { type: "started", runId: req.runId, ts };
    await this.observe(req);
    yield this.usage(req.runId);
    if (req.prompt.includes("PLAN RULES")) {
      const plan = {
        summary: "Fix the case",
        leadAgentId: this.id,
        tasks: [
          {
            id: "TASK-001",
            title: "Implement the fix",
            kind: "implementation",
            risk: "low",
            requiredCapabilities: ["repository.read", "repository.write"],
            preferredAgents: [],
            dependencies: [],
            acceptanceCriteria: ["the requested behaviour works"],
          },
          {
            id: "TASK-002",
            title: "Run the tests",
            kind: "test",
            risk: "low",
            requiredCapabilities: ["repository.read", "shell", "test"],
            preferredAgents: [],
            dependencies: ["TASK-001"],
            acceptanceCriteria: ["tests pass"],
          },
          {
            id: "TASK-003",
            title: "Review the change",
            kind: "review",
            risk: "low",
            requiredCapabilities: ["repository.read", "review"],
            preferredAgents: [],
            dependencies: ["TASK-002"],
            acceptanceCriteria: ["no blockers"],
          },
        ],
      };
      yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: JSON.stringify(plan) } };
      return;
    }
    const review = { summary: "Looks right.", findings: [] };
    yield {
      type: "completed",
      runId: req.runId,
      ts,
      outcome: { status: "completed", finalText: JSON.stringify(review), structured: review },
    };
  }
}

/** Team worker: implements via the behaviour, and runs a passing test command. */
class FakeWorker extends FakeAgent {
  override async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    yield { type: "started", runId: req.runId, ts };
    await this.observe(req);
    if (req.role === "tester") {
      yield { type: "tool_use", runId: req.runId, ts, name: "shell", input: { command: "node --test" } };
      yield { type: "tool_result", runId: req.runId, ts, name: "shell", ok: true, exitCode: 0 };
    } else {
      await this.act(req.cwd);
    }
    yield this.usage(req.runId);
    yield { type: "completed", runId: req.runId, ts: Date.now(), outcome: { status: "completed", finalText: "done" } };
  }
}

let cases: LoadedCase[];
let root: string;
let rangeCase: LoadedCase;

beforeAll(async () => {
  cases = await loadCases(CASES_DIR);
  rangeCase = cases.find((c) => c.definition.id === "js-bugfix-range") as LoadedCase;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bremio-bench-runner-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function dirs(name: string): Promise<{ outputDir: string; workRoot: string }> {
  const base = await fs.mkdtemp(path.join(root, `${name}-`));
  return { outputDir: path.join(base, "out"), workRoot: path.join(base, "work") };
}

describe("runBench — single mode", () => {
  it("resolves a case when the agent applies the solution", async () => {
    const agent = new FakeAgent("fake", rangeCase, "solve", 0.02);
    const { outputDir, workRoot } = await dirs("solve");
    const result = await runBench({
      cases: [rangeCase],
      mode: "single",
      agentId: "fake",
      registry: createRegistry([agent]),
      outputDir,
      workRoot,
    });

    expect(result.summary).toMatchObject({ cases: 1, resolved: 1, resolveRate: 1, totalCostUsd: 0.02 });
    const [c] = result.cases;
    expect(c).toMatchObject({ caseId: "js-bugfix-range", resolved: true, runStatus: "completed", qualityGate: "n/a" });
    expect(c?.usage).toMatchObject({ entries: 1, entriesWithUsage: 1, inputTokens: 100, outputTokens: 20, costUsd: 0.02 });
    expect(c?.overBudget).toBe(false);
    // Resolved workdirs are cleaned up unless asked otherwise.
    expect(c?.workdir).toBeUndefined();

    // Persisted, and the file is the same schema-valid result.
    const stored = JSON.parse(await fs.readFile(benchResultPath(outputDir, result.benchRunId), "utf8"));
    expect(BenchRunResultSchema.parse(stored)).toEqual(result);
  });

  it("fails a case when the agent changes nothing, and keeps the workdir", async () => {
    const agent = new FakeAgent("fake", rangeCase, "noop");
    const { outputDir, workRoot } = await dirs("noop");
    const result = await runBench({
      cases: [rangeCase],
      mode: "single",
      agentId: "fake",
      registry: createRegistry([agent]),
      outputDir,
      workRoot,
    });
    const [c] = result.cases;
    expect(c?.resolved).toBe(false);
    expect(c?.runStatus).toBe("completed"); // Bremio's view and the bench's view differ
    expect(c?.verification.ok).toBe(false);
    expect(c?.verification.commands[0]?.exitCode).not.toBe(0);
    expect(c?.workdir && existsSync(c.workdir)).toBe(true);
    expect(result.summary.resolveRate).toBe(0);
  });

  it("never shows the agent hidden verification", async () => {
    const agent = new FakeAgent("fake", rangeCase, "solve");
    const { outputDir, workRoot } = await dirs("hidden");
    await runBench({
      cases: [rangeCase],
      mode: "single",
      agentId: "fake",
      registry: createRegistry([agent]),
      outputDir,
      workRoot,
    });
    expect(agent.observations).toHaveLength(1);
    expect(agent.observations[0]).toMatchObject({
      sawHiddenDir: false,
      sawHiddenFile: [],
      promptMentionsHidden: false,
    });
  });

  it("discards a planted 'hidden' test instead of running it", async () => {
    const agent = new FakeAgent("fake", rangeCase, "plant");
    const { outputDir, workRoot } = await dirs("plant");
    const result = await runBench({
      cases: [rangeCase],
      mode: "single",
      agentId: "fake",
      registry: createRegistry([agent]),
      outputDir,
      workRoot,
    });
    expect(result.cases[0]?.resolved).toBe(false);
  });

  it("keeps cost unknown when the provider reports none", async () => {
    const agent = new FakeAgent("fake", rangeCase, "solve", null);
    const { outputDir, workRoot } = await dirs("nocost");
    const result = await runBench({
      cases: [rangeCase],
      mode: "single",
      agentId: "fake",
      registry: createRegistry([agent]),
      outputDir,
      workRoot,
    });
    expect(result.cases[0]?.usage.costUsd).toBeNull();
    expect(result.cases[0]?.overBudget).toBeNull();
    expect(result.summary.totalCostUsd).toBeNull();
    expect(result.summary.casesWithKnownCost).toBe(0);
  });

  it("appends one bench-scoped ledger line per case", async () => {
    const agent = new FakeAgent("fake", rangeCase, "solve", 0.02);
    const { outputDir, workRoot } = await dirs("ledger");
    const ledgerPath = path.join(outputDir, "..", "ledger.jsonl");
    const result = await runBench({
      cases: [rangeCase],
      mode: "single",
      agentId: "fake",
      registry: createRegistry([agent]),
      outputDir,
      workRoot,
      ledgerPath,
    });
    const entries = await readLedger(ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      scope: "bench",
      runId: result.benchRunId,
      taskId: `${result.benchRunId}::js-bugfix-range`,
      provider: "fake",
      kind: "bug-fix",
      flowMode: "single-agent",
      outcomeVerified: true,
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.02 },
    });
  });

  it("refuses an unregistered agent before touching any case", async () => {
    const { outputDir, workRoot } = await dirs("unknown");
    await expect(runBench({
      cases: [rangeCase],
      mode: "single",
      agentId: "ghost",
      registry: createRegistry([]),
      outputDir,
      workRoot,
    })).rejects.toThrow(/"ghost" is not registered/);
    expect(existsSync(outputDir)).toBe(false);
  });
});

describe("runBench — team mode", () => {
  it("integrates a passed run's branches and verifies the merged result", async () => {
    const lead = new FakeLead("lead", rangeCase, "noop");
    const worker = new FakeWorker("worker", rangeCase, "solve");
    const { outputDir, workRoot } = await dirs("team");
    const result = await runBench({
      cases: [rangeCase],
      mode: "team",
      leadId: "lead",
      workerIds: ["worker"],
      registry: createRegistry([lead, worker]),
      outputDir,
      workRoot,
      keepAll: true,
    });
    const [c] = result.cases;
    expect(c?.error).toBeUndefined();
    expect(c?.qualityGate).toBe("passed");
    expect(c?.integration?.merged).toEqual(["bremio/TASK-001-worker"]);
    expect(c?.integration?.error).toBeUndefined();
    expect(c?.resolved).toBe(true);
    // Planning (coordination) and every task count against the Team side.
    expect(c?.usage.entries).toBeGreaterThanOrEqual(4);
    expect(c?.usage.costUsd).not.toBeNull();
    expect(result.summary.gatePassRate).toBe(1);
    for (const o of [...lead.observations, ...worker.observations]) {
      expect(o.sawHiddenDir).toBe(false);
      expect(o.sawHiddenFile).toEqual([]);
    }
  }, 60_000);

  it("does not integrate when the gate fails, and the case fails", async () => {
    const lead = new FakeLead("lead", rangeCase, "noop");
    // A tester whose verification command fails turns the gate red.
    class FailingTester extends FakeWorker {
      override async *startRun(req: AgentRunRequest): AsyncIterable<AgentEvent> {
        const ts = Date.now();
        yield { type: "started", runId: req.runId, ts };
        if (req.role === "tester") {
          yield { type: "tool_use", runId: req.runId, ts, name: "shell", input: { command: "node --test" } };
          yield { type: "tool_result", runId: req.runId, ts, name: "shell", ok: false, exitCode: 1 };
        }
        yield { type: "completed", runId: req.runId, ts, outcome: { status: "completed", finalText: "done" } };
      }
    }
    const worker = new FailingTester("worker", rangeCase, "noop");
    const { outputDir, workRoot } = await dirs("team-red");
    const result = await runBench({
      cases: [rangeCase],
      mode: "team",
      leadId: "lead",
      workerIds: ["worker"],
      registry: createRegistry([lead, worker]),
      outputDir,
      workRoot,
    });
    const [c] = result.cases;
    expect(c?.qualityGate).toBe("failed");
    expect(c?.integration).toBeUndefined();
    expect(c?.resolved).toBe(false);
    expect(result.summary.gatePassRate).toBe(0);
  }, 60_000);
});
